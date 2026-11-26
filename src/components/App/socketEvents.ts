// Typed Socket.IO events for a room namespace. Names and payloads mirror server/room.ts; don't change them here
// without changing the server.
import type { Socket } from "socket.io-client";

/** WebRTC signaling message relayed by the server between the sharer and viewers */
export type SignalMessage = {
  ice?: RTCIceCandidateInit;
  sdp?: RTCSessionDescriptionInit | null;
};

export interface ServerToClientEvents {
  errorMessage: (err: string) => void;
  successMessage: (msg: string) => void;
  kicked: () => void;
  /** `actor` (who pressed play) is sent by newer servers */
  "REC:play": (video?: string, actor?: PlaybackActor) => void;
  "REC:pause": (actor?: PlaybackActor) => void;
  /** Someone else changed the room-wide subtitle offset (not echoed to the sender) */
  "REC:subtitleOffset": (data: {
    offset: number;
    /** Time scale for frame-rate drift (cues at original × scale + offset); missing from older servers */
    scale?: number;
    actor?: PlaybackActor;
    /** Applied by the room's auto-sync (sent to everyone, including `actor`) */
    auto?: boolean;
  }) => void;
  /** Room auto-sync of subtitles: who's computing it, and the outcome (see server/subtitleAutoSync.ts) */
  "REC:subtitleSync": (event: SubtitleSyncEvent) => void;
  "REC:seek": (time: number) => void;
  "REC:playbackRate": (rate: number) => void;
  "REC:subtitle": (url: string) => void;
  "REC:loop": (loop: boolean) => void;
  "REC:host": (state: HostState) => void;
  "REC:chat": (msg: ChatMessage) => void;
  "REC:addReaction": (reaction: Reaction) => void;
  "REC:removeReaction": (reaction: Reaction) => void;
  "REC:tsMap": (tsMap: NumberDict) => void;
  "REC:nameMap": (nameMap: StringDict) => void;
  "REC:pictureMap": (pictureMap: StringDict) => void;
  roster: (users: User[]) => void;
  chatinit: (chat: ChatMessage[]) => void;
  playlist: (playlist: PlaylistVideo[]) => void;
  /** AIOStreams metadata of the current video, null when it has none (cleared on every host change) */
  "REC:videoMeta": (meta: VideoMeta | null) => void;
  /** Someone's browser can't play the current video */
  "REC:playbackIssue": (issue: PlaybackIssue) => void;
  /** The full room-wide settings: sent on connect and after every change (to everyone, including the sender) */
  "REC:roomSettings": (settings: RoomSettings) => void;
  /** Ready check state (sent on connect and whenever it changes) */
  "REC:readyCheck": (state: ReadyCheckState) => void;
  /** The room password state: owners get the password, guests only whether it's on (sent on connect and on change) */
  "REC:roomAccess": (info: RoomAccessInfo) => void;
  /** Guests: an owner changed the room password or turned it on, so this guest's access ended (then disconnected) */
  "REC:accessRevoked": () => void;
  /** An owner deleted the room; the server disconnects everyone right after */
  "REC:roomDeleted": (info: RoomDeletedInfo) => void;
  /** The room-wide next-episode card (also sent on connect) */
  "REC:nextEpisode": (state: NextEpisodeState) => void;
  signalSS: (data: {
    msg: SignalMessage;
    from: string;
    sharer: boolean;
  }) => void;
  /** Everyone in the voice call (sent on connect and on every change) */
  "REC:callState": (state: CallState) => void;
  /** A WebRTC signal from another call member (see call/transport.ts) */
  "REC:callSignal": (signal: CallSignalEvent) => void;
  /** An owner asked us to mute, or removed us from the call */
  "REC:callModerated": (event: CallModeratedEvent) => void;
}

type ReactionPayload = Omit<Reaction, "user">;

/** A queue item with a readable name (and AIOStreams metadata), as sent by the source picker */
export type PlaylistAddItem = {
  url: string;
  name?: string;
  img?: string;
  meta?: VideoMeta;
};

/**
 * `offer`: this player is within the card's window of the end (the server keeps the first one per video).
 * `ended`: this player reached the end. `playNow` / `cancel`: the card's buttons, for the whole room.
 */
