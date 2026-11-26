import config from "./config.ts";
import fs from "node:fs";
import express from "express";
import compression from "compression";
import cors from "cors";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { Server } from "socket.io";
import { searchYoutube, youtubePlaylist } from "./utils/youtube.ts";
import { Room } from "./room.ts";
import {
  getRoom,
  getSubtitle,
  insertRoom,
  openDatabase,
  pruneSubtitles,
  saveSubtitle,
} from "./utils/db.ts";
import { makeRoomName, makeUserName } from "./utils/moniker.ts";
import { assertPublicUrl, safeFetch } from "./utils/ssrf.ts";
import { createAuth } from "./utils/auth.ts";
import { createIceServerProvider } from "./utils/iceServers.ts";
import { createAddonRouter } from "./addons/routes.ts";
import { createHistoryRouter } from "./utils/historyRoutes.ts";
import {
  openSubtitlesError,
  openSubtitlesHeaders,
} from "./utils/opensubtitles.ts";

// Last-resort safety net: a stray rejected promise shouldn't take down every room.
// Socket handlers are individually guarded in room.ts, this catches anything we missed.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const isDev = config.NODE_ENV === "development";
const SUBTITLE_TTL_MS = 24 * 60 * 60 * 1000;
const ROOM_IDLE_UNLOAD_MS = 8 * 60 * 60 * 1000;

const db = openDatabase(path.resolve(config.DATA_DIR, "watchparty.db"));

if (!config.APP_PASSWORD) {
  console.warn(
    "[auth] APP_PASSWORD is not set: authentication is DISABLED and anyone who can reach this server can use it",
  );
}
if (config.APP_PASSWORD && !config.SESSION_SECRET) {
  console.warn(
    "[auth] SESSION_SECRET is not set: using a random secret, so sessions reset when the server restarts",
  );
}
const auth = createAuth({
  password: config.APP_PASSWORD,
  sessionSecret: config.SESSION_SECRET,
});
const requireAuth = auth.requireAuth;
const iceServers = createIceServerProvider({
  keyId: config.CF_TURN_KEY_ID,
  apiToken: config.CF_TURN_API_TOKEN,
});

const app = express();
app.set("trust proxy", config.TRUST_PROXY);
app.disable("x-powered-by");
let server: https.Server | http.Server;
if (config.SSL_KEY_FILE && config.SSL_CRT_FILE) {
  const key = fs.readFileSync(config.SSL_KEY_FILE);
  const cert = fs.readFileSync(config.SSL_CRT_FILE);
  server = https.createServer({ key: key, cert: cert }, app);
} else {
  server = new http.Server(app);
}

const rooms = new Map<string, Room>();

const io = new Server(server, {
  // Production is same-origin. The Vite dev server runs on another port, so reflect it in dev.
  cors: isDev ? { origin: true, credentials: true } : undefined,
  transports: ["websocket"],
});

// Engine-level: check the session cookie once per connection (enforced on every namespace
// below) and make sure the requested room is loaded from SQLite. Existing rooms are loaded
// even for unauthenticated requests so the namespace exists and the client gets a clear
// "unauthorized" connect_error instead of "Invalid namespace".
io.engine.use((req: any, _res: unknown, next: () => void) => {
  req.wpAuthenticated = auth.isAuthenticated(req.headers.cookie);
  const roomId = req._query?.roomId;
  if (typeof roomId !== "string" || !roomId || roomId.length > 200) {
    return next();
  }
  try {
    const key = "/" + roomId;
    if (!rooms.has(key)) {
      // If it doesn't exist, the connection fails later with "invalid namespace"
      const row = getRoom(db, key);
      if (row) {
        rooms.set(key, new Room(io, db, key, row.data));
        console.log("loading room %s into memory", key);
      }
    }
  } catch (e) {
    console.warn("failed to load room %s:", roomId, e);
  }
  next();
});
// Reject unauthenticated sockets in every namespace (the main one, and each room's,
// which are created later). Registered before any room so it runs first.
// The client sees a connect_error with message "unauthorized".
const socketAuth = (socket: any, next: (err?: Error) => void) => {
  if (socket.request?.wpAuthenticated) {
    next();
  } else {
    next(new Error("unauthorized"));
  }
};
io.use(socketAuth);
io.on("new_namespace", (nsp) => nsp.use(socketAuth));

