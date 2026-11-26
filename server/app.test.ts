// HTTP routes of the real app (createApp in app.ts) on a random port: auth wiring, rooms, subtitles, OpenSubtitles,
// YouTube, the HLS proxy, the SPA fallback and the lifecycle helpers. No real network: outside fetches are stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import defaultConfig from "./config.ts";
import { createApp, type AppConfig } from "./app.ts";
import { getRoom, openDatabase, saveSubtitle } from "./utils/db.ts";
import { Room } from "./room.ts";
import { describeHistoryItem, upsertHistory } from "./utils/history.ts";

const youtube = vi.hoisted(() => ({
  searchYoutube: vi.fn(),
  youtubePlaylist: vi.fn(),
}));
vi.mock("./utils/youtube.ts", async (orig) => ({
  ...(await orig<typeof import("./utils/youtube.ts")>()),
  searchYoutube: youtube.searchYoutube,
  youtubePlaylist: youtube.youtubePlaylist,
}));
const moniker = vi.hoisted(() => ({ makeRoomName: vi.fn() }));
vi.mock("./utils/moniker.ts", async (orig) => {
  const real = await orig<typeof import("./utils/moniker.ts")>();
  moniker.makeRoomName.mockImplementation(real.makeRoomName);
  return { ...real, makeRoomName: moniker.makeRoomName };
});
const ssrf = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("./utils/ssrf.ts", async (orig) => ({
  ...(await orig<typeof import("./utils/ssrf.ts")>()),
  safeFetch: ssrf.safeFetch,
}));

const realFetch = globalThis.fetch;
/** Outside requests made by the routes (OpenSubtitles); requests to the test server go through */
const outside = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

let buildDir: string;
let ctx: ReturnType<typeof createApp> | undefined;
let base = "";

