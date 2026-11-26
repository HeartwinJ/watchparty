import { defineConfig } from "@playwright/test";
import { AUTH_PORT, E2E_PASSWORD, MEDIA_PORT, PORT } from "./e2e/env.ts";

// End-to-end tests: the real server + built client (`npx vite build` first), driven by
// headless Chromium with several browser contexts per test. See "E2E tests" in CLAUDE.md.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"]],
  use: {
    // Full Chromium in the new headless mode (closest to the real browser; fullscreen, fake media devices)
    channel: "chromium",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  projects: [
    {
      name: "open",
      testIgnore: /auth\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${PORT}` },
    },
    {
      name: "auth",
      testMatch: /auth\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${AUTH_PORT}` },
    },
  ],
  webServer: [
    {
      command: `node e2e/serve.ts ${PORT}`,
      url: `http://127.0.0.1:${PORT}/ping`,
      reuseExistingServer: false,
    },
    {
      command: `node e2e/serve.ts ${AUTH_PORT} ${E2E_PASSWORD}`,
      url: `http://127.0.0.1:${AUTH_PORT}/ping`,
      reuseExistingServer: false,
    },
    {
      command: `node e2e/media-server.ts`,
      url: `http://127.0.0.1:${MEDIA_PORT}/ping`,
      env: { E2E_MEDIA_PORT: String(MEDIA_PORT) },
      reuseExistingServer: false,
    },
  ],
});
