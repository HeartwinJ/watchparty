import { Server, Socket } from "socket.io";
import type { DatabaseSync } from "node:sqlite";
import {
  getSubtitleOffset,
  saveRoomData,
  saveSubtitleOffset,
} from "./utils/db.ts";
import {
  normalizeSubtitleOffset,
  subtitleOffsetKey,
} from "./utils/subtitleOffset.ts";
import { fetchYoutubeVideo, getYoutubeVideoID } from "./utils/youtube.ts";
import {
  createIssueLimiter,
  parsePlaybackIssue,
  parsePlaylistAdd,
  parseVideoMetaCommand,
} from "./videoMeta.ts";

// Extend the interface
declare module "socket.io" {
  interface Socket {
    clientId: string;
  }
}

// clientId spoof protection: clientIds are visible to everyone in the room, so the
// first connection claims it with a secret sessionId (generated and stored by the client)
// and later connections must present the same one. Kept in memory: after a restart the
// first connection re-claims it.
const SESSION_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessionClaims = new Map<
  string,
  { sessionId: string; expiresAt: number }
>();
export function claimClientId(
  clientId: string,
  sessionId: string,
  now = Date.now(),
): boolean {
  const existing = sessionClaims.get(clientId);
  if (
    existing &&
    existing.expiresAt > now &&
    existing.sessionId !== sessionId
  ) {
    return false;
  }
  if (!existing && sessionClaims.size >= 50000) {
    for (const [k, v] of sessionClaims) {
      if (v.expiresAt <= now) {
        sessionClaims.delete(k);
      }
    }
  }
  sessionClaims.set(clientId, {
    sessionId,
    expiresAt: now + SESSION_CLAIM_TTL_MS,
  });
  return true;
}

export class Room {
  // Serialized state
  public video: string | null = "";
  public videoTS = 0;
  public subtitle = "";
  public playbackRate = 1;
  public paused = false;
  public loop = false;
  private chat: ChatMessage[] = [];
  private nameMap: StringDict = {};
  private pictureMap: StringDict = {};
  public playlist: PlaylistVideo[] = [];
  /** Room-wide subtitle offset in seconds (positive = later), see setSubtitleOffset */
  public subtitleOffset = 0;
  /** AIOStreams metadata for the current video (see CMD:videoMeta) */
  public videoMeta: VideoMeta | null = null;

  // Non-serialized state
  public roomId: string;
  public roster: User[] = [];
  private lastTsMap = Date.now();
  private tsMap: NumberDict = {};
  private io: Server;
  private socketIdMap: StringDict = {};
  private tsInterval: NodeJS.Timeout | undefined = undefined;
  public lastUpdateTime: Date = new Date();
  private preventTSUpdate = false;
  private db: DatabaseSync;
  private subtitleOffsetChatTimer: NodeJS.Timeout | undefined = undefined;
  /** How long the subtitle offset has to stay unchanged before it's announced in chat */
  public static SUBTITLE_OFFSET_CHAT_DELAY_MS = 1500;
  private issueLimiter = createIssueLimiter();

