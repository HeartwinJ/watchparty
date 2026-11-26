import { expect, type Page } from "@playwright/test";
import {
  SHORT,
  LONG,
  createRoom,
  expectMedia,
  focusPlayer,
  media,
  playing,
  sendChat,
  showControls,
  test,
} from "./helpers.ts";

const isFullscreen = (page: Page) =>
  page.evaluate(() => Boolean(document.fullscreenElement));

async function enterFullscreen(page: Page) {
  await expectMedia(page, (m) => m.readyState >= 2, "the video loaded");
  // Setup, not the thing under test: retry if the key press came before the player listened
  await expect(async () => {
    await focusPlayer(page);
    await page.keyboard.press("f");
    await expect.poll(() => isFullscreen(page), { timeout: 2000 }).toBe(true);
  }).toPass({ timeout: 10_000 });
  // The app has noticed too (its shortcuts depend on it): the control bar offers to exit
  await expect(
    page.getByRole("button", { name: "Exit fullscreen" }).first(),
  ).toBeAttached();
}

test("chat messages reach everyone", async ({ join, baseURL }) => {
  const room = await createRoom(baseURL!);
  const a = await join(room, "A");
  const b = await join(room, "B");
  await sendChat(a.page, "hello from A");
  await sendChat(b.page, "hi from B");
  for (const v of [a, b]) {
    const log = v.page.getByRole("log", { name: "Chat messages" }).first();
    await expect(log).toContainText("hello from A");
    await expect(log).toContainText("hi from B");
  }
});

test("fullscreen chat panel: unread badge, Shift+C, typing isn't a shortcut, emoji picker", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!, LONG);
  const a = await join(room, "A");
  const b = await join(room, "B");
  await expectMedia(
    a.page,
    (m) => m.src === LONG && m.readyState >= 2,
    "A loaded the video",
  );
  await focusPlayer(a.page);
  await a.page.keyboard.press("k");
  await expectMedia(a.page, playing(LONG), "A plays");

  await enterFullscreen(a.page);
  const chatButton = a.page.locator('button[aria-pressed][title*="Shift + c"]');
  await showControls(a.page);
  await expect(chatButton).toHaveAttribute("aria-pressed", "false");

  // B's messages count as unread on A's collapsed panel button
  await sendChat(b.page, "first from B");
  await sendChat(b.page, "second from B");
  await showControls(a.page);
  await expect(chatButton).toHaveAttribute(
    "aria-label",
    "Show chat (2 unread)",
  );

  // Shift+C opens the panel inside the fullscreen element, with the history and a focused input
  await focusPlayer(a.page);
  await a.page.keyboard.press("Shift+C");
  const panel = a.page.locator('section[aria-label="Chat"]');
  await expect(panel).toHaveAttribute("data-open", "true");
  expect(
    await a.page.evaluate(() =>
      Boolean(
        document.fullscreenElement?.contains(
          document.querySelector('section[aria-label="Chat"]'),
        ),
      ),
    ),
  ).toBe(true);
  await expect(panel).toContainText("first from B");
  await expect(panel).toContainText("second from B");
  await expect(panel.getByRole("textbox", { name: "Message" })).toBeFocused();

  // Typing k/m/f in the panel doesn't pause, mute or leave fullscreen
  await a.page.keyboard.type("kmf from A");
  await a.page.keyboard.press("Enter");
  await expect(
    b.page.getByRole("log", { name: "Chat messages" }).first(),
  ).toContainText("kmf from A");
  const m = await media(a.page);
  expect(m.paused).toBe(false);
  expect(
    await a.page.evaluate(
      () => document.querySelector<HTMLVideoElement>("#leftVideo")!.muted,
    ),
  ).toBe(false);
  expect(await isFullscreen(a.page)).toBe(true);

  // The emoji picker renders inside the fullscreen element (anything in <body> would be invisible)
  await panel.getByRole("button", { name: "Insert emoji" }).click();
  const picker = a.page.locator("em-emoji-picker");
  await expect(picker).toBeVisible();
  expect(
    await a.page.evaluate(() =>
      Boolean(
        document.fullscreenElement?.contains(
          document.querySelector("em-emoji-picker"),
        ),
      ),
    ),
  ).toBe(true);
});

test("Esc closes the chat panel's emoji picker before the panel", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!, SHORT);
  const a = await join(room, "A");
  // With the sidebar collapsed the panel is offered outside fullscreen too
  await a.page.getByRole("button", { name: "Hide sidebar" }).click();
  await focusPlayer(a.page);
  await a.page.keyboard.press("Shift+C");
  const panel = a.page.locator('section[aria-label="Chat"]');
  await expect(panel).toHaveAttribute("data-open", "true");
  await panel.getByRole("button", { name: "Insert emoji" }).click();
  await expect(a.page.locator("em-emoji-picker")).toBeVisible();
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator("em-emoji-picker")).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-open", "true");
  await a.page.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("data-open", "true");
});

test("quick chat (c) closes by itself after 5 s empty, not while there's text", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!, SHORT);
  const a = await join(room, "A");
  await enterFullscreen(a.page);
  const quick = a.page.getByRole("textbox", { name: "Message everyone" });

  await a.page.keyboard.press("c");
  await expect(quick).toBeFocused();
  const opened = Date.now();
  await expect(quick).toHaveCount(0, { timeout: 8000 });
  expect(Date.now() - opened).toBeGreaterThan(4000);

  await a.page.keyboard.press("c");
  await expect(quick).toBeFocused();
  await a.page.keyboard.type("hello");
  await a.page.waitForTimeout(6000); // longer than the idle timeout: text keeps it open
  await expect(quick).toBeVisible();
  for (let i = 0; i < 5; i++) await a.page.keyboard.press("Backspace");
  const cleared = Date.now();
  await expect(quick).toHaveCount(0, { timeout: 8000 });
  expect(Date.now() - cleared).toBeGreaterThan(4000);
  expect(await isFullscreen(a.page)).toBe(true);
});
