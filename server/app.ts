import defaultConfig from "./config.ts";
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
import type { DatabaseSync } from "node:sqlite";
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
import { admitRoomSockets, createRoomAuth } from "./utils/roomAuth.ts";
import { createIceServerProvider } from "./utils/iceServers.ts";
import { createAddonRouter, createAddonServices } from "./addons/routes.ts";
import { createHistoryRouter } from "./utils/historyRoutes.ts";
import { persistRooms, sweepInactiveRooms } from "./roomLifecycle.ts";
import {
  openSubtitlesError,
  openSubtitlesHeaders,
} from "./utils/opensubtitles.ts";

export type AppConfig = typeof defaultConfig;

const SUBTITLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the HTTP server, Socket.IO and every route without listening or starting timers (server.ts does that), so
 * tests can drive the real routes. `db` defaults to $DATA_DIR/watchparty.db.
 */
export function createApp(
  opts: { config?: AppConfig; db?: DatabaseSync } = {},
) {
  const config = opts.config ?? defaultConfig;
  const isDev = config.NODE_ENV === "development";
  const db =
    opts.db ?? openDatabase(path.resolve(config.DATA_DIR, "watchparty.db"));

  const auth = createAuth({
    password: config.APP_PASSWORD,
    sessionSecret: config.SESSION_SECRET,
  });
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
  // A room that deleted itself (CMD:deleteRoom, DELETE /rooms/:roomId, the inactivity sweep) is forgotten
  Room.onDeleted = (roomId) => rooms.delete(roomId);

  /** The room with namespace id `key` ("/name"), loaded from SQLite if it isn't in memory. Undefined if unknown. */
  function loadRoom(key: string): Room | undefined {
    let room = rooms.get(key);
    if (room) {
      return room;
    }
    try {
      const row = getRoom(db, key);
      if (row) {
        // Keep the stored lastUpdateTime: loading a room (join screen, info lookup) isn't activity
        room = new Room(io, db, key, row.data, row.lastUpdateTime);
        rooms.set(key, room);
        console.log("loading room %s into memory", key);
      }
    } catch (e) {
      console.warn("failed to load room %s:", key, e);
    }
    return room;
  }

  // Owners (instance session) vs room guests (per-room password grants), see utils/roomAuth.ts
  const roomAuth = createRoomAuth({
    auth,
    guestKey: auth.guestKey,
    getRoom: (roomId) => {
      const room = loadRoom(roomId);
      return room
        ? { access: room.access, title: room.roomSettings.title }
        : undefined;
    },
  });
  // Owners only: creating rooms and the watch history (which lists and creates rooms)
  const requireOwner = roomAuth.requireOwner;
  // Owners, or guests with a valid grant for a room: everything the room page itself uses
  const requireMember = roomAuth.requireMember;

  const io = new Server(server, {
    // Production is same-origin. The Vite dev server runs on another port, so reflect it in dev.
    cors: isDev ? { origin: true, credentials: true } : undefined,
    transports: ["websocket"],
  });

  // Engine-level: make sure the requested room is loaded from SQLite. Existing rooms are loaded
  // even for unauthenticated requests so the namespace exists and the client gets a clear
  // "unauthorized" connect_error instead of "Invalid namespace".
  io.engine.use((req: any, _res: unknown, next: () => void) => {
    const roomId = req._query?.roomId;
    if (typeof roomId === "string" && roomId && roomId.length <= 200) {
      // If it doesn't exist, the connection fails later with "invalid namespace"
      loadRoom("/" + roomId);
    }
    next();
  });
  // Admission, checked on every connection (see admitRoomSockets in utils/roomAuth.ts).
  // Registered before any room exists, so it runs before each room's own middleware.
  admitRoomSockets(io, roomAuth);

  if (isDev) {
    app.use(cors({ origin: true, credentials: true }));
  }
  app.use(express.json());
  app.use(express.raw({ type: "text/plain", limit: 1000000 }));

  app.get("/ping", (_req, res) => {
    res.json("pong");
  });

  auth.register(app, { guestRooms: roomAuth.guestRooms });
  // GET /rooms/:roomId/info and POST /rooms/:roomId/join (public, rate limited)
  roomAuth.register(app);

  app.get("/iceServers", requireMember, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await iceServers.get());
  });

  // Data's already compressed so go before the compression middleware
  app.get("/subtitle/:hash", requireMember, (req, res) => {
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

  app.post("/subtitle", requireMember, (req, res) => {
    const data = req.body;
    // body-parser only produces a Buffer for text/plain bodies
    if (!Buffer.isBuffer(data) || data.length === 0) {
      res.status(400).json({ error: "expected a non-empty text/plain body" });
      return;
    }
    res.json({ hash: storeSubtitle(data) });
  });

  app.get("/downloadSubtitles", requireMember, async (req, res) => {
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
  app.get("/searchSubtitles/status", requireMember, (_req, res) => {
    res.json({ configured: Boolean(config.OPENSUBTITLES_KEY) });
  });

  app.get("/searchSubtitles", requireMember, async (req, res) => {
    if (!config.OPENSUBTITLES_KEY) {
      res.status(503).json({ error: "opensubtitles_not_configured" });
      return;
    }
    let result: unknown = [];
    try {
      const title =
        typeof req.query.title === "string"
          ? req.query.title.slice(0, 200)
          : "";
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

  app.get("/youtube", requireMember, async (req, res) => {
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

  app.get("/youtubePlaylist/:playlistId", requireMember, async (req, res) => {
    try {
      const items = await youtubePlaylist(req.params.playlistId);
      res.json(items);
    } catch (e: any) {
      console.warn("[youtubePlaylist]", e?.message);
      res.status(500).json({ error: "youtube error" });
    }
  });

  // Title search/meta/subtitles/next episode (/addon/*, keyless public addons) and AIOStreams streams
  // (/addon/streams, 503 when AIOSTREAMS_MANIFEST_URL is unset).
  const addonServices = createAddonServices({
    manifestUrl: config.AIOSTREAMS_MANIFEST_URL,
    subtitleLangs: config.SUBTITLE_LANGS,
    fetchFn: safeFetch,
  });
  app.use(
    createAddonRouter(
      {
        manifestUrl: config.AIOSTREAMS_MANIFEST_URL,
        subtitleLangs: config.SUBTITLE_LANGS,
        requireAuth: requireMember,
        fetchFn: safeFetch,
      },
      addonServices,
    ),
  );
  // Rooms resolve the next episode with the same clients/caches (null without AIOStreams)
  Room.nextEpisodeResolver = addonServices.nextEpisode;

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
      requireAuth: requireOwner,
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

  app.post("/createRoom", requireOwner, async (req, res) => {
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
              typeof item === "string" &&
              item.length > 0 &&
              item.length <= 20000,
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

  // Owners: delete a room for good (Home's recent rooms). The room page uses the CMD:deleteRoom socket command.
  app.delete("/rooms/:roomId", requireOwner, (req, res) => {
    const raw = req.params.roomId;
    if (typeof raw !== "string" || !/^[\w.~-]{1,200}$/.test(raw)) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    const room = loadRoom("/" + raw);
    if (!room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!room.deleteRoom(null)) {
      res.status(500).json({ error: "delete_failed" });
      return;
    }
    res.status(204).end();
  });

  app.get("/generateName", requireMember, (_req, res) => {
    res.send(makeUserName());
  });

  // Proxy HLS playlists and segments
  // Hostname only: no scheme, port, userinfo or path, so it can't be used to redirect the request elsewhere
  const PROXY_HOST_RE =
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  app.get("/proxy/*splat", requireMember, async (req, res) => {
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

  /** Saves rooms with people in them and unloads idle empty ones (roomLifecycle.ts). Run every second. */
  function persist() {
    try {
      persistRooms(rooms);
    } catch (e) {
      console.warn("[saveRooms] failed:", e);
    }
  }

  /** Deletes expired subtitles. Run hourly. */
  function prune() {
    try {
      pruneSubtitles(db);
    } catch (e) {
      console.warn("[pruneSubtitles] failed:", e);
    }
  }

  /** Deletes rooms nobody has been in for `maxIdleDays` (roomLifecycle.ts) */
  function sweepRooms(maxIdleDays: number) {
    try {
      const deleted = sweepInactiveRooms({ db, rooms, maxIdleDays });
      if (deleted) {
        console.log("deleted %d inactive rooms", deleted);
      }
    } catch (e) {
      console.warn("[sweepInactiveRooms] failed:", e);
    }
  }

  /** Saves every room and closes the database (graceful shutdown) */
  function saveAndClose() {
    for (const room of rooms.values()) {
      room.saveRoom();
    }
    try {
      db.close();
    } catch (e) {
      console.warn("[shutdown] closing the database failed:", e);
    }
  }

  return {
    app,
    server,
    io,
    db,
    rooms,
    loadRoom,
    createNewRoom,
    persist,
    prune,
    sweepRooms,
    saveAndClose,
  };
}
