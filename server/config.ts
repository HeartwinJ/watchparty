import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch {
  // No .env file, rely on the real environment
}

const defaults = {
  NODE_ENV: "", // Usually, you should let process.env.NODE_ENV override this ("development" enables dev CORS)
  PORT: 8080, // Port to use for server
  HOST: "0.0.0.0", // Host interface to bind server to
  SSL_KEY_FILE: "", // Optional, Filename of SSL key (to use https)
  SSL_CRT_FILE: "", // Optional, Filename of SSL cert (to use https)
  BUILD_DIRECTORY: "build", // Name of the directory where the built React UI is served from
  DATA_DIR: "./data", // Directory holding the SQLite database (watchparty.db)
  APP_PASSWORD: "", // Instance password. If blank, auth is disabled and anyone can use the instance
  SESSION_SECRET: "", // Secret used to sign session cookies. If blank, a random one is generated per process (sessions reset on restart)
  TRUST_PROXY: "loopback, linklocal, uniquelocal", // Express "trust proxy" setting, so req.ip/req.secure honor X-Forwarded-* from cloudflared
  CF_TURN_KEY_ID: "", // Optional, Cloudflare Realtime TURN key ID (enables TURN relay for voice calls and screen/file share; strongly recommended for calls)
  CF_TURN_API_TOKEN: "", // Optional, Cloudflare Realtime TURN API token. Server-side only, never sent to clients
  YOUTUBE_API_KEY: "", // Optional, provide one to enable searching YouTube
  OPENSUBTITLES_KEY: "", // Optional, API key of an OpenSubtitles.com API consumer (profile -> API Consumers)
  OPENSUBTITLES_USER_AGENT: "watchparty v1", // Sent as User-Agent to OpenSubtitles; use your API consumer's app name + version
  // Optional, AIOStreams manifest URL (https://host/stremio/<uuid>/<config>/manifest.json). Enables /addon/streams
  // (the other /addon/* routes use keyless public addons and work without it).
  // SECRET: it embeds the AIOStreams config and debrid credentials. Server-side only, never log/return/commit it.
  AIOSTREAMS_MANIFEST_URL: "",
  // Rooms nobody has been in for this many days are deleted (room + its watch history), checked at startup and daily.
  // 0 disables it.
  ROOM_MAX_IDLE_DAYS: 60,
  SUBTITLE_LANGS: "en", // Preferred subtitle languages for /addon/subtitles, ISO 639-1, comma-separated, e.g. "en,es"
};

export default {
  ...defaults,
  ...process.env,
};
