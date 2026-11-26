import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { Room } from "./room.ts";

async function setup() {
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  // Everyone here is an owner (server.ts sets this from the session; guests are tested in roomAccessSocket.test.ts)
  io.on("new_namespace", (nsp) =>
    nsp.use((s, next) => {
      s.data.owner = true;
      next();
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const room = new Room(io, db, "/settings-room");
  const clients: ClientSocket[] = [];
  const join = async (before?: (s: ClientSocket) => void) => {
    const socket = connect(`http://127.0.0.1:${port}/settings-room`, {
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

describe("Room settings", () => {
  const cleanups: (() => Promise<void>)[] = [];
  const delay = Room.ROOM_SETTINGS_CHAT_DELAY_MS;
  beforeEach(() => {
    Room.ROOM_SETTINGS_CHAT_DELAY_MS = 100;
  });
  afterEach(async () => {
    Room.ROOM_SETTINGS_CHAT_DELAY_MS = delay;
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("sends the settings on connect", async () => {
    const t = await setup();
    cleanups.push(t.close);
    let initial: RoomSettings | undefined;
    await t.join((s) => s.on("REC:roomSettings", (v) => (initial ??= v)));
    await settle();
    expect(initial).toEqual({
      title: "",
      readyCheck: true,
      nextEpisodeOffset: 25,
      autoSyncSubtitles: false,
      skipIntro: 0,
    });
  });

  it("validates, merges and broadcasts a patch to everyone", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    const toA = next<RoomSettings>(a, "REC:roomSettings", (s) => s.readyCheck);
    const toB = next<RoomSettings>(b, "REC:roomSettings", (s) => s.readyCheck);
    a.emit("CMD:roomSettings", {
      title: "  Movie\u0000 night ",
      readyCheck: true,
      nextEpisodeOffset: 999,
      extra: "ignored",
    });
    const expected = {
      title: "Movie night",
      readyCheck: true,
      nextEpisodeOffset: 120,
      autoSyncSubtitles: false,
      skipIntro: 0,
    };
    expect(await toA).toEqual(expected);
    expect(await toB).toEqual(expected);
    expect(t.room.roomSettings).toEqual(expected);
  });

  it("ignores invalid and no-op patches", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    await settle();
    let count = 0;
    a.on("REC:roomSettings", () => count++);
    a.emit("CMD:roomSettings", null);
    a.emit("CMD:roomSettings", "title");
    a.emit("CMD:roomSettings", { readyCheck: "yes" });
    a.emit("CMD:roomSettings", { title: "", nextEpisodeOffset: 25 });
    await settle(150);
    expect(count).toBe(0);
    expect(t.room.roomSettings.title).toBe("");
  });

  it("announces a burst of edits once in chat, with the final value", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const chat: ChatMessage[] = [];
    a.on("REC:chat", (m: ChatMessage) => chat.push(m));
    a.emit("CMD:roomSettings", { nextEpisodeOffset: 26 });
    a.emit("CMD:roomSettings", { nextEpisodeOffset: 27 });
    a.emit("CMD:roomSettings", { nextEpisodeOffset: 30 });
    a.emit("CMD:roomSettings", { title: "Friday" });
    a.emit("CMD:roomSettings", { readyCheck: false });
    a.emit("CMD:roomSettings", { readyCheck: true });
    await settle(300);
    expect(chat.map((m) => [m.cmd, JSON.parse(m.msg ?? "")])).toEqual([
      ["roomSettings", { title: "Friday" }],
      ["roomSettings", { nextEpisodeOffset: 30 }],
    ]);
  });

  it("credits each person only with their own edits", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    const chat: ChatMessage[] = [];
    a.on("REC:chat", (m: ChatMessage) => chat.push(m));
    a.emit("CMD:roomSettings", { title: "Friday" });
    await settle(30);
    b.emit("CMD:roomSettings", { readyCheck: false });
    await settle(300);
    expect(chat.map((m) => JSON.parse(m.msg ?? ""))).toEqual([
      { title: "Friday" },
      { readyCheck: false },
    ]);
    expect(chat[0].id).not.toBe(chat[1].id);
  });

  it("serializes with the room; old rooms get the default", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const got = next<RoomSettings>(a, "REC:roomSettings", (s) => !s.readyCheck);
    a.emit("CMD:roomSettings", { title: "Saved", readyCheck: false });
    await got;
    const data = t.room.serialize();
    const loaded = new Room(t.io, t.db, "/settings-copy", data);
    expect(loaded.roomSettings).toEqual({
      title: "Saved",
      readyCheck: false,
      nextEpisodeOffset: 25,
      autoSyncSubtitles: false,
      skipIntro: 0,
    });
    loaded.destroy();

    const old = JSON.parse(data);
    delete old.roomSettings;
    const legacy = new Room(t.io, t.db, "/settings-old", JSON.stringify(old));
    // Rooms saved before room settings existed get the current default (ready check on)
    expect(legacy.roomSettings).toEqual({
      title: "",
      readyCheck: true,
      nextEpisodeOffset: 25,
      autoSyncSubtitles: false,
      skipIntro: 0,
    });
    legacy.destroy();
  });
});
