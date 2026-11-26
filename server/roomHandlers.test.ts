// Socket tests for the Room's basic CMD:* handlers: admission, playback, chat, reactions, queue, screen share,
// signaling, kicking and chat deletion, with their validation (rejection) branches.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import type { DatabaseSync } from "node:sqlite";
import { getRoom, openDatabase, saveSubtitleTiming } from "./utils/db.ts";
import { subtitleOffsetKey } from "./utils/subtitleOffset.ts";
import { claimClientId, Room } from "./room.ts";

const yt = vi.hoisted(() => ({ fetchYoutubeVideo: vi.fn() }));
vi.mock("./utils/youtube.ts", async (orig) => ({
  ...(await orig<typeof import("./utils/youtube.ts")>()),
  fetchYoutubeVideo: yt.fetchYoutubeVideo,
}));

const ROOM = "handlers-room";
const VIDEO = "https://example.com/movie.mp4";

let server: http.Server;
let io: Server;
let db: DatabaseSync;
let room: Room;
let port: number;
let clients: ClientSocket[] = [];

beforeEach(async () => {
  server = http.createServer();
  io = new Server(server, { transports: ["websocket"] });
  // clientIds starting with "0" are guests (guestId = the handshake's guestId), everyone else is an owner
  io.on("new_namespace", (nsp) =>
    nsp.use((s, next) => {
      const id = String(s.handshake.query.clientId);
      s.data.owner = !id.startsWith("0");
      if (!s.data.owner && s.handshake.query.guestId) {
        s.data.guestId = String(s.handshake.query.guestId);
      }
      next();
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  db = openDatabase(":memory:");
  room = new Room(io, db, "/" + ROOM);
  yt.fetchYoutubeVideo.mockReset();
  yt.fetchYoutubeVideo.mockResolvedValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  clients.forEach((c) => c.disconnect());
  clients = [];
  room.destroy();
  io.close();
  try {
    db.close();
  } catch {
    // closed by a test
  }
  await new Promise((r) => server.close(r));
  vi.restoreAllMocks();
});

function open(query: Record<string, string>, sessionId?: unknown) {
  const socket = connect(`http://127.0.0.1:${port}/${ROOM}`, {
    transports: ["websocket"],
    query,
    auth: sessionId === undefined ? {} : { sessionId },
    forceNew: true,
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

async function join(
  opts: {
    guest?: boolean;
    guestId?: string;
    clientId?: string;
    sessionId?: string;
  } = {},
) {
  const clientId =
    opts.clientId ?? (opts.guest ? "0" : "1") + randomUUID().slice(1);
  const query: Record<string, string> = { clientId };
  if (opts.guestId) {
    query.guestId = opts.guestId;
  }
  const socket = open(query, opts.sessionId ?? randomUUID() + randomUUID());
  const hostState = new Promise<HostState>((r) => socket.once("REC:host", r));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  await hostState;
  return { socket, clientId };
}

/** Waits until the server has handled everything this socket sent before */
async function barrier(socket: ClientSocket) {
  const p = new Promise((r) => socket.once("REC:host", r));
  socket.emit("CMD:askHost");
  await p;
}

const next = <T = unknown>(socket: ClientSocket, event: string) =>
  new Promise<T>((r) => socket.once(event, r));

function collect<T = unknown>(socket: ClientSocket, event: string) {
  const seen: T[] = [];
  socket.on(event, (v: T) => seen.push(v));
  return seen;
}

const chatOf = () => JSON.parse(room.serialize()).chat as ChatMessage[];

describe("admission", () => {
  async function refused(query: Record<string, string>, sessionId?: unknown) {
    const socket = open(query, sessionId);
    const err = await new Promise<Error>((r) =>
      socket.once("connect_error", r),
    );
    return err.message;
  }

  it("refuses missing, malformed or prototype clientIds", async () => {
    const sid = randomUUID() + randomUUID();
    expect(await refused({}, sid)).toBe("Invalid clientId type");
    expect(await refused({ clientId: "__proto__" }, sid)).toBe(
      "Invalid clientId format",
    );
    expect(await refused({ clientId: "not-a-uuid" }, sid)).toBe(
      "Invalid clientId format",
    );
  });

  it("requires a sessionId of a sane length", async () => {
    const clientId = randomUUID();
    expect(await refused({ clientId })).toBe("Missing or invalid sessionId");
    expect(await refused({ clientId }, "short")).toBe(
      "Missing or invalid sessionId",
    );
    expect(await refused({ clientId }, "x".repeat(201))).toBe(
      "Missing or invalid sessionId",
    );
    expect(await refused({ clientId }, 12345678901234567890)).toBe(
      "Missing or invalid sessionId",
    );
  });

  it("protects a clientId with the session that claimed it", async () => {
    const clientId = randomUUID();
    const sessionId = "a".repeat(32);
    await join({ clientId, sessionId });
    expect(await refused({ clientId }, "b".repeat(32))).toBe(
      "Incorrect sessionId",
    );
  });

  it("replaces an older socket of the same client", async () => {
    const clientId = randomUUID();
    const sessionId = "c".repeat(32);
    const first = await join({ clientId, sessionId });
    const gone = next(first.socket, "disconnect");
    await join({ clientId, sessionId });
    await gone;
    expect(room.roster.filter((u) => u.id === clientId)).toHaveLength(1);
  });

  it("refuses instead of hanging when the middleware throws", async () => {
    vi.spyOn(Array.prototype, "find").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    // The first Array#find in the middleware is the roster lookup
    const msg = await refused(
      { clientId: randomUUID() },
      randomUUID() + randomUUID(),
    );
    expect(["Internal error", "Incorrect sessionId"]).toContain(msg);
  });

  it("sends the full room state on connect", async () => {
    const socket = open(
      { clientId: randomUUID() },
      randomUUID() + randomUUID(),
    );
    const events = [
      "REC:host",
      "REC:nameMap",
      "REC:pictureMap",
      "REC:tsMap",
      "chatinit",
      "playlist",
      "REC:videoMeta",
      "REC:roomSettings",
      "REC:roomAccess",
      "REC:readyCheck",
      "REC:nextEpisode",
      "REC:callState",
      "roster",
    ];
    await Promise.all(events.map((e) => next(socket, e)));
  });
});

describe("claimClientId", () => {
  it("sweeps expired claims once the map is full", () => {
    const now = Date.now();
    // Fill up with claims that expire immediately (far in the past relative to `later`)
    for (let i = 0; i < 50000; i++) {
      claimClientId(`sweep-${i}`, "s", now - 8 * 24 * 3600 * 1000);
    }
    expect(claimClientId("sweep-new", "s", now)).toBe(true);
    // An expired claim can be taken over by another session
    expect(claimClientId("sweep-1", "other", now)).toBe(true);
    expect(claimClientId("sweep-new", "other", now)).toBe(false);
  });
});

describe("names and pictures", () => {
  it("sets a name and ignores empty or long ones", async () => {
    const { socket, clientId } = await join();
    const maps = collect<StringDict>(socket, "REC:nameMap");
    socket.emit("CMD:name", "");
    socket.emit("CMD:name", "x".repeat(51));
    socket.emit("CMD:name", "Alex");
    await barrier(socket);
    await vi.waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0][clientId]).toBe("Alex");
  });

  it("sets a picture and ignores huge ones", async () => {
    const { socket, clientId } = await join();
    const maps = collect<StringDict>(socket, "REC:pictureMap");
    socket.emit("CMD:picture", "x".repeat(10001));
    socket.emit("CMD:picture", "https://example.com/me.png");
    await barrier(socket);
    await vi.waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0][clientId]).toBe("https://example.com/me.png");
  });

  it("keeps only names and pictures of people who chatted when serialized", async () => {
    const alex = await join();
    const sam = await join();
    alex.socket.emit("CMD:name", "Alex");
    alex.socket.emit("CMD:picture", "a.png");
    sam.socket.emit("CMD:name", "Sam");
    sam.socket.emit("CMD:picture", "s.png");
    alex.socket.emit("CMD:chat", "hi");
    await barrier(alex.socket);
    await barrier(sam.socket);
    const data = JSON.parse(room.serialize());
    expect(data.nameMap).toEqual({ [alex.clientId]: "Alex" });
    expect(data.pictureMap).toEqual({ [alex.clientId]: "a.png" });
  });
});

describe("playback", () => {
  it("validates seek, playback rate and loop", async () => {
    const alex = await join();
    const sam = await join();
    alex.socket.emit("CMD:host", VIDEO);
    await barrier(alex.socket);
    const seeks = collect(sam.socket, "REC:seek");
    const rates = collect(sam.socket, "REC:playbackRate");
    const loops = collect(sam.socket, "REC:loop");
    for (const bad of [null, "12", NaN, Infinity, {}]) {
      alex.socket.emit("CMD:seek", bad);
      alex.socket.emit("CMD:playbackRate", bad);
      alex.socket.emit("CMD:loop", bad);
    }
    alex.socket.emit("CMD:playbackRate", 0.01);
    alex.socket.emit("CMD:playbackRate", 17);
    alex.socket.emit("CMD:seek", 42);
    alex.socket.emit("CMD:playbackRate", 1.5);
    alex.socket.emit("CMD:loop", true);
    await barrier(alex.socket);
    await vi.waitFor(() => expect(loops).toEqual([true]));
    expect(seeks).toEqual([42]);
    expect(rates).toEqual([1.5]);
    expect(room.videoTS).toBe(42);
    expect(room.playbackRate).toBe(1.5);
    expect(room.loop).toBe(true);
    expect(chatOf().map((m) => m.cmd)).toEqual([
      "host",
      "seek",
      "playbackRate",
    ]);
  });

  it("tracks timestamps: only forward, negative for live, ignored right after a change", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", VIDEO);
    await barrier(alex.socket);
    // Right after a host change reports are ignored
    alex.socket.emit("CMD:ts", 50);
    await barrier(alex.socket);
    expect(room.videoTS).toBe(0);
    await new Promise((r) => setTimeout(r, 1050));
    alex.socket.emit("CMD:ts", "50");
    alex.socket.emit("CMD:ts", 50);
    alex.socket.emit("CMD:ts", 40);
    await barrier(alex.socket);
    expect(room.videoTS).toBe(50);
    alex.socket.emit("CMD:ts", -5);
    await barrier(alex.socket);
    expect(room.videoTS).toBe(-5);
  });

  it("records who played with their position in chat", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", VIDEO);
    alex.socket.emit("CMD:pause");
    alex.socket.emit("CMD:play");
    await barrier(alex.socket);
    expect(room.paused).toBe(false);
    expect(chatOf().map((m) => m.cmd)).toEqual(["host", "pause", "play"]);
  });

  it("ignores very long video URLs", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", "https://example.com/" + "x".repeat(50001));
    await barrier(alex.socket);
    expect(room.video).toBe("");
  });

  it("broadcasts subtitles and ignores huge ones", async () => {
    const alex = await join();
    const subs = collect(alex.socket, "REC:subtitle");
    alex.socket.emit("CMD:subtitle", "x".repeat(10001));
    alex.socket.emit("CMD:subtitle", "/subtitle/abc");
    await barrier(alex.socket);
    await vi.waitFor(() => expect(subs).toEqual(["/subtitle/abc"]));
    expect(room.subtitle).toBe("/subtitle/abc");
  });

  it("reports playback issues only while a video is set", async () => {
    const alex = await join();
    const issues = collect<PlaybackIssue>(alex.socket, "REC:playbackIssue");
    alex.socket.emit("CMD:playbackIssue", { reason: "codec" });
    alex.socket.emit("CMD:host", VIDEO);
    alex.socket.emit("CMD:playbackIssue", { reason: "codec" });
    await barrier(alex.socket);
    await vi.waitFor(() => expect(issues).toHaveLength(1));
    expect(issues[0]).toEqual({
      userId: alex.clientId,
      name: "Someone",
      reason: "codec",
    });
  });
});