if (isDev) {
  app.use(cors({ origin: true, credentials: true }));
}
app.use(express.json());
app.use(express.raw({ type: "text/plain", limit: 1000000 }));

app.get("/ping", (_req, res) => {
  res.json("pong");
});

auth.register(app);

app.get("/iceServers", requireAuth, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await iceServers.get());
});

// Data's already compressed so go before the compression middleware
app.get("/subtitle/:hash", requireAuth, (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(req.params.hash)) {
    res.status(404).end("not found");
    return;
  }
  const buf = getSubtitle(db, req.params.hash, SUBTITLE_TTL_MS);
  if (!buf) {
    res.status(404).end("not found");
    return;
  }
  // User-uploaded content served from our origin: make sure it can never be rendered as HTML
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Content-Encoding", "gzip");
  res.end(Buffer.from(buf));
});

app.use(compression());

function storeSubtitle(data: Buffer) {
  const hash = crypto.createHash("sha256").update(data).digest("hex");
  saveSubtitle(db, hash, gzipSync(data), SUBTITLE_TTL_MS);
  return hash;
}

app.post("/subtitle", requireAuth, (req, res) => {
  const data = req.body;
  // body-parser only produces a Buffer for text/plain bodies
  if (!Buffer.isBuffer(data) || data.length === 0) {
    res.status(400).json({ error: "expected a non-empty text/plain body" });
    return;
  }
  res.json({ hash: storeSubtitle(data) });
});