  constructor(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    roomData?: string | null | undefined,
  ) {
    this.roomId = roomId;
    this.io = io;
    this.db = db;

    if (roomData) {
      this.deserialize(roomData);
    }

    this.tsInterval = setInterval(async () => {
      // console.log(roomId, this.video, this.roster, this.tsMap, this.nameMap);
      // Clean up the data of users who aren't in the room anymore
      const memberIds = this.roster.map((p) => p.id);
      Object.keys(this.tsMap).forEach((key) => {
        if (!memberIds.includes(key)) {
          delete this.tsMap[key];
        }
      });
      if (this.video) {
        this.lastTsMap = Date.now();
        io.of(roomId).emit("REC:tsMap", this.tsMap);
      }
    }, 1000);

    // clientId identifies a user within rooms (chat, names, signaling). See claimClientId.
    io.of(roomId).use(async (socket, next) => {
      try {
        const clientId = socket.handshake.query?.clientId;
        const sessionId = socket.handshake.auth.sessionId;
        if (typeof clientId !== "string") {
          next(new Error("Invalid clientId type"));
          return;
        }
        // validate clientId is UUID, prevents prototype pollution
        if (!isValidUUID(clientId)) {
          next(new Error("Invalid clientId format"));
          return;
        }
        if (
          typeof sessionId !== "string" ||
          sessionId.length < 16 ||
          sessionId.length > 200
        ) {
          next(new Error("Missing or invalid sessionId"));
          return;
        }
        if (!claimClientId(clientId, sessionId)) {
          next(new Error("Incorrect sessionId"));
          return;
        }

        // Disconnect other sockets with this clientId
        if (this.socketIdMap[clientId]) {
          io.of(roomId).sockets.get(this.socketIdMap[clientId])?.disconnect();
        }
        // Keep track of the current socketID associated with this client (only used for signaling and kicking)
        this.socketIdMap[clientId] = socket.id;
        if (!this.roster.find((user) => user.id === clientId)) {
          this.roster.push({ id: clientId });
        }

        next();
      } catch (e) {
        // Refuse the connection instead of leaving it hanging
        console.warn("socket auth failed for room %s:", this.roomId, e);
        next(new Error("Internal error"));
      }
    });
    io.of(roomId).on("connection", async (socket: Socket) => {
      const clientId = socket.handshake.query?.clientId;
      if (typeof clientId !== "string") {
        // We already validated in middleware above, this is just to satisfy TS
        return;
      }

      socket.emit("REC:host", this.getHostState());
      socket.emit("REC:nameMap", this.nameMap);
      socket.emit("REC:pictureMap", this.pictureMap);
      socket.emit("REC:tsMap", this.tsMap);
      socket.emit("chatinit", this.chat);
      socket.emit("playlist", this.playlist);
      socket.emit("REC:videoMeta", this.videoMeta);
      io.of(roomId).emit("roster", this.getRosterForApp());

      socket.clientId = clientId;
      // Handlers run on untrusted input. Contain any throw/rejection so one bad
      // message can't crash the whole process (and every room with it).
      const on = (event: string, handler: (...args: any[]) => unknown) => {
        socket.on(event, async (...args: any[]) => {
          try {
            await handler(...args);
          } catch (e) {
            console.warn("[%s] handler failed:", event, e);
          }
        });
      };

      on("CMD:name", (data: unknown) =>
        this.changeUserName(socket, String(data)),
      );
      on("CMD:picture", (data: unknown) =>
        this.changeUserPicture(socket, String(data)),
      );
      on("CMD:host", (data: unknown) => {
        this.startHosting(socket, String(data));
      });
      on("CMD:play", () => {
        this.playVideo(socket);
      });
      on("CMD:pause", () => {
        this.pauseVideo(socket);
      });
      on("CMD:seek", (data: unknown) => {
        this.seekVideo(socket, data);
      });
      on("CMD:playbackRate", (data: unknown) => {
        this.setPlaybackRate(socket, data);
      });
      on("CMD:loop", (data: unknown) => {
        this.setLoop(data);
      });
      on("CMD:ts", (data: unknown) => this.setTimestamp(socket, data));
      on("CMD:chat", (data: unknown) =>
        this.sendChatMessage(socket, String(data)),
      );
      on("CMD:chatV2", (data: unknown) => this.sendChatMessage(socket, data));
      on("CMD:addReaction", (data: unknown) => this.addReaction(socket, data));
      on("CMD:removeReaction", (data: unknown) => {
        this.removeReaction(socket, data);
      });
      on("CMD:joinScreenShare", (data) => {
        this.joinScreenSharing(socket, data);
      });
      on("CMD:leaveScreenShare", () => this.leaveScreenSharing(socket));
      on("CMD:subtitle", (data: unknown) => {
        this.addSubtitles(String(data));
      });
      on("CMD:subtitleOffset", (data: unknown) => {
        this.setSubtitleOffset(socket, data);
      });
      on("CMD:askHost", () => {
        socket.emit("REC:host", this.getHostState());
      });
      on("CMD:playlistNext", (data: unknown) => {
        this.playlistNext(data);
      });
      on("CMD:playlistAdd", (data: unknown) => {
        this.playlistAddCommand(socket, data);
      });
      on("CMD:playlistMove", (data: unknown) => {
        this.playlistMove(data);
      });
      on("CMD:playlistDelete", (data: unknown) => {
        this.playlistDelete(data);
      });
      // Everyone on the instance is trusted (they know the instance password)
      on("CMD:kickUser", (data: unknown) => this.kickUser(data));
      on("CMD:deleteChatMessages", (data: unknown) =>
        this.deleteChatMessages(data),
      );

      on("CMD:videoMeta", (data: unknown) => this.setVideoMeta(data));
      on("CMD:playbackIssue", (data: unknown) =>
        this.reportPlaybackIssue(socket, data),
      );

      on("signalSS", (data: unknown) => this.sendSignal(socket, data));

      on("disconnect", () => this.onDisconnect(socket));
    });
  }