describe("chat", () => {
  it("accepts legacy strings and V2 objects, rejecting bad payloads", async () => {
    const alex = await join();
    for (const bad of [
      null,
      5,
      {},
      { msg: 5 },
      { msg: "" },
      "x".repeat(10001),
    ]) {
      alex.socket.emit("CMD:chatV2", bad);
    }
    alex.socket.emit("CMD:chatV2", { msg: "half reply", replyToId: "x" });
    alex.socket.emit("CMD:chat", "hello");
    alex.socket.emit("CMD:chatV2", { msg: "world" });
    await barrier(alex.socket);
    expect(chatOf().map((m) => m.msg)).toEqual(["hello", "world"]);
  });

  it("attaches the replied-to message, or falls back to a plain message", async () => {
    const alex = await join();
    alex.socket.emit("CMD:chat", "original");
    await barrier(alex.socket);
    const target = chatOf()[0];
    alex.socket.emit("CMD:chatV2", {
      msg: "reply",
      replyToId: target.id,
      replyToTimestamp: target.timestamp,
    });
    alex.socket.emit("CMD:chatV2", {
      msg: "orphan",
      replyToId: target.id,
      replyToTimestamp: "1999-01-01T00:00:00.000Z",
    });
    await barrier(alex.socket);
    const [, reply, orphan] = chatOf();
    expect(reply).toMatchObject({
      msg: "reply",
      replyToId: target.id,
      replyToUserId: target.id,
      replyToMsg: "original",
    });
    expect(orphan.replyToId).toBeUndefined();
  });

  it("keeps the last 100 messages", async () => {
    const alex = await join();
    for (let i = 0; i < 105; i++) {
      alex.socket.emit("CMD:chat", "m" + i);
    }
    await barrier(alex.socket);
    const chat = chatOf();
    expect(chat).toHaveLength(100);
    expect(chat[0].msg).toBe("m5");
  });

  it("adds and removes reactions once per person", async () => {
    const alex = await join();
    const sam = await join();
    alex.socket.emit("CMD:chat", "react to me");
    await barrier(alex.socket);
    const { id: msgId, timestamp: msgTimestamp } = chatOf()[0];
    const added = collect<Reaction>(alex.socket, "REC:addReaction");
    const removed = collect<Reaction>(alex.socket, "REC:removeReaction");
    const r = { value: "👍", msgId, msgTimestamp };
    sam.socket.emit("CMD:addReaction", r);
    sam.socket.emit("CMD:addReaction", r);
    alex.socket.emit("CMD:addReaction", r);
    // Invalid ones
    sam.socket.emit("CMD:addReaction", null);
    sam.socket.emit("CMD:addReaction", { ...r, value: "x".repeat(9) });
    sam.socket.emit("CMD:addReaction", { ...r, msgTimestamp: "nope" });
    await barrier(sam.socket);
    await barrier(alex.socket);
    await vi.waitFor(() => expect(added).toHaveLength(2));
    expect(chatOf()[0].reactions).toEqual({
      "👍": [sam.clientId, alex.clientId],
    });

    sam.socket.emit("CMD:removeReaction", r);
    sam.socket.emit("CMD:removeReaction", null);
    sam.socket.emit("CMD:removeReaction", { ...r, value: "x".repeat(9) });
    sam.socket.emit("CMD:removeReaction", { ...r, value: "🎉" });
    sam.socket.emit("CMD:removeReaction", { ...r, msgId: "nobody" });
    await barrier(sam.socket);
    await vi.waitFor(() => expect(removed).toHaveLength(1));
    expect(removed[0]).toMatchObject({ user: sam.clientId, value: "👍" });
    expect(chatOf()[0].reactions).toEqual({ "👍": [alex.clientId] });
  });
});

