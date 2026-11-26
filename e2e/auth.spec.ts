import { expect, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "./env.ts";
import { test, waitForRoom } from "./helpers.ts";

// Runs against the server started with APP_PASSWORD set (the "auth" project).

async function ownerLogin(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Watch together." }),
  ).toBeVisible();
}

async function openPasswordSettings(page: Page) {
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Room settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Room settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function readRoomPassword(page: Page) {
  const dialog = await openPasswordSettings(page);
  if (await dialog.getByRole("button", { name: "Show password" }).isVisible()) {
    await dialog.getByRole("button", { name: "Show password" }).click();
  }
  const value = dialog.getByLabel("Room password", { exact: true });
  await expect(value).not.toContainText("•");
  const password = (await value.textContent())!.trim();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  return password;
}

test("owner login, guest joins with the room password, is kicked out by a new password and can't reach Home", async ({
  join,
}) => {
  const owner = await join(null, "Owner");
  await ownerLogin(owner.page);
  const res = await owner.page.request.post("/createRoom", { data: {} });
  expect(res.ok()).toBe(true);
  const room = ((await res.json()) as { name: string }).name;
  await owner.page.goto(`/watch${room}`);
  await waitForRoom(owner.page);
  const password = await readRoomPassword(owner.page);
  expect(password).toMatch(/\S{4,}/);

  // A guest gets the join screen; a wrong password is refused
  const guest = await join(room, "Guest", { waitForRoom: false });
  const field = guest.page.getByLabel("Room password");
  await expect(field).toBeVisible();
  await field.fill("not-the-password");
  await guest.page.getByRole("button", { name: "Join room" }).click();
  await expect(
    guest.page.getByText("Wrong password. Try again."),
  ).toBeVisible();

  // The right one lets them in
  await field.fill(password);
  await guest.page.getByRole("button", { name: "Join room" }).click();
  await waitForRoom(guest.page);
  await expect(
    owner.page.getByRole("tab", { name: /People\s*2/ }),
  ).toBeVisible();

  // Guests can't use Home: it asks for the instance password
  await guest.page.goto("/");
  await expect(
    guest.page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    guest.page.getByRole("heading", { name: "Watch together." }),
  ).toHaveCount(0);
  // ...but the room still works for them
  await guest.page.goto(`/watch${room}`);
  await waitForRoom(guest.page);

  // The owner regenerates the password: the guest is sent back to the join screen
  const dialog = await openPasswordSettings(owner.page);
  await dialog.getByRole("button", { name: "Regenerate" }).click();
  await expect(
    guest.page.getByText("The room password changed. Ask for the new one."),
  ).toBeVisible();
  await expect(guest.page.getByLabel("Room password")).toBeVisible();
  await expect(guest.page.locator("#leftVideo")).toHaveCount(0);

  // The old password no longer works
  await guest.page.getByLabel("Room password").fill(password);
  await guest.page.getByRole("button", { name: "Join room" }).click();
  await expect(
    guest.page.getByText("Wrong password. Try again."),
  ).toBeVisible();
});