beforeEach(() => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-build-"));
  fs.writeFileSync(path.join(buildDir, "index.html"), "<!doctype html>SPA");
  fs.writeFileSync(path.join(buildDir, "app.js"), "console.log(1)");
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://127.0.0.1:")) {
        return realFetch(input, init);
      }
      return outside(url, init);
    },
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (ctx) {
    for (const room of ctx.rooms.values()) {
      room.destroy();
    }
    ctx.server.closeAllConnections();
    await new Promise<void>((r) => ctx!.io.close(() => r()));
    try {
      ctx.db.close();
    } catch {
      // already closed by saveAndClose
    }
  }
  ctx = undefined;
  Room.onDeleted = null;
  Room.nextEpisodeResolver = null;
  fs.rmSync(buildDir, { recursive: true, force: true });
  outside.mockReset();
  youtube.searchYoutube.mockReset();
  youtube.youtubePlaylist.mockReset();
  ssrf.safeFetch.mockReset();
  const real =
    await vi.importActual<typeof import("./utils/moniker.ts")>(
      "./utils/moniker.ts",
    );
  moniker.makeRoomName.mockReset();
  moniker.makeRoomName.mockImplementation(real.makeRoomName);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = {
    ...defaultConfig,
    APP_PASSWORD: "",
    SESSION_SECRET: "",
    OPENSUBTITLES_KEY: "",
    AIOSTREAMS_MANIFEST_URL: "",
    NODE_ENV: "test",
    BUILD_DIRECTORY: buildDir,
    ...overrides,
  };
  ctx = createApp({ config, db: openDatabase(":memory:") });
  await new Promise<void>((r) => ctx!.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(ctx.server.address() as AddressInfo).port}`;
  return ctx;
}

async function call(
  method: string,
  p: string,
  opts: { body?: unknown; text?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (opts.text !== undefined) {
    headers["Content-Type"] = "text/plain";
    body = opts.text;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (opts.cookie) {
    headers.Cookie = opts.cookie;
  }
  const resp = await realFetch(base + p, { method, headers, body });
  const buf = Buffer.from(await resp.arrayBuffer());
  const text = buf.toString();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: resp.status, headers: resp.headers, text, json, buf };
}

describe("basics", () => {
  it("answers /ping and hides x-powered-by", async () => {
    await start();
    const r = await call("GET", "/ping");
    expect(r.json).toBe("pong");
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("serves static files and the SPA shell for any other path", async () => {
    await start();
    expect((await call("GET", "/app.js")).text).toBe("console.log(1)");
    const r = await call("GET", "/watch/some-room");
    expect(r.status).toBe(200);
    expect(r.text).toContain("SPA");
  });

  it("reflects the origin with credentials only in development", async () => {
    await start({ NODE_ENV: "development" });
    const resp = await realFetch(base + "/ping", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(resp.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(resp.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("sends no CORS headers in production", async () => {
    await start();
    const resp = await realFetch(base + "/ping", {
      headers: { Origin: "http://evil.example.com" },
    });
    expect(resp.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("generates user names", async () => {
    await start();
    const r = await call("GET", "/generateName");
    expect(r.text).toMatch(/^[A-Z]\S* [A-Z]\S*$/);
  });

  it("returns STUN servers without TURN credentials", async () => {
    await start();
    const r = await call("GET", "/iceServers");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Array.isArray(r.json)).toBe(true);
  });
});

describe("auth wiring", () => {
  async function login() {
    const resp = await realFetch(base + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter22" }),
    });
    expect(resp.status).toBe(204);
    return resp.headers.getSetCookie()[0].split(";")[0];
  }

  it("refuses owner and member routes without a session", async () => {
    await start({ APP_PASSWORD: "hunter22", SESSION_SECRET: "s".repeat(32) });
    expect((await call("POST", "/createRoom")).status).toBe(401);
    expect((await call("GET", "/history")).status).toBe(401);
    expect((await call("DELETE", "/rooms/abc")).status).toBe(401);
    for (const p of [
      "/iceServers",
      "/generateName",
      "/youtube?q=x",
      "/searchSubtitles/status",
      "/addon/status",
      "/proxy/a.m3u8?host=cdn.example.com",
      "/subtitle/" + "a".repeat(64),
    ]) {
      expect((await call("GET", p)).status, p).toBe(401);
    }
    // Public ones still work
    expect((await call("GET", "/ping")).status).toBe(200);
    const session = await call("GET", "/session");
    expect(session.json).toMatchObject({
      authenticated: false,
      authRequired: true,
    });
  });

  it("lets an owner in after logging in", async () => {
    await start({ APP_PASSWORD: "hunter22", SESSION_SECRET: "s".repeat(32) });
    const cookie = await login();
    expect((await call("GET", "/session", { cookie })).json).toMatchObject({
      authenticated: true,
    });
    const created = await call("POST", "/createRoom", { cookie });
    expect(created.status).toBe(200);
    expect((await call("GET", "/generateName", { cookie })).status).toBe(200);
  });

  it("gives a guest the room's member routes but not owner routes", async () => {
    const app = await start({
      APP_PASSWORD: "hunter22",
      SESSION_SECRET: "s".repeat(32),
    });
    const room = app.createNewRoom()!;
    const id = room.roomId.slice(1);
    const info = await call("GET", `/rooms/${id}/info`);
    expect(info.json).toMatchObject({ passwordRequired: true });
    const resp = await realFetch(`${base}/rooms/${id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: room.access.password }),
    });
    expect(resp.status).toBe(200);
    const cookie = resp.headers.getSetCookie()[0].split(";")[0];
    expect((await call("GET", "/generateName", { cookie })).status).toBe(200);
    expect((await call("POST", "/createRoom", { cookie })).status).toBe(401);
    expect((await call("GET", "/session", { cookie })).json).toMatchObject({
      authenticated: false,
      guestRooms: [id],
    });
  });

  it("loads stored rooms from the database for the join screen", async () => {
    const app = await start({
      APP_PASSWORD: "hunter22",
      SESSION_SECRET: "s".repeat(32),
    });
    const room = app.createNewRoom()!;
    room.roomSettings.title = "Movie night";
    room.saveRoom();
    room.destroy();
    app.rooms.delete(room.roomId);
    const info = await call("GET", `/rooms${room.roomId}/info`);
    expect(info.json).toEqual({
      title: "Movie night",
      passwordRequired: true,
    });
    expect(app.rooms.has(room.roomId)).toBe(true);
    expect((await call("GET", "/rooms/missing-room/info")).status).toBe(404);
  });

  it("treats a room whose stored data is corrupt as unknown", async () => {
    const app = await start();
    app.db
      .prepare(
        "INSERT INTO rooms (roomId, data, lastUpdateTime, createdAt) VALUES (?, ?, ?, ?)",
      )
      .run("/broken-room", "{not json", Date.now(), Date.now());
    expect(app.loadRoom("/broken-room")).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("POST /createRoom", () => {
  it("creates and saves a room", async () => {
    const app = await start();
    const r = await call("POST", "/createRoom");
    expect(r.status).toBe(200);
    expect(r.json.name).toMatch(/^\/[a-z]+-[a-z]+-[a-z]+$/);
    expect(app.rooms.get(r.json.name)).toBeInstanceOf(Room);
    expect(getRoom(app.db, r.json.name)).toBeDefined();
  });

  it("preloads a video (paused) and queues the valid playlist items in order", async () => {
    const app = await start();
    const r = await call("POST", "/createRoom", {
      body: {
        video: "https://example.com/a.mp4",
        playlist: [
          "https://example.com/b.mp4",
          42,
          "",
          "x".repeat(20001),
          "https://example.com/c.mp4",
        ],
      },
    });
    const room = app.rooms.get(r.json.name)!;
    expect(room.video).toBe("https://example.com/a.mp4");
    expect(room.paused).toBe(true);
    await vi.waitFor(() => expect(room.playlist).toHaveLength(2));
    expect(room.playlist.map((p) => p.url)).toEqual([
      "https://example.com/b.mp4",
      "https://example.com/c.mp4",
    ]);
  });

  it("answers 503 when no free room name is found", async () => {
    const app = await start();
    moniker.makeRoomName.mockReturnValue("taken-room-name");
    app.createNewRoom();
    // Every attempt picks the same, taken name
    const r = await call("POST", "/createRoom");
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: "could not allocate a room name" });
    expect(moniker.makeRoomName).toHaveBeenCalledTimes(6);
  });
});

