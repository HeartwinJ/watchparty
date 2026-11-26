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
    actor?: PlaybackActor;
  }) => void;
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
  signalSS: (data: {
    msg: SignalMessage;
    from: string;
    sharer: boolean;
  }) => void;
}

type ReactionPayload = Omit<Reaction, "user">;

/** A queue item with a readable name (and AIOStreams metadata), as sent by the source picker */
export type PlaylistAddItem = {
  url: string;
  name?: string;
  img?: string;
  meta?: VideoMeta;
};

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
  /** Room-wide subtitle offset in seconds (server clamps to ±30 s, rounds to 0.05 s) */
  "CMD:subtitleOffset": (offset: number) => void;
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
  signalSS: (data: {
    to: string;
    msg: SignalMessage;
    sharer?: boolean;
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
    signal: (to: string, msg: SignalMessage, sharer?: boolean) =>
      emit("signalSS", { to, msg, sharer }),
  };
}

export type RoomCommands = ReturnType<typeof createRoomCommands>;
