import { expect } from "@playwright/test";
import {
  LONG,
  createRoom,
  expectMedia,
  expectMediaStays,
  focusPlayer,
  media,
  playUrl,
  playing,
  seekBarTo,
  showControls,
  test,
} from "./helpers.ts";

test("video changes, play/pause and seeks stay in sync; a late joiner lands on the room time", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await join(room, "A");
  const b = await join(room, "B");

  // A changes the video: both load it and play from the start
  await playUrl(a.page, LONG);
  for (const v of [a, b]) {
    await expectMedia(v.page, playing(LONG), `${v.label} plays the new video`);
  }
  await expect(
    b.page.getByText(/changed the video|is playing/i).first(),
  ).toBeVisible();

  // Pause from B's keyboard reaches A
  await focusPlayer(b.page);
  await b.page.keyboard.press("k");
  for (const v of [a, b]) {
    await expectMedia(v.page, (m) => m.paused, `${v.label} paused`);
  }
  // Play from A's control bar reaches B
  await showControls(a.page);
  await a.page.getByRole("button", { name: "Play", exact: true }).click();
  for (const v of [a, b]) {
    await expectMedia(v.page, (m) => !m.paused, `${v.label} playing again`);
  }

  // Keyboard seek (→ = +10 s) on B moves both, and nobody snaps back to the old position
  const before = (await media(a.page)).time;
  await focusPlayer(b.page);
  await b.page.keyboard.press("ArrowRight");
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => m.time >= before + 8,
      `${v.label} after →`,
    );
  }
  for (const v of [a, b]) {
    await expectMediaStays(
      v.page,
      (m) => m.time >= before + 8,
      `${v.label} keeps the seek`,
    );
  }

  // Seek bar click on A to 5:00
  await seekBarTo(a.page, 300);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => Math.abs(m.time - 300) < 10,
      `${v.label} at ~5:00`,
    );
  }
  for (const v of [a, b]) {
    await expectMediaStays(
      v.page,
      (m) => m.time > 290,
      `${v.label} keeps 5:00`,
    );
  }

  // A late joiner lands near the room time and plays
  const c = await join(room, "C");
  await expectMedia(c.page, playing(LONG), "C plays");
  const [ta, tc] = [(await media(a.page)).time, (await media(c.page)).time];
  expect(Math.abs(ta - tc), `A ${ta} vs C ${tc}`).toBeLessThan(3);
});

test("holding Space plays everyone at 2× and a tap still pauses", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await join(room, "A");
  const b = await join(room, "B");
  await playUrl(a.page, LONG);
  for (const v of [a, b]) {
    await expectMedia(v.page, playing(LONG), `${v.label} plays`);
  }

  await focusPlayer(a.page);
  await a.page.keyboard.down(" ");
  for (const v of [a, b]) {
    await expectMedia(v.page, (m) => m.rate >= 1.9, `${v.label} at 2×`);
  }
  await a.page.keyboard.up(" ");
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => !m.paused && m.rate < 1.1,
      `${v.label} back to 1× and still playing`,
    );
  }
  // The hold posts no chat lines about the speed
  await expect(b.page.getByText(/speed|playback rate/i)).toHaveCount(0);

  // A quick tap pauses everyone
  await a.page.keyboard.press(" ");
  for (const v of [a, b]) {
    await expectMedia(v.page, (m) => m.paused, `${v.label} paused`);
  }
});