describe("queue", () => {
  it("adds, moves and deletes items with strict index validation", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", VIDEO);
    for (const u of ["a", "b", "c"]) {
      alex.socket.emit("CMD:playlistAdd", `https://example.com/${u}.mp4`);
    }
    alex.socket.emit("CMD:playlistAdd", "");
    alex.socket.emit("CMD:playlistAdd", 5);
    await barrier(alex.socket);
    await vi.waitFor(() => expect(room.playlist).toHaveLength(3));
    const names = () => room.playlist.map((p) => p.url.slice(-5, -4));

    for (const bad of [
      null,
      { index: 0, toIndex: 3 },
      { index: -1, toIndex: 0 },
      { index: 0.5, toIndex: 1 },
      { index: "0", toIndex: 1 },
    ]) {
      alex.socket.emit("CMD:playlistMove", bad);
    }
    alex.socket.emit("CMD:playlistMove", { index: 0, toIndex: 2 });
    await barrier(alex.socket);
    expect(names()).toEqual(["b", "c", "a"]);

    for (const bad of [null, "0", -1, 3, 0.5, NaN]) {
      alex.socket.emit("CMD:playlistDelete", bad);
    }
    alex.socket.emit("CMD:playlistDelete", 1);
    await barrier(alex.socket);
    expect(names()).toEqual(["b", "a"]);
    expect(chatOf().filter((m) => m.cmd === "playlistAdd")).toHaveLength(3);
  });

  it("starts the first queued item when nothing is playing", async () => {
    const alex = await join();
    alex.socket.emit("CMD:playlistAdd", {
      url: "https://example.com/q.mp4",
      name: "Queued",
    });
    await vi.waitFor(() =>
      expect(room.video).toBe("https://example.com/q.mp4"),
    );
    expect(room.playlist).toEqual([]);
    const line = chatOf().find((m) => m.cmd === "nowPlaying");
    expect(line?.id).toBe("");
  });

  it("uses the YouTube lookup for YouTube links, and the URL when it fails", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", VIDEO);
    yt.fetchYoutubeVideo.mockResolvedValueOnce({
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      name: "A video",
      type: "youtube",
      duration: 60,
      channel: "Ch",
    });
    alex.socket.emit(
      "CMD:playlistAdd",
      "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    );
    await vi.waitFor(() => expect(room.playlist).toHaveLength(1));
    expect(room.playlist[0].name).toBe("A video");
    yt.fetchYoutubeVideo.mockRejectedValueOnce(new Error("quota"));
    alex.socket.emit(
      "CMD:playlistAdd",
      "https://www.youtube.com/watch?v=bbbbbbbbbbb",
    );
    await vi.waitFor(() => expect(room.playlist).toHaveLength(2));
    expect(room.playlist[1]).toMatchObject({
      name: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
      channel: "Video URL",
    });
  });

  it("drops an add that finishes after the room was destroyed", async () => {
    let resolve!: (v: null) => void;
    yt.fetchYoutubeVideo.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const add = room.playlistAdd(
      null,
      "https://www.youtube.com/watch?v=ccccccccccc",
    );
    room.destroy();
    resolve(null);
    await add;
    expect(room.playlist).toEqual([]);
  });

  it("only advances for the video that ended", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", VIDEO);
    alex.socket.emit("CMD:playlistAdd", "https://example.com/n.mp4");
    await vi.waitFor(() => expect(room.playlist).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 1050));
    alex.socket.emit("CMD:playlistNext", "https://example.com/other.mp4");
    await barrier(alex.socket);
    expect(room.video).toBe(VIDEO);
    alex.socket.emit("CMD:playlistNext", VIDEO);
    await barrier(alex.socket);
    expect(room.video).toBe("https://example.com/n.mp4");
    // A duplicate right after the change is ignored
    alex.socket.emit("CMD:playlistNext", "https://example.com/n.mp4");
    await barrier(alex.socket);
    expect(room.video).toBe("https://example.com/n.mp4");
  });

  it("matches YouTube videos by id across URL forms", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", "https://www.youtube.com/watch?v=ddddddddddd");
    alex.socket.emit("CMD:playlistAdd", "https://example.com/after.mp4");
    await vi.waitFor(() => expect(room.playlist).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 1050));
    alex.socket.emit("CMD:playlistNext", "https://youtu.be/ddddddddddd");
    await barrier(alex.socket);
    expect(room.video).toBe("https://example.com/after.mp4");
  });
});

