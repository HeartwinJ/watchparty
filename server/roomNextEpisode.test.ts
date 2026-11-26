import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { Room } from "./room.ts";
import type { NextEpisodeResolver } from "./addons/nextEpisode.ts";

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
const nextMeta: VideoMeta = {
  ...meta,
  id: "tt0000001:1:3",
  episode: 3,
  episodeTitle: "Third",
};
const STREAM = "https://aio.example.com/playback/two.mkv#wp-name=Example";
const NEXT_STREAM = "https://aio.example.com/playback/three.mkv#wp-name=Next";

async function setup(resolver: NextEpisodeResolver | null) {
  Room.nextEpisodeResolver = resolver;
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const room = new Room(io, db, "/next-room");
  const clients: ClientSocket[] = [];
  const join = async (name?: string, before?: (s: ClientSocket) => void) => {
    const socket = connect(`http://127.0.0.1:${port}/next-room`, {
      transports: ["websocket"],
      query: { clientId: randomUUID() },
      auth: { sessionId: randomUUID() + randomUUID() },
      forceNew: true,
    });
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
    Room.nextEpisodeResolver = null;
  };
  return { room, join, close };
}

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

const found: NextEpisodeResolver = async () => ({
  kind: "found",
  meta: nextMeta,
  thumbnail: "https://images.example/e3.jpg",
  url: NEXT_STREAM,
});

describe("Room next episode", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  /** Two viewers watching episode 2 */
  async function watching(resolver: NextEpisodeResolver | null = found) {
    const t = await setup(resolver);
    cleanups.push(t.close);
    const a = await t.join("Alex");
    const b = await t.join("Sam");
    a.emit("CMD:host", STREAM);
    await settle();
    a.emit("CMD:videoMeta", { url: STREAM, meta });
    await settle();
    return { ...t, a, b };
  }

  it("offers the next episode to everyone, without the stream URL", async () => {
    const t = await watching();
    const offered = next<NextEpisodeState>(
      t.b,
      "REC:nextEpisode",
      (s) => s.state === "offered",
    );
    t.a.emit("CMD:nextEpisode", {
      action: "offer",
      url: STREAM,
      time: 1180,
      duration: 1200,
    });
    const s = await offered;
    expect(s).toEqual({
      state: "offered",
      next: { meta: nextMeta, thumbnail: "https://images.example/e3.jpg" },
      startAt: 1200,
    });
    expect(JSON.stringify(s)).not.toContain("three.mkv");

    // A late joiner sees the card too
    let onJoin: Promise<NextEpisodeState> | undefined;
    await t.join(undefined, (sock) => {
      onJoin = next(sock, "REC:nextEpisode");
    });
    expect((await onJoin)?.state).toBe("offered");
  });

  it("anyone's Cancel cancels it for the room, saying who", async () => {
    const t = await watching();
    t.a.emit("CMD:nextEpisode", {
      action: "offer",
      url: STREAM,
      time: 1180,
      duration: 1200,
    });
    await settle();
    const cancelled = next<NextEpisodeState>(
      t.a,
      "REC:nextEpisode",
      (s) => s.state === "cancelled",
    );
    t.b.emit("CMD:nextEpisode", { action: "cancel" });
    expect(await cancelled).toMatchObject({ by: { name: "Sam" } });
    // Reaching the end doesn't start it anymore
    t.a.emit("CMD:ts", 1200);
    await settle();
    expect(t.room.video).toBe(STREAM);
  });

  it("Play now hosts the next episode with its metadata", async () => {
    const t = await watching();
    t.a.emit("CMD:nextEpisode", {
      action: "offer",
      url: STREAM,
      time: 1180,
      duration: 1200,
    });
    await settle();
    const host = next<HostState>(t.a, "REC:host", (h) => h.video !== STREAM);
    const videoMeta = next<VideoMeta | null>(t.a, "REC:videoMeta", (m) =>
      Boolean(m && m.episode === 3),
    );
    t.b.emit("CMD:nextEpisode", { action: "playNow" });
    expect((await host).video).toBe(NEXT_STREAM);
    expect(await videoMeta).toEqual(nextMeta);
    expect(t.room.videoMeta).toEqual(nextMeta);
  });

  it("starts when the room reaches the end", async () => {
    const t = await watching();
    t.a.emit("CMD:nextEpisode", {
      action: "offer",
      url: STREAM,
      time: 1180,
      duration: 1200,
    });
    await settle();
    // preventTSUpdate is on for 1 s after hosting
    await settle(1000);
    const host = next<HostState>(t.b, "REC:host");
    t.a.emit("CMD:ts", 1200);
    expect((await host).video).toBe(NEXT_STREAM);
  });

  it("uses the room's nextEpisodeOffset setting", async () => {
    const resolver = vi.fn(found);
    const t = await watching(resolver);
    const offer = (time: number) =>
      t.a.emit("CMD:nextEpisode", {
        action: "offer",
        url: STREAM,
        time,
        duration: 1200,
      });
    offer(1140); // 60 s before the end: outside the default 25 s window
    await settle();
    expect(resolver).not.toHaveBeenCalled();
    t.room.roomSettings.nextEpisodeOffset = 60;
    offer(1140);
    await settle();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("does nothing without AIOStreams or with a queue", async () => {
    const t = await watching(null);
    const spy = vi.fn();
    t.b.on("REC:nextEpisode", spy);
    t.a.emit("CMD:nextEpisode", {
      action: "offer",
      url: STREAM,
      time: 1180,
      duration: 1200,
    });
    await settle();
    expect(spy).not.toHaveBeenCalled();

    const resolver = vi.fn(found);
    Room.nextEpisodeResolver = resolver;
    t.a.emit("CMD:playlistAdd", "https://v.example.com/queued.mp4");
    await settle();
    t.a.emit("CMD:nextEpisode", {
      action: "offer",
      url: STREAM,
      time: 1180,
      duration: 1200,
    });
    await settle();
    expect(resolver).not.toHaveBeenCalled();
  });
});