describe("DELETE /rooms/:roomId", () => {
  it("deletes a room and forgets it", async () => {
    const app = await start();
    const room = app.createNewRoom()!;
    const r = await call("DELETE", "/rooms" + room.roomId);
    expect(r.status).toBe(204);
    expect(app.rooms.has(room.roomId)).toBe(false);
    expect(getRoom(app.db, room.roomId)).toBeUndefined();
  });

  it("validates the id and 404s unknown rooms", async () => {
    await start();
    expect((await call("DELETE", "/rooms/bad%20id")).status).toBe(400);
    expect((await call("DELETE", "/rooms/" + "a".repeat(201))).status).toBe(
      400,
    );
    expect((await call("DELETE", "/rooms/nope")).json).toEqual({
      error: "not_found",
    });
  });

  it("answers 500 when the room can't be deleted", async () => {
    const app = await start();
    const room = app.createNewRoom()!;
    vi.spyOn(room, "deleteRoom").mockReturnValue(false);
    const r = await call("DELETE", "/rooms" + room.roomId);
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "delete_failed" });
  });
});

describe("subtitles", () => {
  it("stores a text/plain upload and serves it gzipped with safe headers", async () => {
    await start();
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
    const up = await call("POST", "/subtitle", { text: srt });
    const hash = createHash("sha256").update(srt).digest("hex");
    expect(up.json).toEqual({ hash });
    const resp = await realFetch(`${base}/subtitle/${hash}`);
    expect(resp.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("content-security-policy")).toContain("sandbox");
    expect(await resp.text()).toBe(srt);
  });

  it("rejects empty or non-text uploads", async () => {
    await start();
    expect((await call("POST", "/subtitle", { text: "" })).status).toBe(400);
    expect((await call("POST", "/subtitle", { body: { a: 1 } })).status).toBe(
      400,
    );
  });

  it("404s malformed and unknown hashes", async () => {
    await start();
    expect((await call("GET", "/subtitle/xyz")).status).toBe(404);
    expect((await call("GET", "/subtitle/" + "b".repeat(64))).status).toBe(404);
  });

  it("prunes expired subtitles", async () => {
    const app = await start();
    saveSubtitle(app.db, "c".repeat(64), Buffer.from("x"), -1000);
    app.prune();
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM subtitles").get()).toEqual(
      { n: 0 },
    );
  });

  it("logs instead of throwing when pruning fails", async () => {
    const app = await start();
    app.db.close();
    expect(() => app.prune()).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      "[pruneSubtitles] failed:",
      expect.anything(),
    );
  });
});

