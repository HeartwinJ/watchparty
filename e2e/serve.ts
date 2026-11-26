// Starts the real server (serving build/) for the e2e tests, with a fresh data dir and
// every optional integration off, so nothing reaches an external service.
// Usage: node e2e/serve.ts <port> [appPassword]
import fs from "node:fs";
import path from "node:path";

const [port, password = ""] = process.argv.slice(2);
const root = path.join(import.meta.dirname, "..");
const dataDir = path.join(root, "e2e", ".data", port);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(path.join(root, "build", "index.html"))) {
  console.error("build/ is missing: run `npx vite build` first");
  process.exit(1);
}

Object.assign(process.env, {
  NODE_ENV: "production",
  PORT: port,
  HOST: "127.0.0.1",
  DATA_DIR: dataDir,
  APP_PASSWORD: password,
  SESSION_SECRET: password ? "e2e-session-secret" : "",
  AIOSTREAMS_MANIFEST_URL: "",
  YOUTUBE_API_KEY: "",
  OPENSUBTITLES_KEY: "",
  CF_TURN_KEY_ID: "",
  CF_TURN_API_TOKEN: "",
  ROOM_MAX_IDLE_DAYS: "0",
});
process.chdir(root);
await import("../server/server.ts");
