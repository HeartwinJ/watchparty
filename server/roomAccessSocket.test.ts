// Room passwords end to end over Socket.IO: namespace admission (app.ts wiring via admitRoomSockets), owner-only
// commands, REC:roomAccess, password changes revoking guests, and kicks revoking a guest's grant.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { getRoom, openDatabase, saveRoomData } from "./utils/db.ts";
import { Room } from "./room.ts";
import { createAuth } from "./utils/auth.ts";
import { admitRoomSockets, createRoomAuth } from "./utils/roomAuth.ts";
import {
  GUEST_COOKIE,
  newGuestId,
  signGuestGrants,
} from "./utils/guestToken.ts";
import { SESSION_COOKIE, signSession } from "./utils/session.ts";

const SECRET = "socket-test-secret";
const ROOM = "/movie-night-room";

async function setup() {
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const auth = createAuth({ password: "instance-pw", sessionSecret: SECRET });
  const rooms = new Map<string, Room>();
  const roomAuth = createRoomAuth({
    auth,
    guestKey: auth.guestKey,
    getRoom: (id) => {
      const r = rooms.get(id);
      return r ? { access: r.access, title: r.roomSettings.title } : undefined;
    },
  });
  // Must run before any room's namespace exists, like in app.ts
  admitRoomSockets(io, roomAuth);
  const room = new Room(io, db, ROOM);
  rooms.set(ROOM, room);

  const ownerCookie = `${SESSION_COOKIE}=${signSession(SECRET)}`;
  const guestCookie = (guestId = newGuestId(), epoch = room.access.epoch) => ({
    guestId,
    cookie: `${GUEST_COOKIE}=${signGuestGrants(auth.guestKey, [
      { roomId: ROOM, epoch, guestId, expiresAt: Date.now() + 60_000 },
    ])}`,
  });

  const clients: ClientSocket[] = [];
  const open = (cookie?: string, before?: (s: ClientSocket) => void) => {
    const socket = connect(`http://127.0.0.1:${port}${ROOM}`, {
      transports: ["websocket"],
      query: { clientId: randomUUID() },
      auth: { sessionId: randomUUID() + randomUUID() },
      extraHeaders: cookie ? { cookie } : {},
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    before?.(socket);
    return socket;
  };
  /** Resolves with the socket once connected, rejects with the connect_error */
  const join = async (cookie?: string, before?: (s: ClientSocket) => void) => {
    const socket = open(cookie, before);
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
  return {
    io,
    db,
    room,
    rooms,
    port,
    ownerCookie,
    guestCookie,
    join,
    open,
    close,
  };
}

const next = <T = unknown>(socket: ClientSocket, event: string) =>
  new Promise<T>((resolve) => socket.once(event, (v: T) => resolve(v)));
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
});

describe("room namespace admission", () => {
  it("admits owners and valid guests, refuses everyone else with 'unauthorized'", async () => {
    const t = await setup();
    cleanups.push(t.close);
    await t.join(t.ownerCookie);
    await t.join(t.guestCookie().cookie);
    await expect(t.join()).rejects.toThrow("unauthorized");
    // A guest grant from another epoch (the password changed since)
    await expect(
      t.join(t.guestCookie(undefined, t.room.access.epoch + 1).cookie),
    ).rejects.toThrow("unauthorized");
    // A guest cookie for another room
    const other = `${GUEST_COOKIE}=${signGuestGrants(
      createAuth({ password: "x", sessionSecret: SECRET }).guestKey,
      [
        {
          roomId: "/other-room-x",
          epoch: 0,
          guestId: newGuestId(),
          expiresAt: Date.now() + 60_000,
        },
      ],
    )}`;
    await expect(t.join(other)).rejects.toThrow("unauthorized");
  });

  it("admits anyone while the room's password is off", async () => {
    const t = await setup();
    cleanups.push(t.close);
    t.room.access.apply({ action: "enable", enabled: false });
    await t.join();
  });

  it("the main namespace is for owners only", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const main = (cookie?: string) => {
      const s = connect(`http://127.0.0.1:${t.port}/`, {
        transports: ["websocket"],
        extraHeaders: cookie ? { cookie } : {},
        forceNew: true,
        reconnection: false,
      });
      return new Promise<void>((resolve, reject) => {
        s.once("connect", () => {
          s.disconnect();
          resolve();
        });
        s.once("connect_error", (e) => {
          s.disconnect();
          reject(e);
        });
      });
    };
    await main(t.ownerCookie);
    await expect(main(t.guestCookie().cookie)).rejects.toThrow("unauthorized");
  });
});

