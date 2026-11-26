import { Server, Socket } from "socket.io";
import type { DatabaseSync } from "node:sqlite";
import {
  deleteRoomData,
  getSubtitleTiming,
  saveRoomData,
  saveSubtitleTiming,
} from "./utils/db.ts";
import {
  normalizeSubtitleOffset,
  normalizeSubtitleScale,
  parseSubtitleTiming,
  subtitleOffsetKey,
  subtitleTimingChatMsg,
  type SubtitleTiming,
} from "./utils/subtitleOffset.ts";
import { fetchYoutubeVideo, getYoutubeVideoID } from "./utils/youtube.ts";
import { HistoryRecorder, type PlaybackSnapshot } from "./utils/history.ts";
import {
  createIssueLimiter,
  parsePlaybackIssue,
  parsePlaylistAdd,
  parseVideoMetaCommand,
} from "./videoMeta.ts";
import {
  applyRoomSettingsPatch,
  createSettingsLimiter,
  DEFAULT_ROOM_SETTINGS,
  diffRoomSettings,
  normalizeRoomSettings,
  parseRoomSettingsPatch,
} from "./roomSettings.ts";
import {
  parseReadyReport,
  ReadyCheck,
  type ReadyCheckEffect,
} from "./readyCheck.ts";
import type { NextEpisodeResolver } from "./addons/nextEpisode.ts";
import { NextEpisodeController } from "./nextEpisodeController.ts";
import { IntroSkipTracker, introSkipStart } from "./introSkip.ts";
import { parseRoomPasswordCommand, RoomAccess } from "./roomAccess.ts";
import { nowPlayingChatLine, type NowPlayingVia } from "./nowPlaying.ts";
import {
  parseSubtitleSyncCommand,
  SubtitleAutoSync,
  type SubtitleSyncEnd,
} from "./subtitleAutoSync.ts";
import {
  CALL_LIMITS,
  CallMembership,
  createWindowLimiter,
  parseCallCommand,
  parseCallModeration,
  parseCallSignal,
} from "./callState.ts";

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
  /** Room-wide subtitle time scale (frame-rate drift): shown time = original × scale + offset, see setSubtitleTiming */
  public subtitleScale = 1;
  /** AIOStreams metadata for the current video (see CMD:videoMeta) */
  public videoMeta: VideoMeta | null = null;
  /** Room-wide settings (see CMD:roomSettings) */
  public roomSettings: RoomSettings = { ...DEFAULT_ROOM_SETTINGS };
  /** Guest access: room password, on/off, epoch, revoked guests (roomAccess.ts). Never sent to guests. */
  public access: RoomAccess = RoomAccess.create();

  // Non-serialized state
  public roomId: string;
  public roster: User[] = [];
  private lastTsMap = Date.now();
  private tsMap: NumberDict = {};
  private io: Server;
  private socketIdMap: StringDict = {};
  private tsInterval: NodeJS.Timeout | undefined = undefined;
  /** Last activity: moved forward by the save loop while people are in the room (see persistRooms) */
  public lastUpdateTime: Date = new Date();
  /** When this Room was loaded into memory (ms) */
  public readonly loadedAt = Date.now();
  /** Set by destroy(): no more saves, emits or host changes (late async work must not recreate the namespace) */
  private destroyed = false;
  /** Called after the room deleted itself (app.ts removes it from its `rooms` Map) */
  public static onDeleted: ((roomId: string) => void) | null = null;
  private preventTSUpdate = false;
  /** Positions reported before this time (ms) are ignored: they were sent before a seek reached the player */
  private ignoreTsUntil = 0;
  private db: DatabaseSync;
  private subtitleOffsetChatTimer: NodeJS.Timeout | undefined = undefined;
  /** How long the subtitle offset has to stay unchanged before it's announced in chat */
  public static SUBTITLE_OFFSET_CHAT_DELAY_MS = 1500;
  private issueLimiter = createIssueLimiter();
  private settingsLimiter = createSettingsLimiter();
  /** Pending chat announcement of settings changes: who changed them and what they were before */
  private settingsChat:
    | { actorId: string; before: RoomSettings; timer: NodeJS.Timeout }
    | undefined = undefined;
  /** How long the settings have to stay unchanged before the change is announced in chat */
  public static ROOM_SETTINGS_CHAT_DELAY_MS = 1500;
  /** Watch history / continue watching (utils/history.ts) */
  private history: HistoryRecorder;
  private readyCheck = new ReadyCheck();
  /** Skip intro for the current video (introSkip.ts) */
  private introSkip = new IntroSkipTracker();
  /** Room auto-sync of subtitles: who computes it, whether the result may be applied (subtitleAutoSync.ts) */
  private subtitleSync = new SubtitleAutoSync();
  /** How long a voice call member whose socket dropped stays in the call (tests shorten it) */
  public static CALL_GRACE_MS = CALL_LIMITS.graceMs;
  /** Voice call membership (callState.ts), in memory only: separate from the roster, never serialized */
  private call = new CallMembership({ graceMs: Room.CALL_GRACE_MS });
  private callExpiryTimer: NodeJS.Timeout | undefined = undefined;
  private callCommandLimiter = createWindowLimiter(
    CALL_LIMITS.commandMax,
    CALL_LIMITS.commandWindowMs,
  );
  private callSignalLimiter = createWindowLimiter(
    CALL_LIMITS.signalMax,
    CALL_LIMITS.signalWindowMs,
  );
  /** Next-episode lookups (set by app.ts when AIOStreams is configured) */
  public static nextEpisodeResolver: NextEpisodeResolver | null = null;
  private nextEpisode = new NextEpisodeController({
    video: () => this.video,
    videoMeta: () => this.videoMeta,
    playlistLength: () => this.playlist.length,
    loop: () => this.loop,
    offset: () => this.roomSettings.nextEpisodeOffset,
    resolver: () => Room.nextEpisodeResolver,
    emit: (state) => {
      if (!this.destroyed) {
        this.io.of(this.roomId).emit("REC:nextEpisode", state);
      }
    },
    play: (url, meta, by) => {
      const socket = by
        ? this.io.of(this.roomId).sockets.get(this.socketIdMap[by.id])
        : undefined;
      this.cmdHost(socket ?? null, url, meta, { via: "nextEpisode" });
    },
  });

  constructor(
    io: Server,
    db: DatabaseSync,
    roomId: string,
    roomData?: string | null | undefined,
    /** The stored lastUpdateTime (ms) of a room loaded from the database, so loading it doesn't count as activity */
    lastUpdateTime?: number,
  ) {
    this.roomId = roomId;
    this.io = io;
    this.db = db;
    if (lastUpdateTime !== undefined && Number.isFinite(lastUpdateTime)) {
      this.lastUpdateTime = new Date(lastUpdateTime);
    }
    this.history = new HistoryRecorder(db, roomId, {
      lookupYoutube: fetchYoutubeVideo,
    });

    if (roomData) {
      if (!this.deserialize(roomData)) {
        // A room from before room passwords just got one generated: persist it right away
        this.saveRoom();
      }
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
      if (this.roster.length) {
        this.history.tick(this.historySnapshot());
      }
      this.applyReadyCheck(this.readyCheck.tick(Date.now(), memberIds));
      // Auto-sync claims that never sent a result: announce the end so "X is syncing…" clears everywhere
      this.announceSubtitleSyncEnds(this.subtitleSync.expireStale(Date.now()));
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

      // Joining mid-play may pause the room first (ready check), so REC:host already says paused
      this.applyReadyCheck(
        this.readyCheck.join(clientId, this.readyCheckContext()),
      );
      socket.emit("REC:host", this.getHostState());
      socket.emit("REC:nameMap", this.nameMap);
      socket.emit("REC:pictureMap", this.pictureMap);
      socket.emit("REC:tsMap", this.tsMap);
      socket.emit("chatinit", this.chat);
      socket.emit("playlist", this.playlist);
      socket.emit("REC:videoMeta", this.videoMeta);
      socket.emit("REC:roomSettings", this.roomSettings);
      this.emitRoomAccess(socket);
      socket.emit("REC:readyCheck", this.readyCheck.getState());
      socket.emit("REC:nextEpisode", this.nextEpisode.snapshot());
      socket.emit("REC:callState", this.call.snapshot());
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
      // The current video's duration in seconds (for the history's finished flag)
      on("CMD:duration", (data: unknown) => {
        this.history.setDuration(this.video, data);
        if (
          this.introSkip.duration(this.video, data, this.videoTS) === "undo"
        ) {
          this.undoIntroSkip();
        }
      });
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
      on("CMD:subtitleTiming", (data: unknown) =>
        this.setSubtitleTiming(socket, data),
      );
      on("CMD:subtitleSync", (data: unknown) =>
        this.subtitleSyncCommand(socket, data),
      );
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
      // Managing the room and its people is for owners only (socket.data.owner is set by the
      // namespace auth middleware, admitRoomSockets in utils/roomAuth.ts; guests and unknown sockets are refused)
      const ownerOnly =
        (handler: (data: unknown) => unknown) => (data: unknown) => {
          if (!this.isOwner(socket)) {
            socket.emit("errorMessage", "Only the room's owner can do that.");
            return;
          }
          return handler(data);
        };
      on(
        "CMD:kickUser",
        ownerOnly((data) => this.kickUser(data)),
      );
      on(
        "CMD:deleteChatMessages",
        ownerOnly((data) => this.deleteChatMessages(data)),
      );
      on(
        "CMD:roomPassword",
        ownerOnly((data) => this.setRoomPassword(socket, data)),
      );
      on(
        "CMD:deleteRoom",
        ownerOnly(() => this.deleteRoom(this.getActor(socket))),
      );

      on("CMD:videoMeta", (data: unknown) => this.setVideoMeta(data));
      on("CMD:playbackIssue", (data: unknown) =>
        this.reportPlaybackIssue(socket, data),
      );
      on(
        "CMD:roomSettings",
        ownerOnly((data) => this.setRoomSettings(socket, data)),
      );
      on("CMD:nextEpisode", (data: unknown) => {
        const d = data as { action?: unknown; url?: unknown } | null;
        if (d?.action === "ended" && d.url === this.video) {
          // Played to the end: the history entry counts as finished before the next episode replaces it
          this.history.markEnded(this.video);
        }
        this.nextEpisode.command(data, this.getActor(socket));
      });

      on("CMD:readyState", (data: unknown) => this.setReadyState(socket, data));
      on("CMD:readyCheckSkip", () =>
        this.applyReadyCheck(this.readyCheck.skip(socket.clientId, Date.now())),
      );

      on("signalSS", (data: unknown) => this.sendSignal(socket, data));

      // Voice call (callState.ts): open to guests; moderation is for owners
      on("CMD:call", (data: unknown) => this.callCommand(socket, data));
      on("CMD:callSignal", (data: unknown) =>
        this.relayCallSignal(socket, data),
      );
      on(
        "CMD:callModerate",
        ownerOnly((data) => this.moderateCall(socket, data)),
      );

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
      subtitleScale: this.subtitleScale,
      videoMeta: this.videoMeta,
      roomSettings: this.roomSettings,
      access: this.access.serialize(),
    });
  };

  /** Returns whether the stored data had room access data (rooms from before room passwords don't) */
  private deserialize = (roomData: string): boolean => {
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
    this.subtitleScale = normalizeSubtitleScale(roomObj.subtitleScale) ?? 1;
    if (roomObj.videoMeta) {
      this.videoMeta = roomObj.videoMeta;
    }
    this.roomSettings = normalizeRoomSettings(roomObj.roomSettings);
    this.subtitleSync.reset(this.video, this.hasSubtitleTiming());
    this.access = RoomAccess.from(roomObj.access);
    return Boolean(roomObj.access);
  };

  public saveRoom = () => {
    if (this.destroyed) {
      return;
    }
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

  /**
   * Deletes the room for good (CMD:deleteRoom from an owner, DELETE /rooms/:roomId, the inactivity sweep): removes
   * its database rows (room + watch history), tells everyone connected (`REC:roomDeleted {by}`), disconnects them,
   * destroys the Room and calls Room.onDeleted so the server forgets it. The link 404s afterwards.
   */
  public deleteRoom = (by: PlaybackActor | null): boolean => {
    if (this.destroyed) {
      return false;
    }
    try {
      deleteRoomData(this.db, this.roomId);
    } catch (e) {
      console.warn("failed to delete room %s:", this.roomId, e);
      return false;
    }
    const ns = this.io.of(this.roomId);
    const info: RoomDeletedInfo = { by };
    ns.emit("REC:roomDeleted", info);
    ns.disconnectSockets();
    this.destroy();
    Room.onDeleted?.(this.roomId);
    return true;
  };

  public destroy = () => {
    this.destroyed = true;
    if (this.tsInterval) {
      clearInterval(this.tsInterval);
    }
    clearTimeout(this.subtitleOffsetChatTimer);
    clearTimeout(this.settingsChat?.timer);
    clearTimeout(this.callExpiryTimer);
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

  private historySnapshot = (): PlaybackSnapshot => ({
    video: this.video,
    meta: this.videoMeta,
    position: this.videoTS,
    paused: this.paused,
  });

  /** Starts a new room on a video, paused at `position` (POST /createRoom preload, POST /history/:id/resume) */
  public preloadVideo = (
    video: string,
    meta: VideoMeta | null = null,
    position = 0,
  ) => {
    this.video = video;
    this.videoMeta = meta;
    this.videoTS = position;
    this.paused = true;
    this.setLoadedTiming(this.loadSubtitleTiming(video, meta));
    this.subtitleSync.reset(video, this.hasSubtitleTiming());
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
      subtitleScale: this.subtitleScale,
    };
  };

  /**
   * Changes the room's video. `socket` is who chose it (chat: "Alex changed the video to …"); without one, `auto`
   * says why it changed on its own (the queue advanced, the next episode started), which posts a `nowPlaying` chat
   * line without a person.
   */
  private cmdHost = (
    socket: Socket | null,
    data: string,
    meta: VideoMeta | null = null,
    auto?: {
      via: NowPlayingVia;
      name?: string | null;
      /** Seconds, when the queue item knows it (YouTube); a too-short video isn't skipped into */
      duration?: number;
    },
  ) => {
    if ((data && data.length > 50000) || this.destroyed) {
      return;
    }
    this.history.beforeHostChange(this.historySnapshot());
    this.video = data;
    this.videoMeta = meta;
    // From the beginning, or past the intro when the room skips intros (the room's start time is authoritative:
    // every client seeks to REC:host's videoTS)
    this.videoTS = introSkipStart({
      skipIntro: this.roomSettings.skipIntro,
      video: data,
      knownDuration: auto?.duration,
    });
    this.introSkip.start(data, this.videoTS);
    this.history.setIntroSkip(data, this.videoTS);
    this.paused = false;
    this.subtitle = "";
    this.loop = false;
    this.playbackRate = 1;
    this.setLoadedTiming(this.loadSubtitleTiming(data, meta));
    this.subtitleSync.reset(data, this.hasSubtitleTiming());
    this.applyReadyCheck(this.readyCheck.reset(Date.now()));
    this.tsMap = {};
    this.preventTSUpdate = true;
    setTimeout(() => (this.preventTSUpdate = false), 1000);
    this.nextEpisode.reset();
    this.io.of(this.roomId).emit("REC:tsMap", this.tsMap);
    this.io.of(this.roomId).emit("REC:host", this.getHostState());
    this.io.of(this.roomId).emit("REC:videoMeta", this.videoMeta);
    if (this.videoTS > 0) {
      const info: IntroSkipInfo = { seconds: this.videoTS };
      this.io.of(this.roomId).emit("REC:introSkip", info);
    }
    if (socket && data) {
      const chatMsg = { id: socket.clientId, cmd: "host", msg: data };
      this.addChatMessage(socket, chatMsg);
    } else if (!socket && data && auto) {
      this.addChatMessage(
        null,
        nowPlayingChatLine(auto.via, data, meta, auto.name),
      );
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
    if (data) {
      // Clients send the URL that just ended
      this.history.markEnded(this.video);
    }
    const next = this.playlist.shift();
    this.io.of(this.roomId).emit("playlist", this.playlist);
    if (next) {
      this.cmdHost(null, next.url, next.meta ?? null, {
        via: "queue",
        name: next.name,
        duration: next.duration,
      });
      this.history.setHint(next.url, next);
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
    if (this.destroyed) {
      // Deleted or unloaded while the YouTube lookup ran
      return;
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
    this.applyReadyCheck(this.readyCheck.cancel(Date.now()));
    this.introSkip.interact();
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
    this.applyReadyCheck(this.readyCheck.cancel(Date.now()));
    this.introSkip.interact();
    socket.broadcast.emit("REC:pause", this.getActor(socket));
    const chatMsg = {
      id: socket.clientId,
      cmd: "pause",
      msg: this.tsMap[socket.clientId]?.toString(),
    };
    this.paused = true;
    this.addChatMessage(socket, chatMsg);
    this.history.save(this.historySnapshot());
  };

  private seekVideo = (socket: Socket, data: unknown) => {
    // Must be a real number: Number(null), Number("") etc. would silently become 0, and
    // NaN/Infinity serialize to null and break clients
    if (typeof data !== "number" || !Number.isFinite(data)) {
      return;
    }
    this.videoTS = data;
    this.nextEpisode.seek(data);
    // Someone picked a position (e.g. "Watch from start"): the skip is over, and positions count as watched again
    this.history.setIntroSkip(this.video, 0);
    this.endIntroSkip();
    // Forget everyone's old positions: otherwise drift correction pulls the room back to where it was
    this.tsMap = {};
    this.ignoreTsUntil = Date.now() + 1000;
    this.io.of(this.roomId).emit("REC:tsMap", this.tsMap);
    socket.broadcast.emit("REC:seek", data);
    const chatMsg = { id: socket.clientId, cmd: "seek", msg: data?.toString() };
    this.addChatMessage(socket, chatMsg);
    this.history.save(this.historySnapshot());
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
    // Prevent lagging TS updates from the old video (or from before a seek) from messing up our timestamps
    if (this.preventTSUpdate || Date.now() < this.ignoreTsUntil) {
      return;
    }
    // This is negative for live streams, so allow overwriting
    // Otherwise, only increment this value to prevent a lagging viewer from holding up the room state
    if (data < 0 || data > this.videoTS) {
      this.videoTS = data;
    }
    if (data < 0) {
      // A live stream: room time is relative to the live edge, so a skip had no effect; hide the notice
      this.endIntroSkip();
    }
    // Normalize the received TS based on how long since the last tsMap emit
    // Later sends will have higher values so subtract the difference
    // Add 1 as we will emit 1 second from the last one
    const timeSinceTsMap = Date.now() - this.lastTsMap;
    // console.log(socket.clientId, 'offset', offset, 'ms');
    this.tsMap[socket.clientId] = data - timeSinceTsMap / 1000 + 1;
    this.nextEpisode.tick(this.videoTS);
  };

  /** Forgets the current video's skip and hides everyone's "Skipped intro" notice */
  private endIntroSkip = () => {
    if (this.introSkip.clear()) {
      this.io.of(this.roomId).emit("REC:introSkip", null);
    }
  };

  /**
   * The skipped video turned out too short (CMD:duration) before anyone touched playback: everyone back to 0, like
   * a host change (reports from the skip point are ignored for a second), without a chat line.
   */
  private undoIntroSkip = () => {
    this.endIntroSkip();
    this.history.setIntroSkip(this.video, 0);
    this.videoTS = 0;
    this.nextEpisode.seek(0);
    this.tsMap = {};
    this.preventTSUpdate = true;
    setTimeout(() => (this.preventTSUpdate = false), 1000);
    const ns = this.io.of(this.roomId);
    ns.emit("REC:tsMap", this.tsMap);
    ns.emit("REC:seek", 0);
    if (!this.paused) {
      // A start past the end of the video left players paused at its end ("ended"): resume them
      ns.emit("REC:play", this.video);
    }
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
    this.history.metaAttached(this.historySnapshot());
    // The metadata gives the video a stable identity, so restore the offset saved for this title/episode
    const timing = this.loadSubtitleTiming(this.video, this.videoMeta);
    this.subtitleSync.offsetLoaded(timing.offset !== 0 || timing.scale !== 1);
    if (
      timing.offset !== this.subtitleOffset ||
      timing.scale !== this.subtitleScale
    ) {
      this.setLoadedTiming(timing);
      this.io.of(this.roomId).emit("REC:subtitleOffset", timing);
    }
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

  // --- Room settings ---

  /**
   * CMD:roomSettings (patch): validates and merges a partial update, broadcasts the full settings to everyone
   * (REC:roomSettings), and announces the change in chat once the settings stop changing. No-op patches are ignored
   * (and don't count against the rate limit).
   */
  private setRoomSettings = (socket: Socket, raw: unknown) => {
    const patch = parseRoomSettingsPatch(raw);
    if (!patch) {
      return;
    }
    const { settings, changed } = applyRoomSettingsPatch(
      this.roomSettings,
      patch,
    );
    if (!changed.length || !this.settingsLimiter.allow()) {
      return;
    }
    // Announce someone else's pending edits before applying this one, so they aren't attributed to them
    if (this.settingsChat && this.settingsChat.actorId !== socket.clientId) {
      this.flushSettingsChat();
    }
    const before = this.roomSettings;
    this.roomSettings = settings;
    this.io.of(this.roomId).emit("REC:roomSettings", this.roomSettings);
    if (!this.roomSettings.readyCheck) {
      // Turned off while waiting: stop waiting and play
      this.applyReadyCheck(this.readyCheck.disable(Date.now()));
    }
    this.queueSettingsChat(socket.clientId, before);
  };

  /**
   * Debounces the chat line: edits by the same person within ROOM_SETTINGS_CHAT_DELAY_MS are announced once, as one
   * `cmd: "roomSettings"` line per setting that ended up different. Another person's edit flushes the pending ones.
   */
  private queueSettingsChat = (actorId: string, before: RoomSettings) => {
    clearTimeout(this.settingsChat?.timer);
    this.settingsChat = {
      actorId,
      before: this.settingsChat?.before ?? before,
      timer: setTimeout(
        () => this.flushSettingsChat(),
        Room.ROOM_SETTINGS_CHAT_DELAY_MS,
      ),
    };
  };

  private flushSettingsChat = () => {
    const pending = this.settingsChat;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.settingsChat = undefined;
    for (const key of diffRoomSettings(pending.before, this.roomSettings)) {
      this.addChatMessage(null, {
        id: pending.actorId,
        cmd: "roomSettings",
        msg: JSON.stringify({ [key]: this.roomSettings[key] }),
      });
    }
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

  // --- Subtitle offset ---

  /** The saved timing for a video (offset 0, scale 1 when none was saved or it has no stable key) */
  private loadSubtitleTiming = (
    video: string | null,
    meta: VideoMeta | null = null,
  ): SubtitleTiming => {
    const none = { offset: 0, scale: 1 };
    const key = subtitleOffsetKey(video, meta);
    if (!key) {
      return none;
    }
    try {
      const saved = getSubtitleTiming(this.db, key);
      return saved
        ? {
            offset: normalizeSubtitleOffset(saved.offset) ?? 0,
            scale: normalizeSubtitleScale(saved.scale) ?? 1,
          }
        : none;
    } catch (e) {
      console.warn("failed to load subtitle offset:", e);
      return none;
    }
  };

  private setLoadedTiming = (timing: SubtitleTiming) => {
    this.subtitleOffset = timing.offset;
    this.subtitleScale = timing.scale;
  };

  /** Whether the room has a non-default subtitle timing */
  private hasSubtitleTiming = () =>
    this.subtitleOffset !== 0 || this.subtitleScale !== 1;

  /**
   * CMD:subtitleOffset: sets the room-wide offset (validated, clamped to ±24 h, rounded to 0.05 s) and keeps the time
   * scale (so ±0.1 s nudges don't undo a drift correction).
   */
  private setSubtitleOffset = (socket: Socket, data: unknown) => {
    const offset = normalizeSubtitleOffset(data);
    if (offset !== undefined) {
      this.commitSubtitleTiming(socket, { offset, scale: this.subtitleScale });
    }
  };

  /** CMD:subtitleTiming {offset, scale}: sets both (scale 0.9–1.1); Reset sends {offset: 0, scale: 1} */
  private setSubtitleTiming = (socket: Socket, data: unknown) => {
    const timing = parseSubtitleTiming(data);
    if (timing) {
      this.commitSubtitleTiming(socket, timing);
    }
  };

  /**
   * A timing set by hand: tells the others (REC:subtitleOffset {offset, scale, actor}), saves it for this video, and
   * announces it in chat once it stops changing.
   */
  private commitSubtitleTiming = (socket: Socket, timing: SubtitleTiming) => {
    this.setLoadedTiming(timing);
    this.subtitleSync.manualOffset();
    socket.broadcast.emit("REC:subtitleOffset", {
      ...timing,
      actor: this.getActor(socket),
    });
    this.saveCurrentSubtitleTiming();
    clearTimeout(this.subtitleOffsetChatTimer);
    this.subtitleOffsetChatTimer = setTimeout(() => {
      this.addChatMessage(socket, {
        id: socket.clientId,
        cmd: "subtitleOffset",
        msg: subtitleTimingChatMsg({
          offset: this.subtitleOffset,
          scale: this.subtitleScale,
        }),
      });
    }, Room.SUBTITLE_OFFSET_CHAT_DELAY_MS);
  };

  /** Saves the room's timing for the current video (when it has a stable key) */
  private saveCurrentSubtitleTiming = () => {
    const key = subtitleOffsetKey(this.video, this.videoMeta);
    if (key) {
      try {
        saveSubtitleTiming(this.db, key, {
          offset: this.subtitleOffset,
          scale: this.subtitleScale,
        });
      } catch (e) {
        console.warn("failed to save subtitle offset:", e);
      }
    }
  };

  /**
   * CMD:subtitleSync (room auto-sync, subtitleAutoSync.ts): grants one viewer the job per (video, subtitle), applies
   * its result room-wide (REC:subtitleOffset with `auto`, saved like a manual offset, a `subtitleAutoSync` chat line)
   * unless the offset was set by hand, and tells everyone (REC:subtitleSync).
   */
  private subtitleSyncCommand = (socket: Socket, raw: unknown) => {
    const cmd = parseSubtitleSyncCommand(raw);
    if (!cmd) {
      return;
    }
    const ns = this.io.of(this.roomId);
    const ctx = {
      enabled: this.roomSettings.autoSyncSubtitles,
      video: this.video,
      now: Date.now(),
    };
    const by = this.getActor(socket);
    const base = { video: cmd.video, key: cmd.key };
    if (cmd.action === "claim") {
      const outcome = this.subtitleSync.claim(socket.clientId, cmd, ctx);
      if (outcome.granted) {
        ns.emit("REC:subtitleSync", { status: "running", ...base, by });
      } else {
        socket.emit("REC:subtitleSync", {
          status: "denied",
          ...base,
          reason: outcome.reason,
        });
      }
      return;
    }
    if (cmd.action === "failed") {
      if (this.subtitleSync.failed(socket.clientId, cmd)) {
        ns.emit("REC:subtitleSync", { status: "released", ...base });
      } else if (this.subtitleSync.isDone(cmd.key)) {
        ns.emit("REC:subtitleSync", { status: "done", ...base, offset: null });
      }
      return;
    }
    const outcome = this.subtitleSync.result(socket.clientId, cmd, ctx);
    if (!outcome) {
      return;
    }
    const offset =
      outcome.apply && cmd.offset !== null
        ? normalizeSubtitleOffset(cmd.offset)
        : undefined;
    const scale = normalizeSubtitleScale(cmd.scale ?? 1);
    if (offset !== undefined && scale !== undefined) {
      this.setLoadedTiming({ offset, scale });
      ns.emit("REC:subtitleOffset", { offset, scale, actor: by, auto: true });
      this.saveCurrentSubtitleTiming();
      this.addChatMessage(socket, {
        id: socket.clientId,
        cmd: "subtitleAutoSync",
        msg: subtitleTimingChatMsg({ offset, scale }),
      });
    }
    const applied = offset !== undefined && scale !== undefined;
    ns.emit("REC:subtitleSync", {
      status: "done",
      ...base,
      by,
      offset: applied ? offset : null,
      ...(applied && scale !== 1 ? { scale } : {}),
    });
  };

  /**
   * Tells everyone that running auto-sync jobs ended without a result (the claimer left, or 3 min passed):
   * `released` (others try again) or, out of attempts, a final `done` with no offset. Clients clear "X is syncing…".
   */
  private announceSubtitleSyncEnds(ends: SubtitleSyncEnd[]) {
    const video = this.subtitleSync.getVideo();
    if (!video) {
      return;
    }
    for (const { key, status } of ends) {
      this.io
        .of(this.roomId)
        .emit(
          "REC:subtitleSync",
          status === "released"
            ? { status, video, key }
            : { status, video, key, offset: null },
        );
    }
  }

  // --- Ready check (see readyCheck.ts) ---

  private isReadyCheckOn = () => this.roomSettings.readyCheck;

  private readyCheckContext = () => ({
    // Only while a video is playing, and never for screen/file share (live)
    eligible:
      this.isReadyCheckOn() &&
      Boolean(this.video) &&
      !this.paused &&
      !this.getSharerId(),
    members: this.roster.map((u) => u.id),
    now: Date.now(),
  });

  /** CMD:readyState {ready, buffering?, time?} */
  private setReadyState = (socket: Socket, raw: unknown) => {
    const report = parseReadyReport(raw);
    if (report) {
      this.applyReadyCheck(
        this.readyCheck.report(
          socket.clientId,
          report,
          this.readyCheckContext(),
        ),
      );
    }
  };

  /**
   * Starting a check pauses everyone (no actor, so clients don't say "Alex paused") and lines them up at the
   * stalled viewer's position; ending it plays again unless a manual pause/play or a new video ended it.
   */
  private applyReadyCheck = (effect: ReadyCheckEffect | null) => {
    if (!effect) {
      return;
    }
    const ns = this.io.of(this.roomId);
    ns.emit("REC:readyCheck", this.readyCheck.getState());
    if (effect.type === "start") {
      this.paused = true;
      ns.emit("REC:pause");
      if (effect.seekTo !== undefined) {
        this.videoTS = effect.seekTo;
        ns.emit("REC:seek", effect.seekTo);
      }
    } else if (effect.type === "end" && effect.resume && this.video) {
      this.paused = false;
      ns.emit("REC:play", this.video);
    }
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

  // --- Voice call (see callState.ts) ---

  private emitCallState = () => {
    if (!this.destroyed) {
      this.io.of(this.roomId).emit("REC:callState", this.call.snapshot());
    }
  };

  /** Removes members whose grace period ran out, then waits for the next one */
  private scheduleCallExpiry = () => {
    clearTimeout(this.callExpiryTimer);
    this.callExpiryTimer = undefined;
    const next = this.call.nextExpiry();
    if (next === null || this.destroyed) {
      return;
    }
    this.callExpiryTimer = setTimeout(
      () => {
        if (this.call.expire(Date.now()).length) {
          this.emitCallState();
        }
        this.scheduleCallExpiry();
      },
      Math.max(0, next - Date.now()) + 5,
    );
  };

  /**
   * CMD:call {action: join|leave|state}. The client decides join-muted (video playing) and the camera, and keeps both
   * on a rejoin.
   */
  private callCommand = (socket: Socket, raw: unknown) => {
    const cmd = parseCallCommand(raw);
    if (!cmd || !this.callCommandLimiter.allow(socket.id)) {
      return;
    }
    const { clientId } = socket;
    if (cmd.action === "join") {
      const outcome = this.call.join(clientId, socket.id, cmd, Date.now());
      if (outcome === "full") {
        socket.emit(
          "errorMessage",
          `The call is full (${CALL_LIMITS.maxMembers} people).`,
        );
        // This socket gets the state anyway, so it stops waiting
        socket.emit("REC:callState", this.call.snapshot());
        return;
      }
      this.emitCallState();
      this.scheduleCallExpiry();
    } else if (cmd.action === "leave") {
      if (this.call.leave(clientId, socket.id)) {
        this.emitCallState();
      }
    } else if (this.call.setState(clientId, socket.id, cmd)) {
      this.emitCallState();
    }
  };

  /**
   * CMD:callSignal {to, toSession, description | candidate}: relayed as REC:callSignal only between two connected
   * call members, rebuilt from validated fields, size capped and rate limited per socket. The server sets `from`
   * and the sender's `session`.
   */
  private relayCallSignal = (socket: Socket, raw: unknown) => {
    if (!this.callSignalLimiter.allow(socket.id)) {
      return;
    }
    const signal = parseCallSignal(raw);
    if (!signal || !this.call.canRelay(socket.clientId, socket.id, signal.to)) {
      return;
    }
    const toSocket = this.call.socketOf(signal.to);
    const session = this.call.sessionOf(socket.clientId);
    if (!toSocket || !session) {
      return;
    }
    const { to: _to, ...payload } = signal;
    const event: CallSignalEvent = {
      ...payload,
      from: socket.clientId,
      session,
    };
    this.io.of(this.roomId).to(toSocket).emit("REC:callSignal", event);
  };

  /**
   * CMD:callModerate {action: mute|camera|remove, clientId} (owners only). Mute / camera ask their client to mute or to
   * turn the camera off (nobody can unmute you or turn your camera on); remove drops them from the call.
   */
  private moderateCall = (socket: Socket, raw: unknown) => {
    const cmd = parseCallModeration(raw);
    if (
      !cmd ||
      !this.call.has(cmd.clientId) ||
      !this.callCommandLimiter.allow(socket.id)
    ) {
      return;
    }
    const target = this.call.socketOf(cmd.clientId);
    const event: CallModeratedEvent = {
      action: cmd.action,
      by: this.getActor(socket),
    };
    // Tell them first, so their client explains the removal before the new state arrives
    if (target) {
      this.io.of(this.roomId).to(target).emit("REC:callModerated", event);
    }
    if (cmd.action === "remove") {
      this.call.remove(cmd.clientId);
      this.emitCallState();
    }
  };

  private onDisconnect = (socket: Socket) => {
    const { clientId } = socket;
    if (this.destroyed) {
      // The room was deleted: io.of() would recreate its namespace
      return;
    }
    this.callCommandLimiter.forget(socket.id);
    this.callSignalLimiter.forget(socket.id);
    // Whichever socket speaks for a call member (possibly an older one that a new tab took over from)
    if (this.call.disconnect(clientId, socket.id, Date.now())) {
      this.emitCallState();
      this.scheduleCallExpiry();
    }
    // Disconnecting socket is the current one
    if (socket.id === this.socketIdMap[clientId]) {
      let index = this.roster.findIndex((user) => user.id === clientId);
      if (index > -1) {
        this.roster.splice(index, 1);
      }
      this.io.of(this.roomId).emit("roster", this.getRosterForApp());
      delete this.tsMap[clientId];
      delete this.socketIdMap[clientId];
      this.applyReadyCheck(this.readyCheck.leave(clientId, Date.now()));
      this.announceSubtitleSyncEnds(this.subtitleSync.leave(clientId));
    }
    // Keep namemap/picturemap so old chat messages still render correctly after disconnect
    // When serializing we only write values with messages in chat
    // This will keep growing in memory until the room is unloaded
  };

  /** Owners only. Kicking a guest also revokes their grant, so they can't reconnect or rejoin from that browser. */
  private kickUser = (raw: unknown) => {
    const data = raw as { userToBeKicked?: unknown } | null;
    if (!data || typeof data.userToBeKicked !== "string") {
      return;
    }
    const target = this.io
      .of(this.roomId)
      .sockets.get(this.socketIdMap[data.userToBeKicked]);
    if (!target) {
      return;
    }
    const guestId: unknown = target.data?.guestId;
    const sockets = [target];
    if (!this.isOwner(target) && typeof guestId === "string") {
      this.access.revoke(guestId);
      this.saveRoom();
      // The same guest in other tabs/devices with this browser's grant
      for (const s of this.io.of(this.roomId).sockets.values()) {
        if (s !== target && s.data?.guestId === guestId) {
          sockets.push(s);
        }
      }
    }
    // Out of the call right away (no grace period)
    if (this.call.remove(data.userToBeKicked)) {
      this.emitCallState();
    }
    for (const s of sockets) {
      s.emit("kicked");
      s.disconnect();
    }
  };

  // --- Room password (guest access, see roomAccess.ts) ---

  private isOwner = (socket: Socket) => socket.data?.owner === true;

  /** REC:roomAccess: owners get the password, guests only whether one is required */
  private emitRoomAccess = (socket: Socket) => {
    const info: RoomAccessInfo = this.isOwner(socket)
      ? { enabled: this.access.enabled, password: this.access.password }
      : { enabled: this.access.enabled };
    socket.emit("REC:roomAccess", info);
  };

  /**
   * CMD:roomPassword (owners only): regenerate, set or turn the password on/off. A new password or turning it on
   * revokes every guest grant (the epoch changes), so connected guests are disconnected with REC:accessRevoked and
   * see the room password screen. The chat line never contains the password.
   */
  private setRoomPassword = (socket: Socket, raw: unknown) => {
    const cmd = parseRoomPasswordCommand(raw);
    if (!cmd) {
      socket.emit("errorMessage", "Room passwords need 4–64 characters.");
      return;
    }
    if (!this.settingsLimiter.allow()) {
      socket.emit(
        "errorMessage",
        "Too many changes at once. Wait a few seconds and try again.",
      );
      return;
    }
    const epoch = this.access.epoch;
    const change = this.access.apply(cmd);
    if (!change) {
      return;
    }
    this.saveRoom();
    const ns = this.io.of(this.roomId);
    for (const s of ns.sockets.values()) {
      if (this.access.epoch !== epoch && !this.isOwner(s)) {
        s.emit("REC:accessRevoked");
        s.disconnect();
      } else {
        this.emitRoomAccess(s);
      }
    }
    this.addChatMessage(null, {
      id: socket.clientId,
      cmd: "roomPassword",
      msg: change,
    });
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
