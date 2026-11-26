import { expect, type Page } from "@playwright/test";
import {
  LONG,
  SHORT,
  createRoom,
  expectMedia,
  playUrl,
  playing,
  showControls,
  test,
} from "./helpers.ts";

/** Seeks to the last second through the seek bar's End key, so the video ends. */
async function seekToEnd(page: Page) {
  await showControls(page);
  const bar = page.getByRole("slider", { name: "Seek" });
  await bar.focus();
  await bar.press("End");
}

test("the queue advances when a video ends, for everyone, with a now playing line", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await join(room, "A");
  const b = await join(room, "B");

  await playUrl(a.page, SHORT);
  await expectMedia(b.page, playing(SHORT), "B plays the first video");

  // Shift+Enter in the picker adds to the queue instead of playing
  const second = `${LONG}#wp-name=Second%20item`;
  const third = `${SHORT}?third#wp-name=Third%20item`;
  await playUrl(a.page, second, { queue: true });
  await playUrl(b.page, third, { queue: true });
  await a.page.getByRole("tab", { name: /Queue/ }).click();
  const upNext = a.page.getByRole("list", { name: "Up next" });
  await expect(upNext.getByRole("listitem")).toHaveCount(2);
  await expect(upNext).toContainText("Second item");
  await expect(upNext).toContainText("Third item");
  await expectMedia(a.page, playing(SHORT), "queueing didn't change the video");

  // The first video ends: everyone moves on to the second item
  await seekToEnd(b.page);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => playing(LONG)(m) && m.time < 10,
      `${v.label} plays item 2`,
    );
  }
  await expect(upNext.getByRole("listitem")).toHaveCount(1);
  await b.page.getByRole("tab", { name: /Chat/ }).click();
  await expect(
    b.page.getByText("Now playing Second item (from the queue)"),
  ).toBeVisible();

  // And again (after it has played a moment: the server ignores "ended" in the first second of a video)
  await expectMedia(
    a.page,
    (m) => m.time > 2,
    "A has played item 2 for a moment",
  );
  await seekToEnd(a.page);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => playing(`${SHORT}?third`)(m) && m.time < 10,
      `${v.label} plays item 3`,
    );
  }
  await expect(upNext.getByRole("listitem")).toHaveCount(0);
  await expect(
    b.page.getByText("Now playing Third item (from the queue)"),
  ).toBeVisible();
});