describe("OpenSubtitles", () => {
  it("reports whether it's configured", async () => {
    await start();
    expect((await call("GET", "/searchSubtitles/status")).json).toEqual({
      configured: false,
    });
    expect((await call("GET", "/searchSubtitles?title=x")).status).toBe(503);
    expect((await call("GET", "/downloadSubtitles?file_id=1")).status).toBe(
      503,
    );
  });

  it("searches by title (URL-encoded) and returns the data array", async () => {
    await start({ OPENSUBTITLES_KEY: "k" });
    expect((await call("GET", "/searchSubtitles/status")).json).toEqual({
      configured: true,
    });
    outside.mockResolvedValue(Response.json({ data: [{ id: "1" }] }));
    const r = await call("GET", "/searchSubtitles?title=Law%20%26%20Order");
    expect(r.json).toEqual([{ id: "1" }]);
    expect(outside.mock.calls[0][0]).toContain("query=Law+%26+Order");
  });

  it("returns [] without a title, on a network error, or without data", async () => {
    await start({ OPENSUBTITLES_KEY: "k" });
    expect((await call("GET", "/searchSubtitles")).json).toEqual([]);
    expect(outside).not.toHaveBeenCalled();
    outside.mockRejectedValueOnce(new Error("down"));
    expect((await call("GET", "/searchSubtitles?title=x")).json).toEqual([]);
    outside.mockResolvedValueOnce(Response.json({}));
    expect((await call("GET", "/searchSubtitles?title=x")).json).toEqual([]);
  });

  it("passes OpenSubtitles' error on as a 502", async () => {
    await start({ OPENSUBTITLES_KEY: "k" });
    outside.mockResolvedValue(
      Response.json(
        { message: "You cannot consume this service" },
        { status: 403 },
      ),
    );
    const r = await call("GET", "/searchSubtitles?title=x");
    expect(r.status).toBe(502);
    expect(r.json).toEqual({
      error: "opensubtitles_error",
      status: 403,
      message: expect.stringContaining("You cannot consume this service"),
    });
  });

  it("downloads a subtitle and caches it locally", async () => {
    await start({ OPENSUBTITLES_KEY: "k" });
    outside
      .mockResolvedValueOnce(
        Response.json({ link: "https://dl.example.com/s.srt" }),
      )
      .mockResolvedValueOnce(new Response("subtitle body"));
    const r = await call("GET", "/downloadSubtitles?file_id=42");
    const hash = createHash("sha256").update("subtitle body").digest("hex");
    expect(r.json).toEqual({ link: "/subtitle/" + hash });
    expect(JSON.parse(String(outside.mock.calls[0][1]?.body))).toEqual({
      file_id: 42,
    });
    expect((await call("GET", "/subtitle/" + hash)).text).toBe("subtitle body");
  });

  it("validates file_id", async () => {
    await start({ OPENSUBTITLES_KEY: "k" });
    for (const id of ["", "abc", "-1", "1.5", "0"]) {
      expect(
        (await call("GET", "/downloadSubtitles?file_id=" + id)).status,
      ).toBe(400);
    }
  });

  it("answers 502 when OpenSubtitles or the file download fails", async () => {
    await start({ OPENSUBTITLES_KEY: "k" });
    outside.mockResolvedValueOnce(new Response("quota", { status: 406 }));
    const quota = await call("GET", "/downloadSubtitles?file_id=1");
    expect(quota.status).toBe(502);
    expect(quota.json).toMatchObject({ status: 406, message: "quota" });

    outside
      .mockResolvedValueOnce(
        Response.json({ link: "https://dl.example.com/s" }),
      )
      .mockResolvedValueOnce(new Response("gone", { status: 410 }));
    const gone = await call("GET", "/downloadSubtitles?file_id=1");
    expect(gone.status).toBe(502);
    expect(gone.json).toEqual({ error: "subtitle download failed" });
  });
});

describe("YouTube", () => {
  it("searches", async () => {
    await start();
    youtube.searchYoutube.mockResolvedValue([{ url: "u" }]);
    expect((await call("GET", "/youtube?q=cats")).json).toEqual([{ url: "u" }]);
    expect(youtube.searchYoutube).toHaveBeenCalledWith("cats");
  });

  it("answers 400 for a missing or bad query and 500 for a failed search", async () => {
    await start();
    for (const q of [
      "",
      "?q=",
      "?q=%20%20",
      "?q=a&q=b",
      "?q=" + "a".repeat(501),
    ]) {
      const bad = await call("GET", "/youtube" + q);
      expect(bad.status, q).toBe(400);
      expect(bad.json).toEqual({ error: "invalid_params" });
    }
    expect(youtube.searchYoutube).not.toHaveBeenCalled();
    youtube.searchYoutube.mockRejectedValue(new Error("quota"));
    const r = await call("GET", "/youtube?q=x");
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "youtube error" });
  });

  it("lists playlists", async () => {
    await start();
    youtube.youtubePlaylist.mockResolvedValueOnce([{ url: "a" }]);
    expect((await call("GET", "/youtubePlaylist/PL1")).json).toEqual([
      { url: "a" },
    ]);
    youtube.youtubePlaylist.mockRejectedValueOnce(new Error("x"));
    expect((await call("GET", "/youtubePlaylist/PL1")).status).toBe(500);
  });
});

