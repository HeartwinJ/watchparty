// The room records watch history (utils/history.ts) on seek/pause, host changes and the end of a video.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { listHistory } from "./utils/history.ts";
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
  bingeGroup: null,
};
const STREAM = "https://aio.example.com/api/v1/debrid/playback/eyFAKE/one.mkv";

async function setup() {
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const room = new Room(io, db, "/history-room");
  const clients: ClientSocket[] = [];
  const join = async () => {
    const socket = connect(`http://127.0.0.1:${port}/history-room`, {
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
  };
  return { room, db, join, close };
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("Room history", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("records AIOStreams picks by title/episode on seek and pause, with the reported duration", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", STREAM);
    await settle();
    a.emit("CMD:videoMeta", { url: STREAM, meta });
    a.emit("CMD:duration", 1000);
    a.emit("CMD:seek", 300);
    await settle();
    let [item] = listHistory(t.db);
    expect(item).toMatchObject({
      roomId: "/history-room",
      kind: "aiostreams",
      title: "Example Show",
      subtitle: "S01E02 · Second",
      position: 300,
      duration: 1000,
      finished: false,
    });
    expect(JSON.stringify(item)).not.toContain("aio.example.com");

    a.emit("CMD:seek", 950);
    a.emit("CMD:pause");
    await settle();
    [item] = listHistory(t.db);
    expect(item).toMatchObject({ position: 950, finished: true });
  });

  it("saves the outgoing video on a host change, and marks it finished when it ended", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", "https://example.com/first.mp4");
    // Timestamps are ignored for 1 s after a host change
    await settle(1100);
    a.emit("CMD:ts", 120);
    await settle();
    a.emit("CMD:playlistAdd", {
      url: "https://example.com/second.mp4",
      name: "Second clip",
    });
    await settle();
    // first.mp4 ended (no duration known): the client advances the queue with the ended URL
    a.emit("CMD:playlistNext", "https://example.com/first.mp4");
    await settle(1100);
    a.emit("CMD:ts", 40);
    await settle();
    a.emit("CMD:pause");
    await settle();
    const items = listHistory(t.db);
    expect(items.map((i) => [i.title, i.position, i.finished])).toEqual([
      ["Second clip", 40, false],
      ["first.mp4", 120, true],
    ]);
  });

  it("ignores screen shares and bad duration reports", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:joinScreenShare", { file: false });
    await settle();
    a.emit("CMD:duration", "lots");
    a.emit("CMD:seek", 100);
    a.emit("CMD:pause");
    await settle();
    expect(listHistory(t.db)).toEqual([]);
  });

  it("preloadVideo starts paused at the position with the metadata", async () => {
    const t = await setup();
    cleanups.push(t.close);
    t.room.preloadVideo(STREAM, meta, 600);
    const a = await t.join();
    const host = await new Promise<HostState>((r) => {
      a.emit("CMD:askHost");
      a.once("REC:host", r);
    });
    expect(host).toMatchObject({ video: STREAM, videoTS: 600, paused: true });
    expect(t.room.videoMeta).toEqual(meta);
  });
});
