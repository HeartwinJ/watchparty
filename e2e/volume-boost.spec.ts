import { expect, type Page } from "@playwright/test";
import {
  LONG,
  createRoom,
  expectMedia,
  media,
  playUrl,
  playing,
  showControls,
  test,
} from "./helpers.ts";

// Counts how often the page routes a media element into Web Audio (createMediaElementSource is permanent, so it must
// only happen once, and only for a source Web Audio can read).
function countBinds() {
  const proto = AudioContext.prototype;
  const original = proto.createMediaElementSource;
  proto.createMediaElementSource = function (el) {
    const w = window as unknown as { __boostBinds?: number };
    w.__boostBinds = (w.__boostBinds ?? 0) + 1;
    return original.call(this, el);
  };
}

const binds = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __boostBinds?: number }).__boostBinds ?? 0,
  );

async function openAudioMenu(page: Page) {
  await showControls(page);
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  return page.getByRole("dialog", { name: "Audio", exact: true });
}

const badge = (page: Page) => page.locator('[class*="_boostBadge_"]');

test("volume boost and Night mode: on mid-video, then a link whose server doesn't allow it", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await join(room, "A", { initScript: countBinds });
  await playUrl(a.page, LONG);
  await expectMedia(
    a.page,
    (m) => playing(LONG)(m) && m.time > 1,
    "A plays the video",
  );

  // Turning it on mid-video reloads the (CORS-friendly) link in CORS mode where it was, then boosts it
  const before = (await media(a.page)).time;
  const menu = await openAudioMenu(a.page);
  await menu
    .getByRole("group", { name: "Boost" })
    .getByRole("button", { name: "200%" })
    .click();
  await expect(badge(a.page)).toHaveText("200%");
  await expect(a.page.locator("#leftVideo")).toHaveAttribute(
    "crossorigin",
    "anonymous",
  );
  expect(await binds(a.page)).toBe(1);
  await expectMedia(
    a.page,
    (m) => playing(LONG)(m) && m.time > before + 1,
    "A keeps playing from where it was",
  );

  await menu
    .getByRole("group", { name: "Night mode" })
    .getByRole("button", { name: "On" })
    .click();
  await expect(badge(a.page)).toHaveText("200% · Night");
  expect(await binds(a.page)).toBe(1);

  // A link without CORS can't play through the boost: the page reloads and plays it normally
  const noCors = `${LONG}?nocors`;
  await a.page.keyboard.press("Escape");
  await playUrl(a.page, noCors);
  await expect(a.page.getByText(/Reloaded to play this video/)).toBeVisible();
  await expectMedia(
    a.page,
    (m) => playing(noCors)(m) && m.time > 1,
    "A plays the link after the reload",
  );
  expect(await binds(a.page)).toBe(0);
  await expect(a.page.locator("#leftVideo")).not.toHaveAttribute(
    "crossorigin",
    /.*/,
  );
  await expect(badge(a.page)).toHaveCount(0);
  // The setting is kept on this device, with a note for this video
  const again = await openAudioMenu(a.page);
  await expect(
    again
      .getByRole("group", { name: "Boost" })
      .getByRole("button", { name: "200%" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(again.getByRole("status")).toHaveText(/Not available/);
});

test("a saved boost applies to the next video; without it nothing changes", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await join(room, "A", {
    initScript: () => {
      localStorage.setItem("wp-volume-boost", "1.5");
      const proto = AudioContext.prototype;
      const original = proto.createMediaElementSource;
      proto.createMediaElementSource = function (el) {
        const w = window as unknown as { __boostBinds?: number };
        w.__boostBinds = (w.__boostBinds ?? 0) + 1;
        return original.call(this, el);
      };
    },
  });
  const b = await join(room, "B", { initScript: countBinds });
  await playUrl(a.page, LONG);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => playing(LONG)(m) && m.time > 1,
      `${v.label} plays`,
    );
  }
  // A loads it in CORS mode straight away and boosts it
  await expect(a.page.locator("#leftVideo")).toHaveAttribute(
    "crossorigin",
    "anonymous",
  );
  await expect(badge(a.page)).toHaveText("150%");
  expect(await binds(a.page)).toBe(1);
  // B never turned it on: the element loads as it always has
  await expect(b.page.locator("#leftVideo")).not.toHaveAttribute(
    "crossorigin",
    /.*/,
  );
  expect(await binds(b.page)).toBe(0);
});