describe("screen and file share", () => {
  it("lets one person share at a time and only the sharer stop", async () => {
    const alex = await join();
    const sam = await join();
    const errors = collect<string>(sam.socket, "errorMessage");
    alex.socket.emit("CMD:joinScreenShare", null);
    alex.socket.emit("CMD:joinScreenShare", {});
    await barrier(alex.socket);
    expect(room.video).toBe("screenshare://" + alex.clientId);
    const rosters = collect<User[]>(sam.socket, "roster");
    sam.socket.emit("CMD:joinScreenShare", { file: true });
    sam.socket.emit("CMD:leaveScreenShare");
    await barrier(sam.socket);
    expect(errors).toEqual([
      "There is already an active share in this room",
      "Not the active sharer",
    ]);
    alex.socket.emit("CMD:leaveScreenShare");
    await barrier(alex.socket);
    expect(room.video).toBe("");
    await vi.waitFor(() =>
      expect(rosters.at(-1)?.some((u) => u.isScreenShare)).toBe(false),
    );
    sam.socket.emit("CMD:joinScreenShare", { file: true });
    await barrier(sam.socket);
    expect(room.video).toBe("fileshare://" + sam.clientId);
  });

  it("relays signaling messages to the addressed person only", async () => {
    const alex = await join();
    const sam = await join();
    const got = next<{ from: string; msg: string; sharer?: boolean }>(
      sam.socket,
      "signalSS",
    );
    alex.socket.emit("signalSS", null);
    alex.socket.emit("signalSS", { to: 5, msg: "x" });
    alex.socket.emit("signalSS", { to: "nobody", msg: "x" });
    alex.socket.emit("signalSS", {
      to: sam.clientId,
      msg: "sdp",
      sharer: true,
    });
    expect(await got).toEqual({
      from: alex.clientId,
      msg: "sdp",
      sharer: true,
    });
  });
});

