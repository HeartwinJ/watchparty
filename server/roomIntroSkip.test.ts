// Skip intro (roomSettings.skipIntro): where each kind of host change starts, the undo for short videos, the notice
// events and the watch history.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { listHistory } from "./utils/history.ts";
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
  bingeGroup: null,
};
const nextMeta: VideoMeta = { ...meta, id: "tt0000001:1:3", episode: 3 };
const EP2 = "https://aio.example.com/playback/two.mkv#wp-name=Two";
const EP3 = "https://aio.example.com/playback/three.mkv#wp-name=Three";

async function setup(resolver: NextEpisodeResolver | null = null) {
  Room.nextEpisodeResolver = resolver;
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  io.on("new_namespace", (nsp) =>
    nsp.use((s, next) => {
      s.data.owner = true;
      next();
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const room = new Room(io, db, "/intro-room");
  room.roomSettings = { ...room.roomSettings, skipIntro: 90 };
  const clients: ClientSocket[] = [];
  const join = async () => {
    const socket = connect(`http://127.0.0.1:${port}/intro-room`, {
      transports: ["websocket"],
      query: { clientId: randomUUID() },
      auth: { sessionId: randomUUID() + randomUUID() },
      forceNew: true,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
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
  return { room, db, join, close };
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

/** Records every event of one kind a socket receives */
const record = <T>(socket: ClientSocket, event: string) => {
  const got: T[] = [];
  socket.on(event, (v: T) => got.push(v));
  return got;
};

describe("Room skip intro", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("starts a picked video past the intro and tells everyone", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    const host = next<HostState>(b, "REC:host", (h) => h.video === EP2);
    const skip = next<IntroSkipInfo | null>(b, "REC:introSkip");
    a.emit("CMD:host", EP2);
    expect((await host).videoTS).toBe(90);
    expect(await skip).toEqual({ seconds: 90 });
    expect(t.room.videoTS).toBe(90);
  });

  it("starts at 0 when the setting is off, and for screen shares", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const skips = record<IntroSkipInfo | null>(a, "REC:introSkip");
    t.room.roomSettings = { ...t.room.roomSettings, skipIntro: 0 };
    a.emit("CMD:host", EP2);
    await settle();
    expect(t.room.videoTS).toBe(0);

    t.room.roomSettings = { ...t.room.roomSettings, skipIntro: 90 };
    a.emit("CMD:joinScreenShare", { file: false });
    await settle();
    expect(t.room.video).toMatch(/^screenshare:\/\//);
    expect(t.room.videoTS).toBe(0);
    a.emit("CMD:leaveScreenShare");
    a.emit("CMD:joinScreenShare", { file: true });
    await settle();
    expect(t.room.video).toMatch(/^fileshare:\/\//);
    expect(t.room.videoTS).toBe(0);
    expect(skips).toEqual([]);
  });

  it("starts queue items past the intro, except a YouTube item known to be short", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:playlistAdd", { url: EP2, name: "Two" });
    await settle();
    expect(t.room.video).toBe(EP2);
    expect(t.room.videoTS).toBe(90);

    t.room.playlist.push({
      name: "Short clip",
      channel: "YouTube",
      duration: 200,
      url: "https://www.youtube.com/watch?v=short",
      type: "youtube",
    });
    a.emit("CMD:playlistNext", EP2);
    await settle();
    expect(t.room.video).toBe("https://www.youtube.com/watch?v=short");
    expect(t.room.videoTS).toBe(0);
  });

  it("starts the next episode past the intro", async () => {
    const t = await setup(async () => ({
      kind: "found",
      meta: nextMeta,
      thumbnail: null,
      url: EP3,
    }));
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", EP2);
    await settle();
    a.emit("CMD:videoMeta", { url: EP2, meta });
    a.emit("CMD:nextEpisode", {
      action: "offer",
      url: EP2,
      time: 1420,
      duration: 1440,
    });
    await settle();
    const host = next<HostState>(a, "REC:host", (h) => h.video === EP3);
    a.emit("CMD:nextEpisode", { action: "playNow" });
    expect((await host).videoTS).toBe(90);
  });

  it("keeps a resume position (preloadVideo)", async () => {
    const t = await setup();
    cleanups.push(t.close);
    t.room.preloadVideo(EP2, meta, 1234);
    expect(t.room.videoTS).toBe(1234);
    t.room.preloadVideo(EP3, null, 0);
    expect(t.room.videoTS).toBe(0);
  });

  it("undoes the skip when the video turns out short and nobody touched playback", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    a.emit("CMD:host", EP2);
    await settle();
    const seek = next<number>(b, "REC:seek");
    const cleared = next<IntroSkipInfo | null>(b, "REC:introSkip");
    // Players that started past the end sit paused at it: the room resumes them
    const resumed = next<string>(b, "REC:play");
    a.emit("CMD:duration", 200);
    expect(await seek).toBe(0);
    expect(await cleared).toBeNull();
    expect(await resumed).toBe(EP2);
    expect(t.room.videoTS).toBe(0);
    // Not a person's seek: no chat line
    expect(t.room.serialize()).not.toContain('"cmd":"seek"');
  });

  it("ignores an 'ended' from the start past the end right after the undo", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", EP2);
    await settle(1100);
    a.emit("CMD:playlistAdd", { url: EP3, name: "Three" });
    await settle();
    // Adding to the queue while something plays doesn't change the video
    expect(t.room.video).toBe(EP2);
    a.emit("CMD:duration", 60);
    // A player that sat at the end of the 60 s video reports it a moment later: not a real end
    a.emit("CMD:playlistNext", EP2);
    await settle();
    expect(t.room.video).toBe(EP2);
    expect(t.room.videoTS).toBe(0);
  });

  it("keeps the skip for a long video, or once someone paused", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const seeks = record<number>(a, "REC:seek");
    a.emit("CMD:host", EP2);
    await settle();
    a.emit("CMD:duration", 1440);
    await settle();
    expect(t.room.videoTS).toBe(90);

    a.emit("CMD:host", EP3);
    await settle();
    a.emit("CMD:pause");
    a.emit("CMD:duration", 200);
    await settle();
    expect(t.room.videoTS).toBe(90);
    expect(seeks).toEqual([]);
  });

  it("hides the notice when someone seeks (Watch from start)", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    a.emit("CMD:host", EP2);
    await settle();
    const cleared = next<IntroSkipInfo | null>(a, "REC:introSkip");
    b.emit("CMD:seek", 0);
    expect(await cleared).toBeNull();
    expect(t.room.videoTS).toBe(0);
  });

  it("hides the notice for a live stream (negative room time)", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", "https://example.com/live.m3u8");
    await settle(1100); // reports are ignored for a second after a host change
    const cleared = next<IntroSkipInfo | null>(a, "REC:introSkip");
    a.emit("CMD:ts", -5);
    expect(await cleared).toBeNull();
  });

  it("doesn't record the skipped intro as watched", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", EP2);
    await settle();
    a.emit("CMD:videoMeta", { url: EP2, meta });
    a.emit("CMD:duration", 1440);
    a.emit("CMD:pause");
    await settle();
    expect(listHistory(t.db)).toEqual([]);

    // Watching on past the skip point counts again
    a.emit("CMD:play");
    await settle(1100);
    a.emit("CMD:ts", 130);
    await settle();
    a.emit("CMD:pause");
    await settle();
    expect(listHistory(t.db)).toMatchObject([{ position: 130 }]);
  });
});

describe("seeking", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("forgets old positions so the room isn't pulled back to them", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    a.emit("CMD:host", EP2);
    await new Promise((r) => setTimeout(r, 1100));
    a.emit("CMD:ts", 120);
    b.emit("CMD:ts", 120);
    await settle();
    const cleared = next<NumberDict>(a, "REC:tsMap");
    b.emit("CMD:seek", 10);
    expect(await cleared).toEqual({});
    // A position a player sent before it got the seek
    a.emit("CMD:ts", 121);
    await settle();
    expect(t.room.videoTS).toBe(10);
  });
});
