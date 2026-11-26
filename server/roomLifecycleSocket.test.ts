// Socket tests for the room lifecycle: automatic video changes in chat, and owners deleting a room.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { getRoom, openDatabase } from "./utils/db.ts";
import { Room } from "./room.ts";

const ROOM = "lifecycle-room";
const VIDEO = "https://example.com/first.mp4";
const QUEUED = "https://aio.example.com/api/v1/debrid/playback/blob/spring.mkv";
const QUEUED_META: VideoMeta = {
  source: "aiostreams",
  type: "movie",
  id: "tt0000002",
  imdbId: "tt0000002",
  season: null,
  episode: null,
  title: "Spring",
  episodeTitle: null,
  poster: null,
  bingeGroup: null,
};

async function setup() {
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  // Sockets whose clientId starts with "0" are guests, everyone else is an owner (app.ts sets this from the session)
  io.on("new_namespace", (nsp) =>
    nsp.use((s, next) => {
      const id = String(s.handshake.query.clientId);
      s.data.owner = !id.startsWith("0");
      next();
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const room = new Room(io, db, "/" + ROOM);
  room.saveRoom();
  const deleted: string[] = [];
  Room.onDeleted = (id) => deleted.push(id);
  const clients: ClientSocket[] = [];
  const join = async (opts: { guest?: boolean; name?: string } = {}) => {
    const clientId = (opts.guest ? "0" : "1") + randomUUID().slice(1);
    const socket = connect(`http://127.0.0.1:${port}/${ROOM}`, {
      transports: ["websocket"],
      query: { clientId },
      auth: { sessionId: randomUUID() + randomUUID() },
      forceNew: true,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    if (opts.name) {
      socket.emit("CMD:name", opts.name);
    }
    return { socket, clientId };
  };
  const close = async () => {
    Room.onDeleted = null;
    clients.forEach((c) => c.disconnect());
    room.destroy();
    io.close();
    db.close();
    await new Promise((r) => server.close(r));
  };
  return { room, io, db, join, close, deleted };
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

describe("Room lifecycle", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("posts a chat line without a person when the queue advances on its own", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const { socket: a } = await t.join({ name: "Alex" });
    a.emit("CMD:host", VIDEO);
    await settle();
    a.emit("CMD:playlistAdd", {
      url: QUEUED,
      name: "Spring",
      meta: QUEUED_META,
    });
    await settle();
    const line = next<ChatMessage>(
      a,
      "REC:chat",
      (m) => m.cmd === "nowPlaying",
    );
    a.emit("CMD:playlistNext", VIDEO);
    const msg = await line;
    expect(msg.id).toBe("");
    expect(JSON.parse(msg.msg!)).toEqual({ via: "queue", title: "Spring" });
    expect(JSON.stringify(msg)).not.toContain("aio.example.com");
    expect(t.room.video).toBe(QUEUED);
  });

  it("keeps the person's line for a video they chose", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const { socket: a, clientId } = await t.join();
    const line = next<ChatMessage>(a, "REC:chat");
    a.emit("CMD:host", VIDEO);
    expect(await line).toMatchObject({ id: clientId, cmd: "host", msg: VIDEO });
  });

  it("owners delete the room: everyone is told and disconnected, the rows are gone", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const { socket: owner, clientId } = await t.join({ name: "Alex" });
    const { socket: guest } = await t.join({ guest: true });
    await settle();
    t.db
      .prepare(
        `INSERT INTO history (roomId, itemKey, groupKey, kind, title, url, position, updatedAt)
         VALUES (?, 'k', 'g', 'url', 'T', 'https://example.com/x.mp4', 30, 1)`,
      )
      .run("/" + ROOM);
    const toGuest = next<RoomDeletedInfo>(guest, "REC:roomDeleted");
    const guestGone = next<string>(guest, "disconnect");
    const toOwner = next<RoomDeletedInfo>(owner, "REC:roomDeleted");
    owner.emit("CMD:deleteRoom");
    expect(await toGuest).toEqual({ by: { id: clientId, name: "Alex" } });
    expect((await toOwner).by?.id).toBe(clientId);
    expect(await guestGone).toBe("io server disconnect");
    expect(getRoom(t.db, "/" + ROOM)).toBeUndefined();
    expect(
      t.db.prepare("SELECT COUNT(*) AS n FROM history").get(),
    ).toMatchObject({ n: 0 });
    expect(t.deleted).toEqual(["/" + ROOM]);
    // The namespace is gone (and isn't recreated by the disconnects)
    await settle();
    expect(t.io._nsps.has("/" + ROOM)).toBe(false);
    // Nothing writes it back
    t.room.saveRoom();
    expect(getRoom(t.db, "/" + ROOM)).toBeUndefined();
  });

  it("guests can't delete the room", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const { socket: guest } = await t.join({ guest: true });
    const err = next<string>(guest, "errorMessage");
    guest.emit("CMD:deleteRoom");
    expect(await err).toMatch(/owner/);
    await settle();
    expect(getRoom(t.db, "/" + ROOM)).toBeDefined();
    expect(t.deleted).toEqual([]);
  });
});