describe("owner tools", () => {
  it("refuses owner-only commands from guests", async () => {
    const guest = await join({ guest: true });
    const errors = collect<string>(guest.socket, "errorMessage");
    guest.socket.emit("CMD:kickUser", { userToBeKicked: guest.clientId });
    guest.socket.emit("CMD:deleteChatMessages", {});
    guest.socket.emit("CMD:deleteRoom");
    await barrier(guest.socket);
    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors[0]).toBe("Only the room's owner can do that.");
  });

  it("kicks a guest from every tab and revokes their grant", async () => {
    const owner = await join();
    const g1 = await join({ guest: true, guestId: "guest-1" });
    const g2 = await join({ guest: true, guestId: "guest-1" });
    const other = await join({ guest: true, guestId: "guest-2" });
    const kicked = [next(g1.socket, "kicked"), next(g2.socket, "kicked")];
    owner.socket.emit("CMD:kickUser", null);
    owner.socket.emit("CMD:kickUser", { userToBeKicked: 5 });
    owner.socket.emit("CMD:kickUser", { userToBeKicked: "nobody" });
    owner.socket.emit("CMD:kickUser", { userToBeKicked: g1.clientId });
    await Promise.all(kicked);
    expect(room.access.isRevoked("guest-1")).toBe(true);
    expect(other.socket.connected).toBe(true);
    expect(JSON.parse(getRoom(db, "/" + ROOM)!.data!).access.revoked).toContain(
      "guest-1",
    );
  });

  it("kicking an owner only disconnects them", async () => {
    const owner = await join();
    const other = await join();
    const kicked = next(other.socket, "kicked");
    owner.socket.emit("CMD:kickUser", { userToBeKicked: other.clientId });
    await kicked;
    expect(room.access.serialize().revoked).toEqual([]);
  });

  it("deletes all chat, one person's messages or one message", async () => {
    const owner = await join();
    const sam = await join();
    owner.socket.emit("CMD:chat", "o1");
    sam.socket.emit("CMD:chat", "s1");
    await barrier(sam.socket);
    // Messages are identified by author + timestamp (ms): keep s1 and s2 apart
    await new Promise((r) => setTimeout(r, 5));
    sam.socket.emit("CMD:chat", "s2");
    owner.socket.emit("CMD:chat", "o2");
    await barrier(sam.socket);
    await barrier(owner.socket);
    const s1 = chatOf().find((m) => m.msg === "s1")!;
    owner.socket.emit("CMD:deleteChatMessages", null);
    owner.socket.emit("CMD:deleteChatMessages", {
      author: sam.clientId,
      timestamp: s1.timestamp,
    });
    await barrier(owner.socket);
    expect(chatOf().map((m) => m.msg)).toEqual(["o1", "s2", "o2"]);
    owner.socket.emit("CMD:deleteChatMessages", { author: owner.clientId });
    await barrier(owner.socket);
    expect(chatOf().map((m) => m.msg)).toEqual(["s2"]);
    owner.socket.emit("CMD:deleteChatMessages", {});
    await barrier(owner.socket);
    expect(chatOf()).toEqual([]);
  });

  it("rejects bad room passwords with a message", async () => {
    const owner = await join();
    const err = next(owner.socket, "errorMessage");
    owner.socket.emit("CMD:roomPassword", { action: "set", password: "x" });
    expect(await err).toBe("Room passwords need 4–64 characters.");
  });
});

