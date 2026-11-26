import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "./db.ts";
import { describeHistoryItem, listHistory, upsertHistory } from "./history.ts";
import { createHistoryRouter, parseLimit } from "./historyRoutes.ts";

const meta: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:1:2",
  imdbId: "tt0000001",
  season: 1,
  episode: 2,
  title: "Example Show",
  episodeTitle: null,
  poster: null,
  bingeGroup: null,
};
const SECRET = "eyFAKEBLOBsecret";
const AIO = `https://aio.example.com/api/v1/debrid/playback/${SECRET}/file.mkv`;

// Stand-in for auth.requireAuth: 401 without the test header
const requireAuth: RequestHandler = (req, res, next) => {
  if (req.headers["x-test-auth"] === "ok") {
    next();
  } else {
    res.status(401).json({ error: "unauthorized" });
  }
};

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  server = undefined;
});

async function setup() {
  const db = openDatabase(":memory:");
  const createRoom = vi.fn(
    (_opts: { video: string; meta: VideoMeta | null; position: number }) =>
      "/new-room" as string | undefined,
  );
  const app = express();
  app.use(createHistoryRouter({ db, requireAuth, createRoom }));
  server = app.listen(0);
  await new Promise((r) => server!.once("listening", r));
  const port = (server!.address() as AddressInfo).port;
  const call = async (method: string, path: string, auth = true) => {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: auth ? { "x-test-auth": "ok" } : {},
    });
    const text = await resp.text();
    return { status: resp.status, text, body: text ? JSON.parse(text) : null };
  };
  const add = (over: Record<string, unknown> = {}) =>
    upsertHistory(db, {
      ...describeHistoryItem(AIO, meta)!,
      roomId: "/old-room",
      url: AIO,
      meta,
      position: 600,
      duration: 1200,
      finished: false,
      ...over,
    });
  return { db, call, add, createRoom };
}

describe("history routes", () => {
  it("require auth", async () => {
    const { call, add } = await setup();
    add();
    for (const [m, p] of [
      ["GET", "/history"],
      ["DELETE", "/history/1"],
      ["POST", "/history/1/resume"],
    ]) {
      expect((await call(m, p, false)).status).toBe(401);
    }
  });

  it("lists items without any URL", async () => {
    const { call, add } = await setup();
    add();
    const { status, body, text } = await call("GET", "/history?limit=5");
    expect(status).toBe(200);
    expect(body).toEqual([
      {
        id: 1,
        roomId: "/old-room",
        kind: "aiostreams",
        title: "Example Show",
        subtitle: "S01E02",
        poster: null,
        position: 600,
        duration: 1200,
        updatedAt: expect.any(Number),
        finished: false,
        group: "meta:tt0000001",
      },
    ]);
    expect(text).not.toContain("aio.example.com");
    expect(text).not.toContain(SECRET);
  });

  it("deletes items", async () => {
    const { call, add } = await setup();
    add();
    expect((await call("DELETE", "/history/1")).status).toBe(204);
    expect((await call("DELETE", "/history/1")).status).toBe(404);
    expect((await call("DELETE", "/history/abc")).status).toBe(400);
    expect((await call("GET", "/history")).body).toEqual([]);
  });

  it("resumes in a new room at the saved position and moves the entry", async () => {
    const { call, add, createRoom, db } = await setup();
    add();
    const { status, body, text } = await call("POST", "/history/1/resume");
    expect(status).toBe(200);
    expect(body).toEqual({ roomId: "new-room" });
    expect(text).not.toContain(SECRET);
    expect(createRoom).toHaveBeenCalledWith({
      video: AIO,
      meta,
      position: 600,
    });
    const items = listHistory(db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      roomId: "/new-room",
      position: 600,
      duration: 1200,
    });
  });

  it("restarts finished items, and handles unknown ids and full rooms", async () => {
    const { call, add, createRoom } = await setup();
    add({ position: 1190, finished: true });
    await call("POST", "/history/1/resume");
    expect(createRoom.mock.calls[0][0].position).toBe(0);
    expect((await call("POST", "/history/99/resume")).status).toBe(404);
    expect((await call("POST", "/history/0/resume")).status).toBe(400);
    createRoom.mockReturnValueOnce(undefined);
    const latest = (await call("GET", "/history")).body[0].id;
    expect((await call("POST", `/history/${latest}/resume`)).status).toBe(503);
  });

  it("parseLimit", () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("0")).toBe(1);
    expect(parseLimit("9999")).toBe(200);
    expect(parseLimit("-1")).toBe(50);
    expect(parseLimit(["1"])).toBe(50);
  });
});