describe("REC:roomAccess", () => {
  it("owners get the password, guests only whether it's on", async () => {
    const t = await setup();
    cleanups.push(t.close);
    let ownerInfo: RoomAccessInfo | undefined;
    let guestInfo: RoomAccessInfo | undefined;
    await t.join(t.ownerCookie, (s) =>
      s.on("REC:roomAccess", (v) => (ownerInfo = v)),
    );
    const guest = await t.join(t.guestCookie().cookie, (s) =>
      s.on("REC:roomAccess", (v) => (guestInfo = v)),
    );
    await settle();
    expect(ownerInfo).toEqual({
      enabled: true,
      password: t.room.access.password,
    });
    expect(guestInfo).toEqual({ enabled: true });
    // Nothing a guest receives on connect contains the password
    const seen: string[] = [];
    const spy = await t.join(t.guestCookie().cookie, (s) =>
      s.onAny((event, ...args) => seen.push(JSON.stringify([event, args]))),
    );
    await settle();
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.join("\n")).not.toContain(t.room.access.password);
    guest.disconnect();
    spy.disconnect();
  });
});

describe("owner-only commands", () => {
  it("guests can't change settings, the password, kick or delete chat", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.ownerCookie);
    const guest = await t.join(t.guestCookie().cookie);
    const errors: string[] = [];
    guest.on("errorMessage", (m: string) => errors.push(m));
    const before = t.room.access.serialize();

    guest.emit("CMD:chat", "hello");
    await settle();
    guest.emit("CMD:roomSettings", { title: "Guest title" });
    guest.emit("CMD:roomPassword", { action: "enable", enabled: false });
    guest.emit("CMD:roomPassword", { action: "set", password: "guest-pass" });
    guest.emit("CMD:deleteChatMessages", {});
    guest.emit("CMD:kickUser", {
      userToBeKicked: (owner.io.opts.query as { clientId: string }).clientId,
    });
    await settle(150);

    expect(t.room.roomSettings.title).toBe("");
    expect(t.room.access.serialize()).toEqual(before);
    expect(owner.connected).toBe(true);
    expect(JSON.parse(t.room.serialize()).chat).toHaveLength(1);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toMatch(/owner/);
  });

  it("guests can still play, pause, seek, chat and change the video", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.ownerCookie);
    const guest = await t.join(t.guestCookie().cookie);
    const hosted = next<HostState>(owner, "REC:host");
    guest.emit("CMD:host", "https://example.com/video.mp4");
    expect((await hosted).video).toBe("https://example.com/video.mp4");
    const paused = next(owner, "REC:pause");
    guest.emit("CMD:pause");
    await paused;
    const seeked = next<number>(owner, "REC:seek");
    guest.emit("CMD:seek", 42);
    expect(await seeked).toBe(42);
    const chat = next<ChatMessage>(owner, "REC:chat");
    guest.emit("CMD:chat", "hi from a guest");
    expect((await chat).msg).toBe("hi from a guest");
  });
});