describe("persistence", () => {
  it("restores serialized state", () => {
    const data = {
      video: VIDEO,
      videoTS: 12,
      subtitle: "/subtitle/x",
      paused: true,
      chat: [{ id: "a", msg: "hi", timestamp: "t" }],
      nameMap: { a: "Alex" },
      pictureMap: { a: "p.png" },
      playlist: [{ url: "u", name: "n" }],
      playbackRate: 2,
      loop: true,
      subtitleOffset: 1.5,
      subtitleScale: 1.01,
      videoMeta: { title: "M" },
      roomSettings: { title: "Night" },
      access: { password: "pw-pw-12", enabled: false, epoch: 3, revoked: [] },
    };
    const r = new Room(io, db, "/restored", JSON.stringify(data));
    try {
      expect(JSON.parse(r.serialize())).toMatchObject({
        video: VIDEO,
        videoTS: 12,
        subtitle: "/subtitle/x",
        paused: true,
        playbackRate: 2,
        loop: true,
        subtitleOffset: 1.5,
        subtitleScale: 1.01,
        nameMap: { a: "Alex" },
        access: { password: "pw-pw-12", enabled: false, epoch: 3 },
      });
      expect(r.roomSettings.title).toBe("Night");
    } finally {
      r.destroy();
    }
  });

  it("gives a legacy room a password and saves it right away", () => {
    const r = new Room(
      io,
      db,
      "/legacy",
      JSON.stringify({ video: "", videoTS: 0 }),
    );
    try {
      expect(r.access.password).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
      expect(getRoom(db, "/legacy")).toBeDefined();
    } finally {
      r.destroy();
    }
  });

  it("logs failed saves and refuses to delete when the database fails", () => {
    db.close();
    room.saveRoom();
    expect(console.warn).toHaveBeenCalledWith(
      "failed to save room %s:",
      "/" + ROOM,
      expect.anything(),
    );
    expect(room.deleteRoom(null)).toBe(false);
  });

  it("is a no-op after destroy", () => {
    room.destroy();
    expect(room.deleteRoom(null)).toBe(false);
    room.saveRoom();
    expect(getRoom(db, "/" + ROOM)).toBeUndefined();
  });

  it("falls back to no subtitle timing when it can't be loaded or saved", async () => {
    const alex = await join();
    saveSubtitleTiming(db, subtitleOffsetKey(VIDEO, null)!, {
      offset: 2,
      scale: 1,
    });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("subtitle_offsets")) {
        throw new Error("db down");
      }
      return prepare(sql);
    });
    alex.socket.emit("CMD:host", VIDEO);
    await barrier(alex.socket);
    expect(room.subtitleOffset).toBe(0);
    alex.socket.emit("CMD:subtitleOffset", 1);
    await barrier(alex.socket);
    expect(room.subtitleOffset).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      "failed to load subtitle offset:",
      expect.anything(),
    );
    expect(console.warn).toHaveBeenCalledWith(
      "failed to save subtitle offset:",
      expect.anything(),
    );
  });
});

