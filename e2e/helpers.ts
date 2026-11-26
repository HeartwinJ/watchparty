import {
  expect,
  test as base,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { MEDIA_PORT } from "./env.ts";

/** The fixture host (e2e/media-server.ts). long.webm = 10 min, short.webm = 60 s, both VP8. */
export const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;
export const LONG = `${MEDIA}/long.webm`;
export const SHORT = `${MEDIA}/short.webm`;

/** Creates a room through the API (everyone is an owner when APP_PASSWORD is blank). Returns "/<roomId>". */
export async function createRoom(baseURL: string, video?: string) {
  const res = await fetch(`${baseURL}/createRoom`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(video ? { video } : {}),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { name: string }).name;
}

export type Viewer = { page: Page; context: BrowserContext; label: string };

export type JoinOptions = BrowserContextOptions & {
  /** Runs in the page before any of its scripts */
  initScript?: () => void;
  /** Wait for the room page (false: e.g. a join screen is expected) */
  waitForRoom?: boolean;
};

/**
 * `test` with a `join(roomPath, label, options?)` fixture: a new browser context (a separate person) with the room
 * open and its socket connected (roomPath null: a blank page). Contexts are closed after the test.
 */
export const test = base.extend<{
  join: (
    roomPath: string | null,
    label: string,
    options?: JoinOptions,
  ) => Promise<Viewer>;
}>({
  join: async ({ browser, baseURL }, use) => {
    const contexts: BrowserContext[] = [];
    await use(
      async (
        roomPath,
        label,
        { initScript, waitForRoom: wait = true, ...options } = {},
      ) => {
        const context = await browser.newContext({
          baseURL,
          permissions: ["camera", "microphone"],
          ...options,
        });
        contexts.push(context);
        await noExternalIce(context);
        if (initScript) {
          await context.addInitScript(initScript);
        }
        const page = await context.newPage();
        page.on("pageerror", (e) =>
          console.log(`[${label}] pageerror: ${e.message}`),
        );
        if (roomPath === null) {
          return { page, context, label };
        }
        await page.goto(`/watch${roomPath}`);
        if (wait) {
          await waitForRoom(page);
        }
        return { page, context, label };
      },
    );
    await Promise.all(contexts.map((c) => c.close()));
  },
});

/** Calls need ICE servers; hand out an unreachable local STUN server so tests never contact Cloudflare. */
export async function noExternalIce(context: BrowserContext) {
  await context.route("**/iceServers", (route) =>
    route.fulfill({ json: [{ urls: "stun:127.0.0.1:9" }] }),
  );
}

/** The room page is up: the player is rendered and the chat input exists. */
export async function waitForRoom(page: Page) {
  await expect(page.locator("#leftVideo")).toBeAttached({ timeout: 20_000 });
  await expect(
    page.getByRole("textbox", { name: "Message" }).first(),
  ).toBeVisible();
}

export type MediaState = {
  src: string;
  time: number;
  duration: number;
  paused: boolean;
  rate: number;
  readyState: number;
};

export function media(page: Page): Promise<MediaState> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("#leftVideo");
    return {
      src: (v?.currentSrc ?? "").split("#")[0],
      time: v?.currentTime ?? -1,
      duration: v?.duration ?? NaN,
      paused: v?.paused ?? true,
      rate: v?.playbackRate ?? 1,
      readyState: v?.readyState ?? 0,
    };
  });
}

/** Waits until the player's state matches. */
export async function expectMedia(
  page: Page,
  check: (m: MediaState) => boolean,
  message: string,
  timeout = 15_000,
) {
  await expect
    .poll(
      async () => {
        const m = await media(page);
        return check(m) ? true : JSON.stringify(m);
      },
      { message, timeout },
    )
    .toBe(true);
}

/** Expects the condition to hold continuously for `ms` (e.g. a seek doesn't snap back). */
export async function expectMediaStays(
  page: Page,
  check: (m: MediaState) => boolean,
  message: string,
  ms = 4000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = await media(page);
    expect(check(m), `${message}: ${JSON.stringify(m)}`).toBe(true);
    await page.waitForTimeout(250);
  }
}

export const playing = (src: string) => (m: MediaState) =>
  m.src === src && !m.paused && m.readyState >= 2;

/** Plays a URL for the whole room through the source picker ("/", type, Enter). */
export async function playUrl(page: Page, url: string, { queue = false } = {}) {
  await focusPlayer(page);
  await page.keyboard.press("/");
  const input = page.getByRole("combobox", { name: "Search or paste a link" });
  await expect(input).toBeFocused();
  await input.fill(url);
  await page.keyboard.press(queue ? "Shift+Enter" : "Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Moves focus out of inputs so the player's keyboard shortcuts apply. */
export async function focusPlayer(page: Page) {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
}

/** Wakes the auto-hiding controls by moving the mouse over the player. */
export async function showControls(page: Page) {
  await dismissUnmute(page);
  const box = await page.locator("#leftVideo").boundingBox();
  if (!box) throw new Error("no video box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(
    box.x + box.width / 2 + 10,
    box.y + box.height / 2 + 10,
  );
}

export async function sendChat(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Message" }).first();
  await input.fill(text);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/**
 * Clicks the seek bar at `seconds` (a room-wide seek), like a person would: wake the controls, then click once the bar
 * is visible, still and actually under the pointer (Playwright's actionability checks retry until then).
 */
export async function seekBarTo(page: Page, seconds: number) {
  const { duration } = await media(page);
  await showControls(page);
  const bar = page.getByRole("slider", { name: "Seek" });
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveAttribute("aria-disabled", "true");
  const box = await bar.boundingBox();
  if (!box) throw new Error("no seek bar");
  await bar.click({
    position: { x: (box.width * seconds) / duration, y: box.height / 2 },
  });
}

/**
 * When the browser blocks autoplay with sound, the player shows an "Unmute" scrim over everything and the first click
 * only unmutes. Click it away first, as a person would.
 */
export async function dismissUnmute(page: Page) {
  const scrim = page.locator('[class*="_unmute_"]');
  if (await scrim.isVisible()) {
    await scrim.click();
    await expect(scrim).toHaveCount(0);
  }
}