app.get("/downloadSubtitles", requireAuth, async (req, res) => {
  if (!config.OPENSUBTITLES_KEY) {
    res.status(503).json({ error: "opensubtitles_not_configured" });
    return;
  }
  const fileId = Number(req.query.file_id);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    res.status(400).json({ error: "invalid_params" });
    return;
  }
  try {
    // Request the URL from OpenSubtitles
    const urlResp = await fetch(
      "https://api.opensubtitles.com/api/v1/download",
      {
        method: "POST",
        headers: openSubtitlesHeaders({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!urlResp.ok) {
      const err = await openSubtitlesError(urlResp);
      console.warn(
        "[downloadSubtitles] OpenSubtitles %s: %s",
        err.status,
        err.message,
      );
      res.status(502).json(err);
      return;
    }
    const urlData: { link: string } = await urlResp.json();
    // Cache the contents locally (the OpenSubtitles link only lasts a few hours)
    const subResp = await fetch(urlData.link);
    if (!subResp.ok) {
      throw new Error(`Subtitle file fetch failed: ${subResp.status}`);
    }
    const data = Buffer.from(await subResp.arrayBuffer());
    res.json({ link: "/subtitle/" + storeSubtitle(data) });
  } catch (e: any) {
    console.warn("[downloadSubtitles]", e?.message);
    res.status(502).json({ error: "subtitle download failed" });
  }
});

// Whether OpenSubtitles search is available (the player's subtitle menu hides it otherwise)
app.get("/searchSubtitles/status", requireAuth, (_req, res) => {
  res.json({ configured: Boolean(config.OPENSUBTITLES_KEY) });
});

app.get("/searchSubtitles", requireAuth, async (req, res) => {
  if (!config.OPENSUBTITLES_KEY) {
    res.status(503).json({ error: "opensubtitles_not_configured" });
    return;
  }
  let result: unknown = [];
  try {
    const title =
      typeof req.query.title === "string" ? req.query.title.slice(0, 200) : "";
    if (title) {
      // URLSearchParams URL-encodes these, so titles like "Law & Order" survive intact
      const params = new URLSearchParams({ languages: "en", query: title });
      const response = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?${params}`,
        {
          headers: openSubtitlesHeaders(),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) {
        const err = await openSubtitlesError(response);
        console.warn(
          "[searchSubtitles] OpenSubtitles %s: %s",
          err.status,
          err.message,
        );
        res.status(502).json(err);
        return;
      }
      const data = await response.json();
      result = data.data;
    }
  } catch (e: any) {
    console.error(e.message);
    result = [];
  }
  res.json(result ?? []);
});

app.get("/youtube", requireAuth, async (req, res) => {
  if (typeof req.query.q === "string") {
    try {
      const items = await searchYoutube(req.query.q);
      res.json(items);
    } catch (e: any) {
      console.warn("[youtube]", e?.message);
      res.status(500).json({ error: "youtube error" });
    }
  } else {
    res.status(500).json({ error: "query must be a string" });
  }
});

app.get("/youtubePlaylist/:playlistId", requireAuth, async (req, res) => {
  try {
    const items = await youtubePlaylist(req.params.playlistId);
    res.json(items);
  } catch (e: any) {
    console.warn("[youtubePlaylist]", e?.message);
    res.status(500).json({ error: "youtube error" });
  }
});

// AIOStreams search/streams/subtitles (/addon/*). 503 when AIOSTREAMS_MANIFEST_URL is unset.
app.use(
  createAddonRouter({
    manifestUrl: config.AIOSTREAMS_MANIFEST_URL,
    subtitleLangs: config.SUBTITLE_LANGS,
    requireAuth,
    fetchFn: safeFetch,
  }),
);

/** Allocates a room name and loads a new Room, or returns undefined if no free name was found */
function createNewRoom(): Room | undefined {
  // Pick a name nobody else is using. Collisions just retry.
  let name = "";
  for (let attempt = 0; attempt < 5 && !name; attempt++) {
    const candidate = "/" + makeRoomName();
    if (!rooms.has(candidate) && insertRoom(db, candidate)) {
      name = candidate;
    }
  }
  if (!name) {
    return undefined;
  }
  console.log("createRoom: ", name);
  // Only construct the Room once the name is secured, since it registers a namespace and a timer
  const newRoom = new Room(io, db, name);
  rooms.set(name, newRoom);
  return newRoom;
}

// Continue watching: GET /history, DELETE /history/:id, POST /history/:id/resume
app.use(
  createHistoryRouter({
    db,
    requireAuth,
    createRoom: ({ video, meta, position }) => {
      const room = createNewRoom();
      if (!room) {
        return undefined;
      }
      room.preloadVideo(video, meta, position);
      room.saveRoom();
      return room.roomId;
    },
  }),
);

app.post("/createRoom", requireAuth, async (req, res) => {
  const newRoom = createNewRoom();
  if (!newRoom) {
    res.status(503).json({ error: "could not allocate a room name" });
    return;
  }
  const name = newRoom.roomId;
  const preload =
    typeof req.body?.video === "string" ? req.body.video.slice(0, 20000) : "";
  if (preload) {
    newRoom.preloadVideo(preload);
  }
  newRoom.saveRoom();
  // Only accept reasonably sized strings, cap the number of items
  const prePlaylist: string[] = Array.isArray(req.body?.playlist)
    ? req.body.playlist
        .filter(
          (item: unknown): item is string =>
            typeof item === "string" && item.length > 0 && item.length <= 20000,
        )
        .slice(0, 25)
    : [];
  if (prePlaylist.length) {
    // Add in order in the background, a failing item shouldn't affect the others or the request
    (async () => {
      for (const item of prePlaylist) {
        try {
          await newRoom.playlistAdd(null, item);
        } catch (e) {
          console.warn(e);
        }
      }
    })();
  }
  res.json({ name });
});

app.get("/generateName", requireAuth, (_req, res) => {
  res.send(makeUserName());
});

// Proxy HLS playlists and segments
// Hostname only: no scheme, port, userinfo or path, so it can't be used to redirect the request elsewhere
const PROXY_HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
app.get("/proxy/*splat", requireAuth, async (req, res) => {
  try {
    const parsed = new URL("http://localhost" + req.url);
    const pathname = parsed.pathname.slice("/proxy".length);
    const host = parsed.searchParams.get("host") ?? "";
    if (!PROXY_HOST_RE.test(host)) {
      res.status(400).end();
      return;
    }
    const upstream = new URL("https://" + host + pathname);
    if (upstream.hostname !== host.toLowerCase()) {
      res.status(400).end();
      return;
    }
    // Refuse private/loopback addresses (hostnames are re-checked when connecting)
    assertPublicUrl(upstream);
    // Upstream content is untrusted, never let it be interpreted as HTML on our origin
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (pathname.endsWith("index-dvr.m3u8")) {
      // VOD
      const resp = await safeFetch(upstream);
      const data = await resp.text();
      const re2 = /(.*.ts)/g;
      let repl = String(data).replaceAll(re2, `$1?host=${host}`);
      // Mark this as a VOD
      repl += "#EXT-X-ENDLIST";
      res.type("application/vnd.apple.mpegurl").send(repl);
    } else if (pathname.endsWith(".m3u8")) {
      // Stream
      const resp = await safeFetch(upstream);
      const data = await resp.text();
      res.type("application/vnd.apple.mpegurl").send(String(data));
    } else if (pathname.endsWith(".ts")) {
      // Segment
      const resp = await safeFetch(upstream);
      const data = Buffer.from(await resp.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": data.length,
      });
      res.end(data);
    } else {
      res.status(404).end();
    }
  } catch {
    console.log("proxy failed: %s", req.path);
    // Always answer, otherwise the client hangs until it times out
    if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.end();
    }
  }
});

// Static assets and the SPA shell are public, the login screen is part of the app
app.use(express.static(config.BUILD_DIRECTORY));
// Send index.html for all other requests (SPA)
app.use("/*splat", (_req, res) => {
  // root keeps send's dotfile check to the relative path only
  res.sendFile("index.html", {
    root: path.resolve(import.meta.dirname, "..", config.BUILD_DIRECTORY),
  });
});

// Persist active rooms every second, and unload rooms that are empty and idle.
// Unloaded rooms are reloaded from SQLite when someone connects (see io.engine.use above).
function saveRooms(now = Date.now()) {
  for (const [key, room] of rooms) {
    if (
      room.roster.length === 0 &&
      Number(room.lastUpdateTime) < now - ROOM_IDLE_UNLOAD_MS
    ) {
      console.log("freeing room %s from memory", key);
      room.saveRoom();
      room.destroy();
      rooms.delete(key);
    } else if (room.roster.length) {
      room.lastUpdateTime = new Date(now);
      room.saveRoom();
    }
  }
}

const saveInterval = setInterval(() => {
  try {
    saveRooms();
  } catch (e) {
    console.warn("[saveRooms] failed:", e);
  }
}, 1000);
const pruneInterval = setInterval(
  () => {
    try {
      pruneSubtitles(db);
    } catch (e) {
      console.warn("[pruneSubtitles] failed:", e);
    }
  },
  60 * 60 * 1000,
);

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("[shutdown] %s received, saving %s rooms", signal, rooms.size);
  clearInterval(saveInterval);
  clearInterval(pruneInterval);
  for (const room of rooms.values()) {
    room.saveRoom();
  }
  try {
    db.close();
  } catch (e) {
    console.warn("[shutdown] closing the database failed:", e);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(Number(config.PORT), config.HOST, () => {
  console.log("listening on %s:%s", config.HOST, config.PORT);
});