  public serialize = () => {
    // Get the set of IDs with messages in chat
    // Only serialize roster and picture ID for those people, to save space
    const chatIDs = new Set(this.chat.map((msg) => msg.id));
    const abbrNameMap: StringDict = {};
    Object.keys(this.nameMap).forEach((id) => {
      if (chatIDs.has(id)) {
        abbrNameMap[id] = this.nameMap[id];
      }
    });
    const abbrPictureMap: StringDict = {};
    Object.keys(this.pictureMap).forEach((id) => {
      if (chatIDs.has(id)) {
        abbrPictureMap[id] = this.pictureMap[id];
      }
    });
    return JSON.stringify({
      video: this.video,
      videoTS: this.videoTS,
      subtitle: this.subtitle,
      playbackRate: this.playbackRate,
      paused: this.paused,
      chat: this.chat,
      nameMap: abbrNameMap,
      pictureMap: abbrPictureMap,
      playlist: this.playlist,
      loop: this.loop,
      subtitleOffset: this.subtitleOffset,
      videoMeta: this.videoMeta,
    });
  };

  private deserialize = (roomData: string) => {
    const roomObj = JSON.parse(roomData);
    this.video = roomObj.video;
    this.videoTS = roomObj.videoTS;
    if (roomObj.subtitle) {
      this.subtitle = roomObj.subtitle;
    }
    if (roomObj.paused) {
      this.paused = roomObj.paused;
    }
    if (roomObj.chat) {
      this.chat = roomObj.chat;
    }
    if (roomObj.nameMap) {
      this.nameMap = roomObj.nameMap;
    }
    if (roomObj.pictureMap) {
      this.pictureMap = roomObj.pictureMap;
    }
    if (roomObj.playlist) {
      this.playlist = roomObj.playlist;
    }
    if (roomObj.playbackRate) {
      this.playbackRate = roomObj.playbackRate;
    }
    if (roomObj.loop) {
      this.loop = roomObj.loop;
    }
    this.subtitleOffset = normalizeSubtitleOffset(roomObj.subtitleOffset) ?? 0;
    if (roomObj.videoMeta) {
      this.videoMeta = roomObj.videoMeta;
    }
  };

  public saveRoom = () => {
    try {
      saveRoomData(
        this.db,
        this.roomId,
        this.serialize(),
        Number(this.lastUpdateTime ?? new Date()),
      );
    } catch (e) {
      console.warn("failed to save room %s:", this.roomId, e);
    }
  };

  public destroy = () => {
    if (this.tsInterval) {
      clearInterval(this.tsInterval);
    }
    clearTimeout(this.subtitleOffsetChatTimer);
    // Unregister the namespace so it doesn't linger (or get duplicated on reload)
    this.io._nsps.delete(this.roomId);
  };

  protected getSharerId = (): string => {
    let sharerId = "";
    if (this.video?.startsWith("screenshare://")) {
      sharerId = this.video?.slice("screenshare://".length).split("@")[0];
    } else if (this.video?.startsWith("fileshare://")) {
      sharerId = this.video?.slice("fileshare://".length).split("@")[0];
    }
    return sharerId;
  };

  protected getRosterForApp = (): User[] => {
    return this.roster.map((p) => {
      return {
        ...p,
        isScreenShare: p.id === this.getSharerId(),
      };
    });
  };

  private getHostState = (): HostState => {
    return {
      video: this.video ?? "",
      videoTS: this.videoTS,
      subtitle: this.subtitle,
      playbackRate: this.playbackRate,
      paused: this.paused,
      loop: this.loop,
      subtitleOffset: this.subtitleOffset,
    };
  };