describe("changing the room password", () => {
  it("owners can change it; guests are disconnected and can't reconnect with the old grant", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.ownerCookie);
    const { cookie } = t.guestCookie();
    const guest = await t.join(cookie);
    const revoked = next(guest, "REC:accessRevoked");
    const disconnected = next<string>(guest, "disconnect");
    const access = next<RoomAccessInfo>(owner, "REC:roomAccess");
    const chat = next<ChatMessage>(owner, "REC:chat");

    owner.emit("CMD:roomPassword", {
      action: "set",
      password: "nachos-and-more",
    });

    await revoked;
    expect(await disconnected).toBe("io server disconnect");
    expect(await access).toEqual({
      enabled: true,
      password: "nachos-and-more",
    });
    const line = await chat;
    expect(line.cmd).toBe("roomPassword");
    expect(line.msg).toBe("changed");
    expect(JSON.stringify(line)).not.toContain("nachos");
    await expect(t.join(cookie)).rejects.toThrow("unauthorized");
    // Saved right away
    expect(JSON.parse(getRoom(t.db, ROOM)!.data!).access).toMatchObject({
      password: "nachos-and-more",
      enabled: true,
      epoch: 1,
    });
  });

  it("turning it off keeps guests; regenerating gives a readable password", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.ownerCookie);
    const guest = await t.join(t.guestCookie().cookie);
    const guestAccess = next<RoomAccessInfo>(guest, "REC:roomAccess");
    const chat = next<ChatMessage>(owner, "REC:chat");
    owner.emit("CMD:roomPassword", { action: "enable", enabled: false });
    expect(await guestAccess).toEqual({ enabled: false });
    expect((await chat).msg).toBe("off");
    expect(guest.connected).toBe(true);

    const ownerAccess = next<RoomAccessInfo>(owner, "REC:roomAccess");
    const kicked = next(guest, "REC:accessRevoked");
    owner.emit("CMD:roomPassword", { action: "regenerate" });
    const info = await ownerAccess;
    expect(info.enabled).toBe(true);
    expect(info.password).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    // Turning it back on revokes guests who joined while it was open
    await kicked;
  });

  it("rejects invalid passwords", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.ownerCookie);
    const err = next<string>(owner, "errorMessage");
    owner.emit("CMD:roomPassword", { action: "set", password: "ab" });
    expect(await err).toMatch(/4–64/);
  });
});

describe("kicking", () => {
  it("kicking a guest revokes their grant", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.ownerCookie);
    const { cookie, guestId } = t.guestCookie();
    const guest = await t.join(cookie);
    const kicked = next(guest, "kicked");
    const disconnected = next(guest, "disconnect");
    owner.emit("CMD:kickUser", {
      userToBeKicked: (guest.io.opts.query as { clientId: string }).clientId,
    });
    await kicked;
    await disconnected;
    expect(t.room.access.isRevoked(guestId)).toBe(true);
    await expect(t.join(cookie)).rejects.toThrow("unauthorized");
    // Another guest is unaffected
    await t.join(t.guestCookie().cookie);
    // Persisted
    expect(JSON.parse(getRoom(t.db, ROOM)!.data!).access.revoked).toEqual([
      guestId,
    ]);
  });

  it("kicking an owner just disconnects them", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join(t.ownerCookie);
    const b = await t.join(t.ownerCookie);
    const kicked = next(b, "kicked");
    a.emit("CMD:kickUser", {
      userToBeKicked: (b.io.opts.query as { clientId: string }).clientId,
    });
    await kicked;
    await t.join(t.ownerCookie);
  });
});

describe("persistence", () => {
  it("rooms from before room passwords get one generated and saved on load", async () => {
    const t = await setup();
    cleanups.push(t.close);
    saveRoomData(
      t.db,
      "/old-room-x",
      JSON.stringify({ video: "", chat: [] }),
      1,
    );
    const legacy = new Room(
      t.io,
      t.db,
      "/old-room-x",
      getRoom(t.db, "/old-room-x")!.data,
    );
    try {
      expect(legacy.access.enabled).toBe(true);
      expect(legacy.access.password).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
      const stored = JSON.parse(getRoom(t.db, "/old-room-x")!.data!).access;
      expect(stored.password).toBe(legacy.access.password);
      // Reloading keeps the same password
      const again = new Room(
        t.io,
        t.db,
        "/old-room-y",
        getRoom(t.db, "/old-room-x")!.data,
      );
      expect(again.access.password).toBe(legacy.access.password);
      again.destroy();
    } finally {
      legacy.destroy();
    }
  });
});