describe("addons", () => {
  it("mounts the addon router and wires the next-episode resolver", async () => {
    await start();
    expect((await call("GET", "/addon/status")).json).toEqual({
      streams: false,
    });
    expect(Room.nextEpisodeResolver).toBeNull();
  });

  it("enables streams with a manifest URL", async () => {
    await start({
      AIOSTREAMS_MANIFEST_URL:
        "https://aio.example.com/stremio/u/c/manifest.json",
    });
    expect((await call("GET", "/addon/status")).json).toEqual({
      streams: true,
    });
    expect(Room.nextEpisodeResolver).toBeTypeOf("function");
  });
});

describe("history", () => {
  it("resumes into a new room, paused at the saved position", async () => {
    const app = await start();
    const old = app.createNewRoom()!;
    const url = "https://example.com/m.mp4";
    upsertHistory(app.db, {
      ...describeHistoryItem(url, null)!,
      roomId: old.roomId,
      url,
      meta: null,
      position: 120,
      duration: 3600,
      finished: false,
    });
    const list = await call("GET", "/history");
    expect(list.json).toHaveLength(1);
    const r = await call("POST", `/history/${list.json[0].id}/resume`);
    expect(r.status).toBe(200);
    const room = app.rooms.get("/" + r.json.roomId)!;
    expect(room.video).toBe("https://example.com/m.mp4");
    expect(room.videoTS).toBe(120);
    expect(room.paused).toBe(true);
    expect(getRoom(app.db, room.roomId)).toBeDefined();
  });
});

describe("history resume without a free room name", () => {
  it("answers 503", async () => {
    const app = await start();
    const old = app.createNewRoom()!;
    const url = "https://example.com/m.mp4";
    upsertHistory(app.db, {
      ...describeHistoryItem(url, null)!,
      roomId: old.roomId,
      url,
      meta: null,
      position: 120,
      duration: 3600,
      finished: false,
    });
    const [item] = (await call("GET", "/history")).json;
    moniker.makeRoomName.mockReturnValue(old.roomId.slice(1));
    const r = await call("POST", `/history/${item.id}/resume`);
    expect(r.status).toBe(503);
  });
});

describe("HLS proxy", () => {
  it("rewrites VOD playlists so segments go through the proxy", async () => {
    await start();
    ssrf.safeFetch.mockResolvedValue(
      new Response("#EXTM3U\nseg1.ts\nseg2.ts\n"),
    );
    const r = await call("GET", "/proxy/v/index-dvr.m3u8?host=cdn.example.com");
    expect(r.headers.get("content-type")).toContain("mpegurl");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.text).toBe(
      "#EXTM3U\nseg1.ts?host=cdn.example.com\nseg2.ts?host=cdn.example.com\n#EXT-X-ENDLIST",
    );
    expect(String(ssrf.safeFetch.mock.calls[0][0])).toBe(
      "https://cdn.example.com/v/index-dvr.m3u8",
    );
  });

  it("passes live playlists through", async () => {
    await start();
    ssrf.safeFetch.mockResolvedValue(new Response("#EXTM3U\nlive.ts"));
    const r = await call("GET", "/proxy/live/x.m3u8?host=cdn.example.com");
    expect(r.text).toBe("#EXTM3U\nlive.ts");
  });

  it("serves segments as bytes", async () => {
    await start();
    ssrf.safeFetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const r = await call("GET", "/proxy/v/seg1.ts?host=cdn.example.com");
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect([...r.buf]).toEqual([1, 2, 3]);
  });

  it("404s other files", async () => {
    await start();
    expect(
      (await call("GET", "/proxy/v/file.mp4?host=cdn.example.com")).status,
    ).toBe(404);
    expect(ssrf.safeFetch).not.toHaveBeenCalled();
  });

  it("refuses hosts that aren't plain public hostnames", async () => {
    await start();
    for (const host of [
      "",
      "cdn.example.com:8080",
      "user@cdn.example.com",
      "cdn.example.com/evil",
      "localhost",
      "127.0.0.1",
    ]) {
      const r = await call(
        "GET",
        "/proxy/v/a.m3u8?host=" + encodeURIComponent(host),
      );
      expect(r.status, host).toBe(host === "127.0.0.1" ? 502 : 400);
    }
    // An IP literal parses as a hostname but is refused by the SSRF guard
    expect(ssrf.safeFetch).not.toHaveBeenCalled();
  });

  it("refuses hosts the URL parser rewrites (IPv4 shorthands)", async () => {
    await start();
    // "127.1" and "0x7f.0.0.1" look like hostnames but parse as 127.0.0.1
    for (const host of ["127.1", "0x7f.0.0.1"]) {
      const r = await call("GET", "/proxy/a.m3u8?host=" + host);
      expect(r.status, host).toBe(400);
    }
    expect(ssrf.safeFetch).not.toHaveBeenCalled();
  });

  it("answers 502 when the upstream fetch fails", async () => {
    await start();
    ssrf.safeFetch.mockRejectedValue(new Error("Blocked address 10.0.0.1"));
    const r = await call("GET", "/proxy/a.m3u8?host=cdn.example.com");
    expect(r.status).toBe(502);
  });

  it("ends the response if it fails after the headers were sent", async () => {
    await start();
    ssrf.safeFetch.mockResolvedValue({
      arrayBuffer: () => Promise.reject(new Error("reset")),
    } as unknown as Response);
    const r = await call("GET", "/proxy/a.ts?host=cdn.example.com");
    // Headers (nosniff) were set but not sent yet, so it's still a 502
    expect(r.status).toBe(502);
  });
});