  private cmdHost = (
    socket: Socket | null,
    data: string,
    meta: VideoMeta | null = null,
  ) => {
    if (data && data.length > 50000) {
      return;
    }
    this.video = data;
    this.videoMeta = meta;
    this.videoTS = 0;
    this.paused = false;
    this.subtitle = "";
    this.loop = false;
    this.playbackRate = 1;
    this.subtitleOffset = this.loadSubtitleOffset(data);
    this.tsMap = {};
    this.preventTSUpdate = true;
    setTimeout(() => (this.preventTSUpdate = false), 1000);
    this.io.of(this.roomId).emit("REC:tsMap", this.tsMap);
    this.io.of(this.roomId).emit("REC:host", this.getHostState());
    this.io.of(this.roomId).emit("REC:videoMeta", this.videoMeta);
    if (socket && data) {
      const chatMsg = { id: socket.clientId, cmd: "host", msg: data };
      this.addChatMessage(socket, chatMsg);
    }
    if (data === "") {
      this.playlistNext(null);
    }
    // Resend the roster (updates screenshare state etc)
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  public addChatMessage = (socket: Socket | null, chatMsg: ChatMessageBase) => {
    const chatWithTime: ChatMessage = {
      ...chatMsg,
      timestamp: new Date().toISOString(),
      videoTS: socket?.clientId ? this.tsMap[socket.clientId] : undefined,
    };
    this.chat.push(chatWithTime);
    this.chat = this.chat.splice(-100);
    this.io.of(this.roomId).emit("REC:chat", chatWithTime);
  };

  private changeUserName = (socket: Socket, data: string) => {
    if (!data) {
      return;
    }
    if (data && data.length > 50) {
      return;
    }
    this.nameMap[socket.clientId] = data;
    this.io.of(this.roomId).emit("REC:nameMap", this.nameMap);
  };

  private changeUserPicture = (socket: Socket, data: string) => {
    if (data && data.length > 10000) {
      return;
    }
    this.pictureMap[socket.clientId] = data;
    this.io.of(this.roomId).emit("REC:pictureMap", this.pictureMap);
  };

  private startHosting = (socket: Socket, data: string) => {
    this.cmdHost(socket, data);
  };

  private playlistNext = (raw: unknown) => {
    const data = raw ? String(raw) : null;
    if (data && this.preventTSUpdate) {
      return;
    }
    const dataYtId = data ? getYoutubeVideoID(data) : undefined;
    const videoYtId = this.video ? getYoutubeVideoID(this.video) : undefined;
    // Clients may pass the URL that should be the current one.
    // If we've already advanced the playlist, we can ignore duplicate calls
    if (
      data &&
      this.video &&
      data !== this.video &&
      (!dataYtId || !videoYtId || dataYtId !== videoYtId)
    ) {
      // Validation didn't match
      return;
    }
    const next = this.playlist.shift();
    this.io.of(this.roomId).emit("playlist", this.playlist);
    if (next) {
      this.cmdHost(null, next.url, next.meta ?? null);
    }
  };

  public playlistAdd = async (
    socket: Socket | null,
    data: string,
    extra?: { name: string | null; img: string | null; meta: VideoMeta | null },
  ) => {
    if (typeof data !== "string" || !data || data.length > 20000) {
      return;
    }
    const youtubeVideoId = getYoutubeVideoID(data);
    const item: PlaylistVideo = {
      name: extra?.name || data,
      channel: extra?.meta ? "Movies & Shows" : "Video URL",
      duration: 0,
      url: data,
      type: "file",
      ...(extra?.img ? { img: extra.img } : {}),
      ...(extra?.meta ? { meta: extra.meta } : {}),
    };
    let video: PlaylistVideo | null = null;
    try {
      if (youtubeVideoId) {
        video = await fetchYoutubeVideo(youtubeVideoId);
      }
    } catch (e) {
      // Failed to fetch YouTube video info but can still add the URL
      console.warn(e);
    }
    if (video) {
      this.playlist.push(video);
    } else {
      this.playlist.push(item);
    }
    this.io.of(this.roomId).emit("playlist", this.playlist);
    const clientId = socket?.clientId;
    if (clientId) {
      const chatMsg = {
        id: clientId,
        cmd: "playlistAdd",
        msg: data,
      };
      this.addChatMessage(socket, chatMsg);
    }
    if (!this.video) {
      this.playlistNext(null);
    }
  };

  private playlistDelete = (index: unknown) => {
    // splice() treats NaN as 0 and negatives as offsets from the end, so be strict
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.playlist.length
    ) {
      return;
    }
    this.playlist.splice(index, 1);
    this.io.of(this.roomId).emit("playlist", this.playlist);
  };

