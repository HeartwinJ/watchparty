import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { Room } from "./room.ts";

const meta: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:1:2",
  imdbId: "tt0000001",
  season: 1,
  episode: 2,
  title: "Example Show",
  episodeTitle: "Second",
  poster: null,
  bingeGroup: "grp",
};
const STREAM = "https://aio.example.com/playback/one.mkv";

type Client = ClientSocket & { clientId: string };

async function setup() {
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const room = new Room(io, db, "/meta-room");
  const clients: ClientSocket[] = [];
  /** Connects a client; resolves once connected (handlers can be attached first via `before`) */
  const join = async (name?: string, before?: (s: ClientSocket) => void) => {
    const clientId = randomUUID();
    const socket = connect(`http://127.0.0.1:${port}/meta-room`, {
      transports: ["websocket"],
      query: { clientId },
      auth: { sessionId: randomUUID() + randomUUID() },
      forceNew: true,
    }) as Client;
    socket.clientId = clientId;
    clients.push(socket);
    before?.(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    if (name) {
      socket.emit("CMD:name", name);
    }
    return socket;
  };
  const close = async () => {
    clients.forEach((c) => c.disconnect());
    room.destroy();
    io.close();
    db.close();
    await new Promise((r) => server.close(r));
  };
  return { room, io, db, join, close };
}

/** Resolves with the next payload of `event` that matches `pred`. */
const next = <T>(
  socket: ClientSocket,
  event: string,
  pred: (v: T) => boolean = () => true,
) =>
  new Promise<T>((resolve) => {
    const fn = (v: T) => {
      if (pred(v)) {
        socket.off(event, fn);
        resolve(v);
      }
    };
    socket.on(event, fn);
  });

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("Room videoMeta", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("stores, broadcasts and serializes metadata for the current video", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join("Alex");
    const b = await t.join("Sam");
    a.emit("CMD:host", STREAM);
    await next(b, "REC:host", (h: HostState) => h.video === STREAM);
    const received = next<VideoMeta | null>(b, "REC:videoMeta", Boolean);
    a.emit("CMD:videoMeta", { url: STREAM, meta: { ...meta, junk: 1 } });
    expect(await received).toEqual(meta);
    expect(t.room.videoMeta).toEqual(meta);

    // Persisted with the room, and restored
    const data = t.room.serialize();
    expect(JSON.parse(data).videoMeta).toEqual(meta);
    const loaded = new Room(t.io, t.db, "/meta-room-copy", data);
    expect(loaded.videoMeta).toEqual(meta);
    loaded.destroy();
  });

  it("keys the subtitle offset by title/episode, so a new stream link restores it", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join("Alex");
    const b = await t.join("Sam");
    // First pick of this episode: set an offset
    a.emit("CMD:host", STREAM);
    await settle();
    a.emit("CMD:videoMeta", { url: STREAM, meta });
    await settle();
    a.emit("CMD:subtitleOffset", 0.75);
    await settle();
    expect(t.room.subtitleOffset).toBe(0.75);

    // Something else plays, then a different stream link of the same episode
    a.emit("CMD:host", "https://example.com/other.mp4");
    await settle();
    expect(t.room.subtitleOffset).toBe(0);
    const OTHER_LINK = "https://aio.example.com/playback/two.mkv";
    a.emit("CMD:host", OTHER_LINK);
    await settle();
    const restored = next<{ offset: number }>(b, "REC:subtitleOffset");
    a.emit("CMD:videoMeta", { url: OTHER_LINK, meta });
    expect((await restored).offset).toBe(0.75);
    expect(t.room.subtitleOffset).toBe(0.75);
  });

  it("sends the current metadata to a joining client", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", STREAM);
    await settle();
    a.emit("CMD:videoMeta", { url: STREAM, meta });
    await settle();
    let onJoin: Promise<unknown> | undefined;
    await t.join(undefined, (s) => {
      onJoin = next(s, "REC:videoMeta");
    });
    expect(await onJoin).toEqual(meta);
  });

  it("ignores metadata for a video that isn't current, and invalid metadata", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", STREAM);
    await settle();
    a.emit("CMD:videoMeta", { url: "https://other.example.com/x", meta });
    a.emit("CMD:videoMeta", { url: STREAM, meta: { ...meta, id: "bad" } });
    a.emit("CMD:videoMeta", "garbage");
    await settle();
    expect(t.room.videoMeta).toBeNull();
  });

  it("clears metadata when a different video is hosted", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    a.emit("CMD:host", STREAM);
    await settle();
    a.emit("CMD:videoMeta", { url: STREAM, meta });
    await settle();
    expect(t.room.videoMeta).toEqual(meta);
    const cleared = next(b, "REC:videoMeta", (v) => v === null);
    b.emit("CMD:host", "https://www.youtube.com/watch?v=abcdefghijk");
    expect(await cleared).toBeNull();
    expect(t.room.videoMeta).toBeNull();
    expect(JSON.parse(t.room.serialize()).videoMeta).toBeNull();
  });

  it("keeps metadata on queued items and restores it when the item plays", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", "https://v.example.com/first.mp4");
    await settle();
    a.emit("CMD:playlistAdd", {
      url: STREAM,
      name: "Example Show · S01E02",
      meta,
    });
    await settle();
    expect(t.room.playlist[0]).toMatchObject({
      url: STREAM,
      name: "Example Show · S01E02",
      meta,
    });
    // Legacy string payloads still work
    a.emit("CMD:playlistAdd", "https://v.example.com/plain.mp4");
    await settle();
    expect(t.room.playlist[1]).toMatchObject({
      url: "https://v.example.com/plain.mp4",
      name: "https://v.example.com/plain.mp4",
    });
    expect(t.room.playlist[1].meta).toBeUndefined();
    a.emit("CMD:playlistNext", "https://v.example.com/first.mp4");
    await settle();
    expect(t.room.video).toBe(STREAM);
    expect(t.room.videoMeta).toEqual(meta);
  });
});

describe("Room playbackIssue", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("broadcasts a validated report with the reporter's name, rate limited", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = (await t.join("Alex")) as Client;
    const b = await t.join("Sam");
    a.emit("CMD:host", STREAM);
    await settle();
    const issues: PlaybackIssue[] = [];
    b.on("REC:playbackIssue", (i: PlaybackIssue) => issues.push(i));
    a.emit("CMD:playbackIssue", { reason: "HEVC not supported" });
    a.emit("CMD:playbackIssue", { reason: "again, too soon" });
    a.emit("CMD:playbackIssue", { reason: "" });
    a.emit("CMD:playbackIssue", "not an object");
    await settle();
    expect(issues).toEqual([
      { userId: a.clientId, name: "Alex", reason: "HEVC not supported" },
    ]);
  });

  it("ignores reports when nothing is playing", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join("Alex");
    const issues: PlaybackIssue[] = [];
    a.on("REC:playbackIssue", (i: PlaybackIssue) => issues.push(i));
    a.emit("CMD:playbackIssue", { reason: "nothing" });
    await settle();
    expect(issues).toEqual([]);
  });
});