export type NextEpisodeCommand =
  | { action: "offer"; url: string; time: number; duration: number }
  | { action: "ended"; url: string }
  | { action: "playNow" }
  | { action: "cancel" };

/** CMD:roomPassword (mirrors parseRoomPasswordCommand in server/roomAccess.ts) */
export type RoomPasswordCommand =
  | { action: "regenerate" }
  | { action: "set"; password: string }
  | { action: "enable"; enabled: boolean };

/** CMD:call (mirrors parseCallCommand in server/callState.ts) */
export type CallCommand =
  | { action: "join"; session: string; muted: boolean; camera: boolean }
  | { action: "leave" }
  | { action: "state"; muted?: boolean; camera?: boolean };

/** CMD:callModerate actions (owners only) */
export type CallModerationAction = "mute" | "camera" | "remove";

export interface ClientToServerEvents {
  "CMD:name": (name: string) => void;
  "CMD:host": (url: string) => void;
  "CMD:play": () => void;
  "CMD:pause": () => void;
  "CMD:seek": (time: number) => void;
  "CMD:playbackRate": (rate: number) => void;
  "CMD:loop": (loop: boolean) => void;
  "CMD:ts": (time: number) => void;
  /** The current video's duration in seconds (watch history's finished flag) */
  "CMD:duration": (seconds: number) => void;
  "CMD:chat": (msg: string) => void;
  "CMD:chatV2": (payload: ChatPayload) => void;
  "CMD:addReaction": (reaction: ReactionPayload) => void;
  "CMD:removeReaction": (reaction: ReactionPayload) => void;
  "CMD:joinScreenShare": (data: { file: boolean }) => void;
  "CMD:leaveScreenShare": () => void;
  "CMD:subtitle": (url: string) => void;
  /** Room-wide subtitle offset in seconds (server clamps to ±24 h, rounds to 0.05 s) */
  "CMD:subtitleOffset": (offset: number) => void;
  /** Room-wide offset and time scale together (scale 0.9–1.1); Reset sends {offset: 0, scale: 1} */
  "CMD:subtitleTiming": (timing: { offset: number; scale: number }) => void;
  /** Room auto-sync: claim the job, report its result, or give it back */
  "CMD:subtitleSync": (cmd: SubtitleSyncCommand) => void;
  "CMD:askHost": () => void;
  "CMD:playlistNext": (endedUrl: string) => void;
  "CMD:playlistAdd": (item: string | PlaylistAddItem) => void;
  "CMD:playlistMove": (data: { index: number; toIndex: number }) => void;
  "CMD:playlistDelete": (index: number) => void;
  /** Ignored by the server unless `url` is still the room's video */
  "CMD:videoMeta": (data: { url: string; meta: VideoMeta | null }) => void;
  /** Rate limited server-side; broadcast as REC:playbackIssue */
  "CMD:playbackIssue": (data: { reason: string }) => void;
  /** Partial update; the server validates/normalizes it and answers everyone with REC:roomSettings */
  "CMD:roomSettings": (patch: Partial<RoomSettings>) => void;
  /** Owners only: change the room password (the server answers with REC:roomAccess and a chat line) */
  "CMD:roomPassword": (cmd: RoomPasswordCommand) => void;
  /** Owners only: disconnect someone; a guest also loses access to the room */
  "CMD:kickUser": (data: { userToBeKicked: string }) => void;
  /** Owners only: delete the room for good (everyone gets REC:roomDeleted and is disconnected) */
  "CMD:deleteRoom": () => void;
  /** This device's readiness for the ready check; sent when it changes */
  "CMD:readyState": (data: {
    ready: boolean;
    buffering?: boolean;
    time?: number;
  }) => void;
  /** "Resume now": end the ready check and play for everyone */
  "CMD:readyCheckSkip": () => void;
  /** Next-episode card: see server/nextEpisodeController.ts */
  "CMD:nextEpisode": (data: NextEpisodeCommand) => void;
  signalSS: (data: {
    to: string;
    msg: SignalMessage;
    sharer?: boolean;
  }) => void;
  /** Join/leave the call or change our mute / camera state */
  "CMD:call": (cmd: CallCommand) => void;
  /** Relayed to `to` only while both are call members (size capped, rate limited) */
  "CMD:callSignal": (
    data: { to: string; toSession: string } & CallSignalPayload,
  ) => void;
  /** Owners only: ask a call member to mute or turn their camera off, or remove them from the call */
  "CMD:callModerate": (data: {
    action: CallModerationAction;
    clientId: string;
  }) => void;
}

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Typed emitters for every client→server command. They're no-ops before the socket exists. */
export function createRoomCommands(getSocket: () => RoomSocket | undefined) {
  const emit = <E extends keyof ClientToServerEvents>(
    event: E,
    ...args: Parameters<ClientToServerEvents[E]>
  ) => {
    getSocket()?.emit(event, ...args);
  };
  return {
    setName: (name: string) => emit("CMD:name", name),
    setMedia: (url: string) => emit("CMD:host", url),
    play: () => emit("CMD:play"),
    pause: () => emit("CMD:pause"),
    seek: (time: number) => emit("CMD:seek", time),
    setPlaybackRate: (rate: number) => emit("CMD:playbackRate", rate),
    setLoop: (loop: boolean) => emit("CMD:loop", loop),
    reportTime: (time: number) => emit("CMD:ts", time),
    reportDuration: (seconds: number) => emit("CMD:duration", seconds),
    sendChat: (msg: string) => emit("CMD:chat", msg),
    sendChatV2: (payload: ChatPayload) => emit("CMD:chatV2", payload),
    addReaction: (reaction: ReactionPayload) =>
      emit("CMD:addReaction", reaction),
    removeReaction: (reaction: ReactionPayload) =>
      emit("CMD:removeReaction", reaction),
    joinScreenShare: (file: boolean) => emit("CMD:joinScreenShare", { file }),
    leaveScreenShare: () => emit("CMD:leaveScreenShare"),
    setSubtitle: (url: string) => emit("CMD:subtitle", url),
    setSubtitleOffset: (offset: number) => emit("CMD:subtitleOffset", offset),
    setSubtitleTiming: (timing: { offset: number; scale: number }) =>
      emit("CMD:subtitleTiming", timing),
    subtitleSync: (cmd: SubtitleSyncCommand) => emit("CMD:subtitleSync", cmd),
    askHost: () => emit("CMD:askHost"),
    playlistNext: (endedUrl: string) => emit("CMD:playlistNext", endedUrl),
    playlistAdd: (url: string) => emit("CMD:playlistAdd", url),
    playlistAddItem: (item: PlaylistAddItem) => emit("CMD:playlistAdd", item),
    playlistMove: (index: number, toIndex: number) =>
      emit("CMD:playlistMove", { index, toIndex }),
    playlistDelete: (index: number) => emit("CMD:playlistDelete", index),
    setVideoMeta: (url: string, meta: VideoMeta | null) =>
      emit("CMD:videoMeta", { url, meta }),
    reportPlaybackIssue: (reason: string) =>
      emit("CMD:playbackIssue", { reason }),
    setRoomSettings: (patch: Partial<RoomSettings>) =>
      emit("CMD:roomSettings", patch),
    setRoomPassword: (cmd: RoomPasswordCommand) =>
      emit("CMD:roomPassword", cmd),
    kickUser: (clientId: string) =>
      emit("CMD:kickUser", { userToBeKicked: clientId }),
    deleteRoom: () => emit("CMD:deleteRoom"),
    reportReadyState: (data: {
      ready: boolean;
      buffering?: boolean;
      time?: number;
    }) => emit("CMD:readyState", data),
    skipReadyCheck: () => emit("CMD:readyCheckSkip"),
    nextEpisode: (data: NextEpisodeCommand) => emit("CMD:nextEpisode", data),
    signal: (to: string, msg: SignalMessage, sharer?: boolean) =>
      emit("signalSS", { to, msg, sharer }),
    call: (cmd: CallCommand) => emit("CMD:call", cmd),
    callSignal: (to: string, toSession: string, payload: CallSignalPayload) =>
      emit("CMD:callSignal", { to, toSession, ...payload }),
    moderateCall: (clientId: string, action: CallModerationAction) =>
      emit("CMD:callModerate", { action, clientId }),
  };
}

export type RoomCommands = ReturnType<typeof createRoomCommands>;
