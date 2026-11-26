import { expect, type Page } from "@playwright/test";
import {
  LONG,
  SHORT,
  createRoom,
  expectMedia,
  expectMediaStays,
  playUrl,
  playing,
  test,
} from "./helpers.ts";

async function setSkipIntro(page: Page, chip: string) {
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Room settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Room settings" });
  await dialog.getByText(chip, { exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test("skip intro starts long videos at 1:30 for everyone, Watch from start, short videos and Off", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await join(room, "A");
  const b = await join(room, "B");

  await setSkipIntro(a.page, "1:30");
  await expect(
    b.page.getByText(/set skip intro to 1:30/i).first(),
  ).toBeVisible();

  // A long video starts at ~1:30 for both, with the notice
  await playUrl(a.page, LONG);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => playing(LONG)(m) && m.time >= 89 && m.time < 100,
      `${v.label} starts at ~90 s`,
    );
    await expect(v.page.getByText("Skipped intro (1:30)")).toBeVisible();
  }

  // "Watch from start" on B sends everyone back to 0, and it stays there
  await b.page.getByRole("button", { name: "Watch from start" }).click();
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => m.time < 5,
      `${v.label} back at the start`,
    );
  }
  for (const v of [a, b]) {
    await expectMediaStays(
      v.page,
      (m) => m.time < 10,
      `${v.label} stays at the start`,
    );
    await expect(v.page.getByText("Skipped intro (1:30)")).toHaveCount(0);
  }

  // A short video (too short to skip) plays from 0 and doesn't get stuck paused
  await playUrl(a.page, SHORT);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => playing(SHORT)(m) && m.time > 1 && m.time < 15,
      `${v.label} plays the short video from the start`,
    );
  }
  for (const v of [a, b]) {
    await expectMediaStays(
      v.page,
      (m) => !m.paused && m.time < 20,
      `${v.label} keeps playing`,
      2000,
    );
  }

  // Off: a long video starts at 0
  await setSkipIntro(a.page, "Off");
  await expect(
    b.page.getByText(/turned off skip intro/i).first(),
  ).toBeVisible();
  await playUrl(a.page, `${LONG}?off`);
  for (const v of [a, b]) {
    await expectMedia(
      v.page,
      (m) => playing(`${LONG}?off`)(m) && m.time < 10,
      `${v.label} starts the long video at 0`,
    );
  }
  await expect(a.page.getByText("Skipped intro")).toHaveCount(0);
});