  private playlistMove = (raw: unknown) => {
    const data = raw as { index: number; toIndex: number } | null;
    if (!data) {
      return;
    }
    const { index, toIndex } = data;
    const len = this.playlist.length;
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(toIndex) ||
      index < 0 ||
      index >= len ||
      toIndex < 0 ||
      toIndex >= len
    ) {
      return;
    }
    const [item] = this.playlist.splice(index, 1);
    this.playlist.splice(toIndex, 0, item);
    this.io.of(this.roomId).emit("playlist", this.playlist);
  };

  /** Who sent a play/pause, so the others can show "Alex paused" (older clients ignore the extra argument) */
  private getActor = (socket: Socket): PlaybackActor => ({
    id: socket.clientId,
    name: this.nameMap[socket.clientId],
  });

  private playVideo = (socket: Socket) => {
    socket.broadcast.emit("REC:play", this.video, this.getActor(socket));
    const chatMsg = {
      id: socket.clientId,
      cmd: "play",
      msg: this.tsMap[socket.clientId]?.toString(),
    };
    this.paused = false;
    this.addChatMessage(socket, chatMsg);
  };

  private pauseVideo = (socket: Socket) => {
    socket.broadcast.emit("REC:pause", this.getActor(socket));
    const chatMsg = {
      id: socket.clientId,
      cmd: "pause",
      msg: this.tsMap[socket.clientId]?.toString(),
    };
    this.paused = true;
    this.addChatMessage(socket, chatMsg);
  };

  private seekVideo = (socket: Socket, data: unknown) => {
    // Must be a real number: Number(null), Number("") etc. would silently become 0, and
    // NaN/Infinity serialize to null and break clients
    if (typeof data !== "number" || !Number.isFinite(data)) {
      return;
    }
    this.videoTS = data;
    socket.broadcast.emit("REC:seek", data);
    const chatMsg = { id: socket.clientId, cmd: "seek", msg: data?.toString() };
    this.addChatMessage(socket, chatMsg);
  };

  private setPlaybackRate = (socket: Socket, data: unknown) => {
    // Browsers only support rates in roughly this range, anything else is garbage
    if (
      typeof data !== "number" ||
      !Number.isFinite(data) ||
      data < 0.0625 ||
      data > 16
    ) {
      return;
    }
    this.playbackRate = data;
    this.io.of(this.roomId).emit("REC:playbackRate", data);
    const chatMsg = {
      id: socket.clientId,
      cmd: "playbackRate",
      msg: data?.toString(),
    };
    this.addChatMessage(socket, chatMsg);
  };

  private setLoop = (data: unknown) => {
    if (typeof data !== "boolean") {
      return;
    }
    this.loop = data;
    this.io.of(this.roomId).emit("REC:loop", data);
  };

  private setTimestamp = (socket: Socket, data: unknown) => {
    if (typeof data !== "number" || !Number.isFinite(data)) {
      return;
    }
    // Prevent lagging TS updates from the old video from messing up our timestamps
    if (this.preventTSUpdate) {
      return;
    }
    // This is negative for live streams, so allow overwriting
    // Otherwise, only increment this value to prevent a lagging viewer from holding up the room state
    if (data < 0 || data > this.videoTS) {
      this.videoTS = data;
    }
    // Normalize the received TS based on how long since the last tsMap emit
    // Later sends will have higher values so subtract the difference
    // Add 1 as we will emit 1 second from the last one
    const timeSinceTsMap = Date.now() - this.lastTsMap;
    // console.log(socket.clientId, 'offset', offset, 'ms');
    this.tsMap[socket.clientId] = data - timeSinceTsMap / 1000 + 1;
  };

  private isValidChatMessage = (msg: string | undefined) => {
    return Boolean(msg && msg.length <= 10000);
  };

  private sendChatMessage = (socket: Socket, raw: unknown) => {
    // Support legacy string and V2 object chat payloads.
    const payload = typeof raw === "string" ? { msg: raw } : raw;
    if (!payload || typeof payload !== "object") {
      return;
    }

    // Validate supported fields.
    const data = payload as Record<string, unknown>;
    const msg = typeof data.msg === "string" ? data.msg : undefined;
    const replyToId =
      typeof data.replyToId === "string" ? data.replyToId : undefined;
    const replyToTimestamp =
      typeof data.replyToTimestamp === "string"
        ? data.replyToTimestamp
        : undefined;

    if (!msg || !this.isValidChatMessage(msg)) {
      return;
    }

    // Require both reply fields or neither.
    if (Boolean(replyToId) !== Boolean(replyToTimestamp)) {
      return;
    }

    const baseMsg: ChatMessageBase = { id: socket.clientId, msg };
    const emitChatMessage = (chatMsg: ChatMessageBase) => {
      this.addChatMessage(socket, chatMsg);
    };

    // No reply metadata -> regular message.
    if (!replyToId || !replyToTimestamp) {
      emitChatMessage(baseMsg);
      return;
    }

    const target = this.chat.find(
      (m) => m.id === replyToId && m.timestamp === replyToTimestamp,
    );
    // Missing target -> fall back to regular message.
    if (!target) {
      emitChatMessage(baseMsg);
      return;
    }

    emitChatMessage({
      ...baseMsg,
      replyToId,
      replyToTimestamp,
      replyToUserId: replyToId,
      replyToMsg: target.msg || "",
    });
  };

  private addReaction = (socket: Socket, raw: unknown) => {
    const data = raw as { value: string; msgId: string; msgTimestamp: string };
    if (!data || !data.value || !data.msgId || !data.msgTimestamp) {
      return;
    }
    // Emojis can be multiple bytes
    if (data.value.length > 8) {
      return;
    }
    const msg = this.chat.find(
      (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
    );
    if (!msg) {
      return;
    }
    msg.reactions = msg.reactions || {};
    msg.reactions[data.value] = msg.reactions[data.value] || [];

    if (!msg.reactions[data.value].includes(socket.clientId)) {
      msg.reactions[data.value].push(socket.clientId);
      const reaction: Reaction = { user: socket.clientId, ...data };
      this.io.of(this.roomId).emit("REC:addReaction", reaction);
    }
  };

  private removeReaction = (socket: Socket, raw: unknown) => {
    const data = raw as { value: string; msgId: string; msgTimestamp: string };
    if (!data || !data.value || !data.msgId || !data.msgTimestamp) {
      return;
    }
    // Emojis can be multiple bytes
    if (data.value.length > 8) {
      return;
    }
    const msg = this.chat.find(
      (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
    );
    if (!msg || !msg.reactions?.[data.value]) {
      return;
    }
    msg.reactions[data.value] = msg.reactions[data.value].filter(
      (id) => id !== socket.clientId,
    );
    const reaction: Reaction = { user: socket.clientId, ...data };
    this.io.of(this.roomId).emit("REC:removeReaction", reaction);
  };

  // CMD:playlistAdd: a URL string, or {url, name?, img?, meta?} from the source picker
  private playlistAddCommand = (socket: Socket, raw: unknown) => {
    const item = parsePlaylistAdd(raw);
    if (item) {
      return this.playlistAdd(socket, item.url, item);
    }
  };

  // CMD:videoMeta {url, meta}: describes the current video. Ignored unless `url` is still the room's video, so a
  // late message can't attach metadata to something else. Cleared by cmdHost whenever the video changes.
  private setVideoMeta = (raw: unknown) => {
    const data = parseVideoMetaCommand(raw);
    if (!data || !this.video || data.url !== this.video) {
      return;
    }
    this.videoMeta = data.meta;
    this.io.of(this.roomId).emit("REC:videoMeta", this.videoMeta);
  };

  // CMD:playbackIssue {reason}: this viewer's browser can't play the video. Rate limited, then shown to everyone.
  private reportPlaybackIssue = (socket: Socket, raw: unknown) => {
    const reason = parsePlaybackIssue(raw);
    if (!reason || !this.video || !this.issueLimiter.allow(socket.clientId)) {
      return;
    }
    const issue: PlaybackIssue = {
      userId: socket.clientId,
      name: this.nameMap[socket.clientId] || "Someone",
      reason,
    };
    this.io.of(this.roomId).emit("REC:playbackIssue", issue);
  };

  private joinScreenSharing = (socket: Socket, raw: unknown) => {
    const data = raw as { file?: boolean } | null;
    if (!data) {
      return;
    }
    const sharer = this.getRosterForApp().find((user) => user.isScreenShare);
    if (sharer) {
      // Someone's already sharing
      socket.emit(
        "errorMessage",
        "There is already an active share in this room",
      );
      return;
    }
    if (data.file) {
      this.cmdHost(socket, "fileshare://" + socket.clientId);
    } else {
      this.cmdHost(socket, "screenshare://" + socket.clientId);
    }
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  private leaveScreenSharing = (socket: Socket) => {
    const sharer = this.getRosterForApp().find((user) => user.isScreenShare);
    if (!sharer || sharer?.id !== socket.clientId) {
      socket.emit("errorMessage", "Not the active sharer");
      return;
    }
    this.cmdHost(socket, "");
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  private addSubtitles = async (data: string) => {
    if (data && data.length > 10000) {
      return;
    }
    this.subtitle = data;
    this.io.of(this.roomId).emit("REC:subtitle", this.subtitle);
  };

  // --- Subtitle offset (PLAN 6b) ---

  /** The saved offset for a video (0 when none was saved or it has no stable key) */
  private loadSubtitleOffset = (video: string | null) => {
    const key = subtitleOffsetKey(video);
    if (!key) {
      return 0;
    }
    try {
      return normalizeSubtitleOffset(getSubtitleOffset(this.db, key)) ?? 0;
    } catch (e) {
      console.warn("failed to load subtitle offset:", e);
      return 0;
    }
  };

  /**
   * CMD:subtitleOffset: sets the room-wide offset (validated, clamped to ±30 s, rounded to 0.05 s), tells the others
   * (REC:subtitleOffset), saves it for this video, and announces it in chat once it stops changing.
   */
  private setSubtitleOffset = (socket: Socket, data: unknown) => {
    const offset = normalizeSubtitleOffset(data);
    if (offset === undefined) {
      return;
    }
    this.subtitleOffset = offset;
    socket.broadcast.emit("REC:subtitleOffset", {
      offset,
      actor: this.getActor(socket),
    });
    const key = subtitleOffsetKey(this.video);
    if (key) {
      try {
        saveSubtitleOffset(this.db, key, offset);
      } catch (e) {
        console.warn("failed to save subtitle offset:", e);
      }
    }
    clearTimeout(this.subtitleOffsetChatTimer);
    this.subtitleOffsetChatTimer = setTimeout(() => {
      this.addChatMessage(socket, {
        id: socket.clientId,
        cmd: "subtitleOffset",
        msg: String(this.subtitleOffset),
      });
    }, Room.SUBTITLE_OFFSET_CHAT_DELAY_MS);
  };

  private sendSignal = (socket: Socket, raw: unknown) => {
    const data = raw as { to: string; msg: string; sharer?: boolean } | null;
    if (!data || typeof data.to !== "string") {
      return;
    }
    const fromClientId = socket.clientId;
    const toId = this.socketIdMap[data.to];
    if (toId) {
      this.io.of(this.roomId).to(toId).emit("signalSS", {
        from: fromClientId,
        msg: data.msg,
        sharer: data.sharer,
      });
    }
  };

  private onDisconnect = (socket: Socket) => {
    const { clientId } = socket;
    // Disconnecting socket is the current one
    if (socket.id === this.socketIdMap[clientId]) {
      let index = this.roster.findIndex((user) => user.id === clientId);
      if (index > -1) {
        this.roster.splice(index, 1);
      }
      this.io.of(this.roomId).emit("roster", this.getRosterForApp());
      delete this.tsMap[clientId];
      delete this.socketIdMap[clientId];
    }
    // Keep namemap/picturemap so old chat messages still render correctly after disconnect
    // When serializing we only write values with messages in chat
    // This will keep growing in memory until the room is unloaded
  };

  private kickUser = async (raw: unknown) => {
    const data = raw as { userToBeKicked: string };
    if (!data) {
      return;
    }
    const userToBeKickedSocket = this.io
      .of(this.roomId)
      .sockets.get(this.socketIdMap[data.userToBeKicked]);
    if (userToBeKickedSocket) {
      userToBeKickedSocket.emit("kicked");
      userToBeKickedSocket.disconnect();
    }
  };

  private deleteChatMessages = async (raw: unknown) => {
    const data = raw as {
      author: string;
      timestamp: string | undefined;
    };
    if (!data) {
      return;
    }
    if (!data.timestamp && !data.author) {
      this.chat.length = 0;
    } else {
      this.chat = this.chat.filter((msg) => {
        if (data.timestamp) {
          return msg.id !== data.author || msg.timestamp !== data.timestamp;
        }
        return msg.id !== data.author;
      });
    }
    this.io.of(this.roomId).emit("chatinit", this.chat);
    return;
  };
}

function isValidUUID(id: string) {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[4][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(
    id,
  );
}
