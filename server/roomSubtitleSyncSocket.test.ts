import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { Room } from "./room.ts";

const V = "https://cdn.example.com/movie.mkv";
const K = "room:https://subs.example.com/movie.srt";

async function setup() {
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
  const room = new Room(io, db, "/subsync-room");
  const clients: ClientSocket[] = [];
  const join = async () => {
    const socket = connect(`http://127.0.0.1:${port}/subsync-room`, {
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
  return { room, io, db, join, close };
}

const collect = <T>(socket: ClientSocket, event: string) => {
  const list: T[] = [];
  socket.on(event, (v: T) => list.push(v));
  return list;
};

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** Two viewers in a room playing V with auto-sync on */
async function playing() {
  const t = await setup();
  const a = await t.join();
  const b = await t.join();
  a.emit("CMD:roomSettings", { autoSyncSubtitles: true });
  a.emit("CMD:host", V);
  await settle();
  return { ...t, a, b };
}

describe("Room subtitle auto-sync", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("lets one viewer compute it and applies the result for everyone", async () => {
    const t = await playing();
    cleanups.push(t.close);
    const aSync = collect<SubtitleSyncEvent>(t.a, "REC:subtitleSync");
    const bSync = collect<SubtitleSyncEvent>(t.b, "REC:subtitleSync");
    const aOffset = collect<{ offset: number; auto?: boolean }>(
      t.a,
      "REC:subtitleOffset",
    );
    const bOffset = collect<{ offset: number; auto?: boolean }>(
      t.b,
      "REC:subtitleOffset",
    );
    const chat = collect<ChatMessage>(t.b, "REC:chat");

    t.a.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle(30);
    t.b.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle();
    expect(aSync).toEqual([
      expect.objectContaining({ status: "running", video: V, key: K }),
    ]);
    expect(bSync).toEqual([
      expect.objectContaining({ status: "running" }),
      { status: "denied", video: V, key: K, reason: "busy" },
    ]);

    // b can't report a result for a's job
    t.b.emit("CMD:subtitleSync", {
      action: "result",
      video: V,
      key: K,
      offset: 9,
    });
    t.a.emit("CMD:subtitleSync", {
      action: "result",
      video: V,
      key: K,
      offset: 2.349,
      confidence: 0.6,
    });
    await settle();
    expect(aOffset).toEqual([
      expect.objectContaining({ offset: 2.35, auto: true }),
    ]);
    expect(bOffset).toEqual([
      expect.objectContaining({ offset: 2.35, auto: true }),
    ]);
    expect(bSync.at(-1)).toMatchObject({ status: "done", offset: 2.35 });
    expect(t.room.subtitleOffset).toBe(2.35);
    expect(chat.map((m) => [m.cmd, m.msg])).toContainEqual([
      "subtitleAutoSync",
      "2.35",
    ]);

    // Saved like a manual offset: the next load of this video brings it back (and won't auto-sync over it)
    const again = new Room(t.io, t.db, "/subsync-copy");
    again.preloadVideo(V);
    expect(again.subtitleOffset).toBe(2.35);
    again.destroy();
  });

  it("applies a time scale (frame-rate drift) with the offset", async () => {
    const t = await playing();
    cleanups.push(t.close);
    const bOffset = collect<{ offset: number; scale: number }>(
      t.b,
      "REC:subtitleOffset",
    );
    const bSync = collect<SubtitleSyncEvent>(t.b, "REC:subtitleSync");
    t.a.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle();
    t.a.emit("CMD:subtitleSync", {
      action: "result",
      video: V,
      key: K,
      offset: -1.2,
      scale: 0.959041,
    });
    await settle();
    expect(bOffset).toEqual([
      expect.objectContaining({ offset: -1.2, scale: 0.959041, auto: true }),
    ]);
    expect(t.room.subtitleScale).toBe(0.959041);
    expect(bSync.at(-1)).toMatchObject({
      status: "done",
      offset: -1.2,
      scale: 0.959041,
    });
  });

  it("keeps an offset set by hand", async () => {
    const t = await playing();
    cleanups.push(t.close);
    const aSync = collect<SubtitleSyncEvent>(t.a, "REC:subtitleSync");
    t.b.emit("CMD:subtitleOffset", 1.5);
    await settle();
    t.a.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle();
    expect(aSync).toEqual([
      { status: "denied", video: V, key: K, reason: "manual" },
    ]);
  });

  it("doesn't apply a result when someone set the offset meanwhile", async () => {
    const t = await playing();
    cleanups.push(t.close);
    const bSync = collect<SubtitleSyncEvent>(t.b, "REC:subtitleSync");
    t.a.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle();
    t.b.emit("CMD:subtitleOffset", -0.5);
    await settle();
    t.a.emit("CMD:subtitleSync", {
      action: "result",
      video: V,
      key: K,
      offset: 4,
    });
    await settle();
    expect(t.room.subtitleOffset).toBe(-0.5);
    expect(bSync.at(-1)).toMatchObject({ status: "done", offset: null });
  });

  it("releases the job when the computing viewer leaves", async () => {
    const t = await playing();
    cleanups.push(t.close);
    const bSync = collect<SubtitleSyncEvent>(t.b, "REC:subtitleSync");
    t.a.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle();
    t.a.disconnect();
    await settle();
    expect(bSync.at(-1)).toEqual({ status: "released", video: V, key: K });
    t.b.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle();
    expect(bSync.at(-1)).toMatchObject({ status: "running", key: K });
  });

  it("does nothing while the setting is off, and ignores junk", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    a.emit("CMD:host", V);
    await settle();
    const aSync = collect<SubtitleSyncEvent>(a, "REC:subtitleSync");
    a.emit("CMD:subtitleSync", null);
    a.emit("CMD:subtitleSync", { action: "claim", video: V });
    a.emit("CMD:subtitleSync", { action: "claim", video: V, key: K });
    await settle();
    expect(aSync).toEqual([
      { status: "denied", video: V, key: K, reason: "off" },
    ]);
  });
});