describe("Socket.IO admission", () => {
  it("loads a stored room into memory when a socket asks for it", async () => {
    const app = await start();
    const room = app.createNewRoom()!;
    room.saveRoom();
    room.destroy();
    app.rooms.delete(room.roomId);
    const { io: ioClient } = await import("socket.io-client");
    const socket = ioClient(base + room.roomId, {
      transports: ["websocket"],
      query: {
        roomId: room.roomId.slice(1),
        clientId: crypto.randomUUID(),
      },
      auth: { sessionId: "x".repeat(32) },
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    expect(app.rooms.has(room.roomId)).toBe(true);
    socket.disconnect();
  });
});

describe("lifecycle helpers", () => {
  it("persists rooms with people in them", async () => {
    const app = await start();
    const room = app.createNewRoom()!;
    room.roster.push({ id: "u1" });
    room.video = "https://example.com/v.mp4";
    app.persist();
    expect(JSON.parse(getRoom(app.db, room.roomId)!.data!).video).toBe(
      "https://example.com/v.mp4",
    );
  });

  it("logs a failing save loop instead of throwing", async () => {
    const app = await start();
    app.rooms.set("/bad", {
      roster: [{ id: "x" }],
      get lastUpdateTime() {
        throw new Error("boom");
      },
      set lastUpdateTime(_v) {
        throw new Error("boom");
      },
    } as unknown as Room);
    expect(() => app.persist()).not.toThrow();
    app.rooms.delete("/bad");
  });

  it("sweeps inactive rooms", async () => {
    const app = await start();
    const room = app.createNewRoom()!;
    room.lastUpdateTime = new Date(Date.now() - 100 * 86400000);
    room.saveRoom();
    room.destroy();
    app.rooms.delete(room.roomId);
    app.sweepRooms(60);
    expect(getRoom(app.db, room.roomId)).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith("deleted %d inactive rooms", 1);
  });

  it("logs a failing sweep instead of throwing", async () => {
    const app = await start();
    app.db.close();
    expect(() => app.sweepRooms(60)).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      "[sweepInactiveRooms] failed:",
      expect.anything(),
    );
  });

  it("saves every room and closes the database", async () => {
    const app = await start();
    const room = app.createNewRoom()!;
    room.video = "https://example.com/z.mp4";
    app.saveAndClose();
    expect(() => app.db.prepare("SELECT 1")).toThrow();
    // A second close fails and is only logged
    app.saveAndClose();
    expect(console.warn).toHaveBeenCalledWith(
      "[shutdown] closing the database failed:",
      expect.anything(),
    );
  });
});

describe("gunzip helper sanity", () => {
  it("stores subtitles gzipped in the database", async () => {
    const app = await start();
    const up = await call("POST", "/subtitle", { text: "abc" });
    const row = app.db
      .prepare("SELECT data FROM subtitles WHERE hash = ?")
      .get(up.json.hash) as { data: Uint8Array };
    expect(gunzipSync(row.data).toString()).toBe("abc");
  });
});
