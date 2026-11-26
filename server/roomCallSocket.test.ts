// Voice call over Socket.IO: membership (REC:callState), the grace period on disconnect, the signal relay's
// restrictions and rate limit, and owner-only moderation.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { Room } from "./room.ts";
import { CALL_LIMITS } from "./callState.ts";

const ROOM = "/call-room";

async function setup() {
  const server = http.createServer();
  const io = new Server(server, { transports: ["websocket"] });
  // Sockets connecting with ?owner=1 are owners (server.ts sets this from the session)
  io.on("new_namespace", (nsp) =>
    nsp.use((s, next) => {
      s.data.owner = s.handshake.query.owner === "1";
      next();
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const db = openDatabase(":memory:");
  const room = new Room(io, db, ROOM);
  const clients: ClientSocket[] = [];
  type Who = { clientId: string; sessionId: string; owner?: boolean };
  const person = (owner = true): Who => ({
    clientId: randomUUID(),
    sessionId: randomUUID() + randomUUID(),
    owner,
  });
  const join = async (who: Who = person()) => {
    const socket = connect(`http://127.0.0.1:${port}${ROOM}`, {
      transports: ["websocket"],
      query: { clientId: who.clientId, owner: who.owner ? "1" : "0" },
      auth: { sessionId: who.sessionId },
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    const states: CallState[] = [];
    socket.on("REC:callState", (s: CallState) => states.push(s));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    return { socket, who, states, id: who.clientId };
  };
  const close = async () => {
    clients.forEach((c) => c.disconnect());
    room.destroy();
    io.close();
    db.close();
    await new Promise((r) => server.close(r));
  };
  return { room, join, person, close };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const last = (states: CallState[]) => states[states.length - 1];
const session = () => randomUUID().replace(/-/g, "").slice(0, 16);

describe("Room voice call", () => {
  const cleanups: (() => Promise<void>)[] = [];
  const grace = Room.CALL_GRACE_MS;
  beforeEach(() => {
    Room.CALL_GRACE_MS = 300;
  });
  afterEach(async () => {
    Room.CALL_GRACE_MS = grace;
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("sends the call state on connect and broadcasts joins, mute changes and leaves", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    await settle();
    expect(last(a.states)).toEqual({ members: [] });

    const sa = session();
    a.socket.emit("CMD:call", { action: "join", session: sa, muted: true });
    await settle();
    expect(last(b.states).members).toEqual([
      {
        clientId: a.id,
        session: sa,
        muted: true,
        camera: false,
        joinedAt: expect.any(Number),
        reconnecting: false,
      },
    ]);

    a.socket.emit("CMD:call", { action: "state", muted: false });
    await settle();
    expect(last(b.states).members[0].muted).toBe(false);

    // Camera on/off is broadcast the same way; a bad value changes nothing
    a.socket.emit("CMD:call", { action: "state", camera: true });
    await settle();
    expect(last(b.states).members[0]).toMatchObject({
      muted: false,
      camera: true,
    });
    const count = b.states.length;
    a.socket.emit("CMD:call", { action: "state", camera: "off" });
    a.socket.emit("CMD:call", { action: "state", camera: true });
    await settle();
    expect(b.states.length).toBe(count);
    a.socket.emit("CMD:call", { action: "state", camera: false });
    await settle();
    expect(last(b.states).members[0].camera).toBe(false);

    // Someone else's leave/state doesn't touch a's membership
    b.socket.emit("CMD:call", { action: "state", muted: true });
    b.socket.emit("CMD:call", { action: "leave" });
    await settle();
    expect(last(b.states).members).toHaveLength(1);

    // Garbage is ignored
    a.socket.emit("CMD:call", { action: "join", session: "bad", muted: 1 });
    a.socket.emit("CMD:call", null);
    a.socket.emit("CMD:call", { action: "leave" });
    await settle();
    expect(last(b.states)).toEqual({ members: [] });

    // A newcomer gets the current state
    a.socket.emit("CMD:call", { action: "join", session: sa, muted: false });
    await settle();
    const c = await t.join();
    await settle();
    expect(last(c.states).members.map((m) => m.clientId)).toEqual([a.id]);
  });

  it("keeps a member through a reconnect and drops them after the grace period", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const watcher = await t.join();
    const who = t.person();
    const a1 = await t.join(who);
    a1.socket.emit("CMD:call", {
      action: "join",
      session: session(),
      muted: false,
    });
    await settle();
    const joinedAt = last(watcher.states).members[0].joinedAt;

    a1.socket.disconnect();
    await settle();
    expect(last(watcher.states).members[0]).toMatchObject({
      clientId: who.clientId,
      reconnecting: true,
    });

    // Reload: a new socket (same clientId) rejoins with a new session, silently
    const a2 = await t.join(who);
    const s2 = session();
    a2.socket.emit("CMD:call", { action: "join", session: s2, muted: true });
    await settle();
    expect(last(watcher.states).members).toEqual([
      {
        clientId: who.clientId,
        session: s2,
        muted: true,
        camera: false,
        joinedAt,
        reconnecting: false,
      },
    ]);
    // The grace timer from the first disconnect doesn't remove the rejoined member
    await settle(450);
    expect(last(watcher.states).members).toHaveLength(1);

    // Gone for good: removed once the grace period ends
    a2.socket.disconnect();
    await settle();
    expect(last(watcher.states).members[0].reconnecting).toBe(true);
    await settle(450);
    expect(last(watcher.states)).toEqual({ members: [] });
  });

  it("a newer tab takes the member over", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const watcher = await t.join();
    const who = t.person();
    const tab1 = await t.join(who);
    tab1.socket.emit("CMD:call", {
      action: "join",
      session: session(),
      muted: false,
    });
    await settle();
    // Same browser, second tab: the server disconnects the first one
    const tab2 = await t.join(who);
    await settle();
    expect(tab1.socket.connected).toBe(false);
    expect(last(watcher.states).members[0].reconnecting).toBe(true);
    const s2 = session();
    tab2.socket.emit("CMD:call", { action: "join", session: s2, muted: false });
    await settle();
    expect(last(watcher.states).members).toMatchObject([
      { clientId: who.clientId, session: s2, reconnecting: false },
    ]);
  });

  it("relays signals only between call members, with validated fields", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    const outsider = await t.join();
    const got: { b: CallSignalEvent[]; outsider: CallSignalEvent[] } = {
      b: [],
      outsider: [],
    };
    b.socket.on("REC:callSignal", (m: CallSignalEvent) => got.b.push(m));
    outsider.socket.on("REC:callSignal", (m: CallSignalEvent) =>
      got.outsider.push(m),
    );
    const sa = session();
    const sb = session();
    const offer = {
      to: b.id,
      toSession: sb,
      description: { type: "offer", sdp: "v=0\r\n" },
    };

    // Neither in the call yet
    a.socket.emit("CMD:callSignal", offer);
    a.socket.emit("CMD:call", { action: "join", session: sa, muted: false });
    await settle();
    // b isn't a member yet
    a.socket.emit("CMD:callSignal", offer);
    b.socket.emit("CMD:call", { action: "join", session: sb, muted: false });
    await settle();
    expect(got.b).toEqual([]);

    a.socket.emit("CMD:callSignal", { ...offer, from: outsider.id, x: 1 });
    // To someone outside the call, or from someone outside it
    a.socket.emit("CMD:callSignal", { ...offer, to: outsider.id });
    outsider.socket.emit("CMD:callSignal", offer);
    // Bad shapes and oversized
    a.socket.emit("CMD:callSignal", { to: b.id, toSession: sb });
    a.socket.emit("CMD:callSignal", {
      ...offer,
      description: {
        type: "offer",
        sdp: "a".repeat(CALL_LIMITS.signalMaxBytes),
      },
    });
    await settle();
    expect(got.outsider).toEqual([]);
    expect(got.b).toEqual([
      {
        toSession: sb,
        description: { type: "offer", sdp: "v=0\r\n" },
        from: a.id,
        session: sa,
      },
    ]);
  });

  it("rate limits signals per socket", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const a = await t.join();
    const b = await t.join();
    let received = 0;
    b.socket.on("REC:callSignal", () => received++);
    const sb = session();
    a.socket.emit("CMD:call", {
      action: "join",
      session: session(),
      muted: false,
    });
    b.socket.emit("CMD:call", { action: "join", session: sb, muted: false });
    await settle();
    for (let i = 0; i < CALL_LIMITS.signalMax + 25; i++) {
      a.socket.emit("CMD:callSignal", {
        to: b.id,
        toSession: sb,
        candidate: {
          candidate: `candidate:${i}`,
          sdpMid: "0",
          sdpMLineIndex: 0,
        },
      });
    }
    await settle(300);
    expect(received).toBe(CALL_LIMITS.signalMax);
  });

  it("lets owners mute someone or remove them from the call; guests can't", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.person(true));
    const guest = await t.join(t.person(false));
    const guest2 = await t.join(t.person(false));
    const moderated: CallModeratedEvent[] = [];
    guest.socket.on("REC:callModerated", (e: CallModeratedEvent) =>
      moderated.push(e),
    );
    const errors: string[] = [];
    guest2.socket.on("errorMessage", (e: string) => errors.push(e));
    // Guests can join calls
    guest.socket.emit("CMD:call", {
      action: "join",
      session: session(),
      muted: false,
    });
    await settle();
    expect(last(owner.states).members).toHaveLength(1);

    guest2.socket.emit("CMD:callModerate", {
      action: "remove",
      clientId: guest.id,
    });
    await settle();
    expect(errors).toEqual(["Only the room's owner can do that."]);
    expect(last(owner.states).members).toHaveLength(1);
    expect(moderated).toEqual([]);

    owner.socket.emit("CMD:callModerate", {
      action: "mute",
      clientId: guest.id,
    });
    await settle();
    expect(moderated).toEqual([{ action: "mute", by: { id: owner.id } }]);
    // Muting only asks: the member's state changes when they mute themselves
    expect(last(owner.states).members[0].muted).toBe(false);

    // Same for the camera
    guest.socket.emit("CMD:call", { action: "state", camera: true });
    await settle();
    owner.socket.emit("CMD:callModerate", {
      action: "camera",
      clientId: guest.id,
    });
    await settle();
    expect(moderated[1]).toEqual({ action: "camera", by: { id: owner.id } });
    expect(last(owner.states).members[0].camera).toBe(true);

    owner.socket.emit("CMD:callModerate", {
      action: "remove",
      clientId: guest.id,
    });
    await settle();
    expect(moderated[2]).toEqual({ action: "remove", by: { id: owner.id } });
    expect(last(owner.states)).toEqual({ members: [] });
  });

  it("removes a kicked person from the call at once", async () => {
    const t = await setup();
    cleanups.push(t.close);
    const owner = await t.join(t.person(true));
    const guest = await t.join(t.person(false));
    guest.socket.emit("CMD:call", {
      action: "join",
      session: session(),
      muted: false,
    });
    await settle();
    owner.socket.emit("CMD:kickUser", { userToBeKicked: guest.id });
    await settle();
    expect(last(owner.states)).toEqual({ members: [] });
  });
});