describe("handler errors", () => {
  it("are contained and logged", async () => {
    const alex = await join();
    // A reaction to a prototype key makes the handler throw; the socket and room keep working
    alex.socket.emit("CMD:chat", "x");
    await barrier(alex.socket);
    const { id, timestamp } = chatOf()[0];
    alex.socket.emit("CMD:addReaction", {
      value: "toString",
      msgId: id,
      msgTimestamp: timestamp,
    });
    await barrier(alex.socket);
    expect(alex.socket.connected).toBe(true);
  });
});

describe("timers", () => {
  it("broadcasts positions every second while a video is set", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", VIDEO);
    await barrier(alex.socket);
    const maps = collect(alex.socket, "REC:tsMap");
    await vi.waitFor(() => expect(maps.length).toBeGreaterThan(0), {
      timeout: 2500,
    });
  });
});

describe("call and subtitle sync limits", () => {
  it("tells the ninth person the call is full", async () => {
    const people = [];
    for (let i = 0; i < 9; i++) {
      people.push(await join());
    }
    for (const [i, p] of people.slice(0, 8).entries()) {
      p.socket.emit("CMD:call", {
        action: "join",
        session: "sess_" + i + "_abcdef",
        muted: true,
      });
      await barrier(p.socket);
    }
    const last = people[8];
    const err = next(last.socket, "errorMessage");
    const state = next<CallState>(last.socket, "REC:callState");
    last.socket.emit("CMD:call", {
      action: "join",
      session: "sess_9_abcdef",
      muted: true,
    });
    expect(await err).toBe("The call is full (8 people).");
    expect((await state).members).toHaveLength(8);
  });

  it("releases a failed job, and reports done once attempts run out", async () => {
    const alex = await join();
    alex.socket.emit("CMD:host", VIDEO);
    alex.socket.emit("CMD:roomSettings", { autoSyncSubtitles: true });
    await barrier(alex.socket);
    const key = "room:https://subs.example.com/a.srt";
    const statuses = collect<{ status: string; offset?: unknown }>(
      alex.socket,
      "REC:subtitleSync",
    );
    for (let i = 0; i < 3; i++) {
      alex.socket.emit("CMD:subtitleSync", {
        action: "claim",
        video: VIDEO,
        key,
      });
      alex.socket.emit("CMD:subtitleSync", {
        action: "failed",
        video: VIDEO,
        key,
      });
    }
    // Nothing running any more: a late failure just repeats that it's done
    alex.socket.emit("CMD:subtitleSync", {
      action: "failed",
      video: VIDEO,
      key,
    });
    alex.socket.emit("CMD:subtitleSync", { action: "bogus" });
    await barrier(alex.socket);
    await vi.waitFor(() => expect(statuses).toHaveLength(7));
    expect(statuses.map((s) => s.status)).toEqual([
      "running",
      "released",
      "running",
      "released",
      "running",
      "done",
      "done",
    ]);
  });
});
