// Socket-level tests for Room handlers: a real Socket.IO server on a random port with socket.io-client clients.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { DatabaseSync } from "node:sqlite";
import { getSubtitleOffset, openDatabase } from "./utils/db.ts";
import { subtitleOffsetKey } from "./utils/subtitleOffset.ts";
import { Room } from "./room.ts";

const ROOM_ID = "/test-room";
const VIDEO = "https://example.com/movie.mp4";

let io: Server;
let db: DatabaseSync;
let room: Room;
let port: number;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  const http = createServer();
  io = new Server(http);
  db = openDatabase(":memory:");
  room = new Room(io, db, ROOM_ID);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  port = (http.address() as AddressInfo).port;
  Room.SUBTITLE_OFFSET_CHAT_DELAY_MS = 50;
});

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect());
  room.destroy();
  await new Promise<void>((resolve) => io.close(() => resolve()));
  db.close();
  Room.SUBTITLE_OFFSET_CHAT_DELAY_MS = 1500;
});

async function connect(name?: string) {
  const clientId = randomUUID();
  const socket = ioClient(`http://localhost:${port}${ROOM_ID}`, {
    transports: ["websocket"],
    query: { clientId },
    auth: { sessionId: randomUUID() + randomUUID() },
    forceNew: true,
  });
  clients.push(socket);
  const host = new Promise<HostState>((resolve) =>
    socket.once("REC:host", resolve),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const hostState = await host;
  if (name) {
    const named = new Promise((resolve) => socket.once("REC:nameMap", resolve));
    socket.emit("CMD:name", name);
    await named;
  }
  return { socket, clientId, hostState };
}

function next<T = unknown>(socket: ClientSocket, event: string) {
  return new Promise<T[]>((resolve) =>
    socket.once(event, (...args: T[]) => resolve(args)),
  );
}

/** Resolves false if the event doesn't arrive within ms */
function nothing(socket: ClientSocket, event: string, ms = 150) {
  return new Promise<boolean>((resolve) => {
    const fn = () => resolve(false);
    socket.once(event, fn);
    setTimeout(() => {
      socket.off(event, fn);
      resolve(true);
    }, ms);
  });
}

describe("REC:play / REC:pause actor", () => {
  it("includes who played or paused, keeping the old first argument", async () => {
    const alex = await connect("Alex");
    const sam = await connect("Sam");
    const host = next(sam.socket, "REC:host");
    alex.socket.emit("CMD:host", VIDEO);
    await host;

    const play = next(sam.socket, "REC:play");
    alex.socket.emit("CMD:play");
    expect(await play).toEqual([VIDEO, { id: alex.clientId, name: "Alex" }]);

    const pause = next(sam.socket, "REC:pause");
    alex.socket.emit("CMD:pause");
    expect(await pause).toEqual([{ id: alex.clientId, name: "Alex" }]);
    expect(room.paused).toBe(true);
  });

  it("isn't echoed back to the sender", async () => {
    const alex = await connect("Alex");
    await connect("Sam");
    const echoed = nothing(alex.socket, "REC:pause");
    alex.socket.emit("CMD:pause");
    expect(await echoed).toBe(true);
  });
});

describe("CMD:subtitleOffset", () => {
  it("validates, clamps, rounds and broadcasts to the others", async () => {
    const alex = await connect("Alex");
    const sam = await connect("Sam");

    let rec = next<{ offset: number; actor: PlaybackActor }>(
      sam.socket,
      "REC:subtitleOffset",
    );
    alex.socket.emit("CMD:subtitleOffset", 0.32);
    expect((await rec)[0]).toEqual({
      offset: 0.3,
      actor: { id: alex.clientId, name: "Alex" },
    });
    expect(room.subtitleOffset).toBe(0.3);

    rec = next(sam.socket, "REC:subtitleOffset");
    alex.socket.emit("CMD:subtitleOffset", 99);
    expect((await rec)[0].offset).toBe(30);

    rec = next(sam.socket, "REC:subtitleOffset");
    alex.socket.emit("CMD:subtitleOffset", -45.5);
    expect((await rec)[0].offset).toBe(-30);
  });

  it("ignores invalid payloads", async () => {
    const alex = await connect();
    const sam = await connect();
    const ignored = nothing(sam.socket, "REC:subtitleOffset");
    alex.socket.emit("CMD:subtitleOffset", "1");
    alex.socket.emit("CMD:subtitleOffset", null);
    alex.socket.emit("CMD:subtitleOffset", { offset: 1 });
    // NaN/Infinity become null over JSON
    alex.socket.emit("CMD:subtitleOffset", NaN);
    expect(await ignored).toBe(true);
    expect(room.subtitleOffset).toBe(0);
  });

  it("posts one system chat line once the offset stops changing", async () => {
    const alex = await connect("Alex");
    const sam = await connect();
    const chats: ChatMessage[] = [];
    sam.socket.on("REC:chat", (m: ChatMessage) => chats.push(m));
    alex.socket.emit("CMD:subtitleOffset", 0.1);
    alex.socket.emit("CMD:subtitleOffset", 0.2);
    alex.socket.emit("CMD:subtitleOffset", 0.3);
    await new Promise((r) => setTimeout(r, 300));
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      id: alex.clientId,
      cmd: "subtitleOffset",
      msg: "0.3",
    });
  });

  it("is saved per video in SQLite and restored when that video loads again", async () => {
    const alex = await connect();
    const sam = await connect();
    let host = next<HostState>(sam.socket, "REC:host");
    alex.socket.emit("CMD:host", VIDEO);
    expect((await host)[0].subtitleOffset).toBe(0);

    const rec = next(sam.socket, "REC:subtitleOffset");
    alex.socket.emit("CMD:subtitleOffset", -1.5);
    await rec;
    expect(getSubtitleOffset(db, subtitleOffsetKey(VIDEO)!)).toBe(-1.5);

    // Another video starts at 0...
    host = next<HostState>(sam.socket, "REC:host");
    alex.socket.emit("CMD:host", "https://example.com/other.mp4");
    expect((await host)[0].subtitleOffset).toBe(0);

    // ...and the first one comes back with its offset
    host = next<HostState>(sam.socket, "REC:host");
    alex.socket.emit("CMD:host", VIDEO);
    expect((await host)[0].subtitleOffset).toBe(-1.5);

    // New joiners get it too
    const late = await connect();
    expect(late.hostState.subtitleOffset).toBe(-1.5);
  });

  it("is serialized with the room", async () => {
    room.subtitleOffset = 2.5;
    const loaded = new Room(io, db, "/other-room", room.serialize());
    expect(loaded.subtitleOffset).toBe(2.5);
    loaded.destroy();
    const garbage = new Room(
      io,
      db,
      "/third-room",
      JSON.stringify({ video: "", subtitleOffset: "lots" }),
    );
    expect(garbage.subtitleOffset).toBe(0);
    garbage.destroy();
  });
});
