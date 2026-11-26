import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { openDatabase } from "./utils/db.ts";
import { Room } from "./room.ts";

const VIDEO = "https://v.example.com/movie.mp4";

type Client = ClientSocket & { clientId: string };

async function setup(enabled = true) {
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
  const room = new Room(io, db, "/ready-room");
  room.roomSettings = { ...room.roomSettings, readyCheck: enabled };
  const clients: ClientSocket[] = [];
  const join = async (
    name?: string,
    before?: (s: Client) => void,
    clientId = randomUUID(),
    sessionId = randomUUID() + randomUUID(),
  ) => {
    const socket = connect(`http://127.0.0.1:${port}/ready-room`, {
      transports: ["websocket"],
      query: { clientId },
      auth: { sessionId },
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

/** Two viewers watching VIDEO, both ready */
async function watching(enabled = true) {
  const t = await setup(enabled);
  const a = await t.join("Alex");
  const b = await t.join("Sam");
  a.emit("CMD:host", VIDEO);
  await settle();
  a.emit("CMD:readyState", { ready: true });
  b.emit("CMD:readyState", { ready: true });
  await settle();
  return { ...t, a, b };
}

describe("Room ready check", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  it("pauses everyone at the stalled viewer's position, then resumes when they're ready", async () => {
    const t = await watching();
    cleanups.push(t.close);
    const paused = next(t.a, "REC:pause");
    const seek = next<number>(t.a, "REC:seek");
    const started = next<ReadyCheckState>(
      t.a,
      "REC:readyCheck",
      (s) => s.active,
    );
    t.b.emit("CMD:readyState", { ready: false, buffering: true, time: 61.5 });
    expect(await started).toMatchObject({
      active: true,
      waitingFor: [t.b.clientId],
      reason: "buffering",
      trigger: t.b.clientId,
    });
    expect(await paused).toBeUndefined(); // no actor: not "Sam paused"
    expect(await seek).toBe(61.5);
    expect(t.room.paused).toBe(true);
    expect(t.room.videoTS).toBe(61.5);

    const played = next(t.a, "REC:play");
    const ended = next<ReadyCheckState>(
      t.a,
      "REC:readyCheck",
      (s) => !s.active,
    );
    t.b.emit("CMD:readyState", { ready: true });
    expect(await ended).toMatchObject({ outcome: "ready", waitingFor: [] });
    expect(await played).toBe(VIDEO);
    expect(t.room.paused).toBe(false);
  });

  it("does nothing while the toggle is off", async () => {
    const t = await watching(false);
    cleanups.push(t.close);
    const states: ReadyCheckState[] = [];
    t.a.on("REC:readyCheck", (s: ReadyCheckState) => states.push(s));
    t.b.emit("CMD:readyState", { ready: false, buffering: true, time: 3 });
    await settle();
    expect(states).toEqual([]);
    expect(t.room.paused).toBe(false);
  });

  it("doesn't trigger for screen share or while paused", async () => {
    const t = await watching();
    cleanups.push(t.close);
    t.a.emit("CMD:pause");
    await settle();
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    await settle();
    expect(t.room.paused).toBe(true);
    const states: ReadyCheckState[] = [];
    t.b.on("REC:readyCheck", (s: ReadyCheckState) => states.push(s));
    t.a.emit("CMD:joinScreenShare", { file: false });
    await settle();
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    await settle();
    expect(states.some((s) => s.active)).toBe(false);
  });

  it("Resume now resumes for everyone with the actor", async () => {
    const t = await watching();
    cleanups.push(t.close);
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    await next<ReadyCheckState>(t.b, "REC:readyCheck", (s) => s.active);
    const played = next(t.b, "REC:play");
    const ended = next<ReadyCheckState>(
      t.b,
      "REC:readyCheck",
      (s) => !s.active,
    );
    t.a.emit("CMD:readyCheckSkip");
    expect(await ended).toMatchObject({
      outcome: "skipped",
      actorId: t.a.clientId,
    });
    await played;
    expect(t.room.paused).toBe(false);
  });

  it("a manual pause cancels the check without resuming", async () => {
    const t = await watching();
    cleanups.push(t.close);
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    await next<ReadyCheckState>(t.b, "REC:readyCheck", (s) => s.active);
    const plays: unknown[] = [];
    t.b.on("REC:play", (v: unknown) => plays.push(v));
    const ended = next<ReadyCheckState>(
      t.b,
      "REC:readyCheck",
      (s) => !s.active,
    );
    t.a.emit("CMD:pause");
    expect((await ended).outcome).toBe("cancelled");
    t.b.emit("CMD:readyState", { ready: true });
    await settle();
    expect(plays).toEqual([]);
    expect(t.room.paused).toBe(true);
  });

  it("resumes when the only viewer it waits for disconnects", async () => {
    const t = await watching();
    cleanups.push(t.close);
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    await next<ReadyCheckState>(t.a, "REC:readyCheck", (s) => s.active);
    const ended = next<ReadyCheckState>(
      t.a,
      "REC:readyCheck",
      (s) => !s.active,
    );
    t.b.disconnect();
    expect((await ended).outcome).toBe("ready");
    expect(t.room.paused).toBe(false);
  });

  it("joining mid-play pauses the room (REC:host says paused) and sends the state on connect", async () => {
    const t = await watching();
    cleanups.push(t.close);
    let host: Promise<HostState> | undefined;
    let state: Promise<ReadyCheckState> | undefined;
    const c = await t.join("Kim", (s) => {
      host = next<HostState>(s, "REC:host");
      state = next<ReadyCheckState>(s, "REC:readyCheck");
    });
    expect((await host)?.paused).toBe(true);
    expect(await state).toMatchObject({
      active: true,
      reason: "join",
      waitingFor: [c.clientId],
    });
    const played = next(t.a, "REC:play");
    c.emit("CMD:readyState", { ready: true });
    await played;
    expect(t.room.paused).toBe(false);
  });

  it("a new video cancels the check", async () => {
    const t = await watching();
    cleanups.push(t.close);
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    await next<ReadyCheckState>(t.a, "REC:readyCheck", (s) => s.active);
    const ended = next<ReadyCheckState>(
      t.a,
      "REC:readyCheck",
      (s) => !s.active,
    );
    t.a.emit("CMD:host", "https://v.example.com/other.mp4");
    expect((await ended).outcome).toBe("cancelled");
    expect(t.room.paused).toBe(false);
  });

  it("turning the setting off ends the check and resumes", async () => {
    const t = await watching();
    cleanups.push(t.close);
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    await next<ReadyCheckState>(t.a, "REC:readyCheck", (s) => s.active);
    const played = next(t.a, "REC:play");
    const ended = next<ReadyCheckState>(
      t.a,
      "REC:readyCheck",
      (s) => !s.active,
    );
    t.a.emit("CMD:roomSettings", { readyCheck: false });
    expect((await ended).outcome).toBe("cancelled");
    await played;
    expect(t.room.paused).toBe(false);
  });

  it("is enabled through CMD:roomSettings", async () => {
    const t = await watching(false);
    cleanups.push(t.close);
    t.a.emit("CMD:roomSettings", { readyCheck: true });
    await settle();
    const started = next<ReadyCheckState>(
      t.a,
      "REC:readyCheck",
      (s) => s.active,
    );
    t.b.emit("CMD:readyState", { ready: false, buffering: true });
    expect((await started).trigger).toBe(t.b.clientId);
  });

  it("ignores invalid reports", async () => {
    const t = await watching();
    cleanups.push(t.close);
    t.b.emit("CMD:readyState", "buffering");
    t.b.emit("CMD:readyState", { ready: "no", buffering: true });
    t.b.emit("CMD:readyState", null);
    await settle();
    expect(t.room.paused).toBe(false);
  });
});
