// Ports and secrets shared by playwright.config.ts and the tests (test-only values).
export const PORT = Number(process.env.E2E_PORT ?? 18571);
/** The second server, with APP_PASSWORD set */
export const AUTH_PORT = PORT + 1;
/** e2e/media-server.ts */
export const MEDIA_PORT = PORT + 2;
export const E2E_PASSWORD = "e2e-instance-password";
