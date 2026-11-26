import { expect } from "@playwright/test";
import {
  LONG,
  MEDIA,
  createRoom,
  expectMedia,
  focusPlayer,
  playing,
  seekBarTo,
  test,
} from "./helpers.ts";

test("a viewer who is buffering pauses the room until they're ready", async ({
  join,
  baseURL,
}, testInfo) => {
  const room = await createRoom(baseURL!, LONG);
  const a = await join(room, "A");
  // B's browser only gets the first 40 KB of the video (~2:30 of long.webm) until the test releases it
  // (e2e/media-server.ts), so a seek past that leaves B with nothing to play.
  const token = `stall-${testInfo.testId}-${testInfo.retry}`;
  const b = await join(room, "B", {
    extraHTTPHeaders: { "x-e2e-throttle": `${token}:40000` },
  });

  await focusPlayer(a.page);
  await a.page.keyboard.press("k");
  for (const v of [a, b]) {
    await expectMedia(v.page, playing(LONG), `${v.label} plays`);
  }

  // A seeks to 7:00: A plays on its own data, B waits for data → the room pauses for everyone
  await seekBarTo(a.page, 420);
  await expect(a.page.getByText(/^Waiting for /)).toBeVisible();
  await expectMedia(a.page, (m) => m.paused && m.time > 400, "A paused for B");
  await expectMedia(b.page, (m) => m.paused, "B paused too");

  // B's data arrives: once B has buffered the room plays again
  await fetch(`${MEDIA}/__release?token=${token}`);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => !m.paused && m.time > 415,
      `${v.label} resumed`,
      20_000,
    );
  }
  await expect(a.page.getByText(/^Waiting for /)).toHaveCount(0);
});
