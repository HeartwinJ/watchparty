declare module "srt-webvtt";

type StringDict = Record<string, string>;
type NumberDict = Record<string, number>;
type PCDict = Record<string, RTCPeerConnection>;

interface User {
  id: string;
  isScreenShare?: boolean;
}

interface Reaction {
  user: string;
  value: string;
  msgId: string;
  msgTimestamp: string;
}

type ChatPayload = {
  msg: string;
  replyToId?: string;
  replyToTimestamp?: string;
};

interface ChatMessageBase {
  id: string;
  cmd?: string;
  msg?: string;
  system?: boolean;
  replyToId?: string;
  replyToTimestamp?: string;
  replyToUserId?: string;
  replyToMsg?: string;
}

interface ChatMessage extends ChatMessageBase {
  timestamp: string;
  videoTS?: number;
  reactions?: { [value: string]: string[] };
}

interface Settings {
  disableChatSound?: boolean;
}

interface PlaylistVideo {
  url: string;
  name: string;
  img?: string;
  channel?: string;
  duration: number;
  type: string;
  /** Set for AIOStreams items added from the source picker; restored as the room's videoMeta when played */
  meta?: VideoMeta;
}

interface SearchResult extends PlaylistVideo {
  type: "youtube" | "file";
  url: string;
  name: string;
  duration: number;
}

interface HostState {
  video: string;
  videoTS: number;
  subtitle: string;
  paused: boolean;
  playbackRate: number;
  loop: boolean;
  /** Room-wide subtitle offset in seconds (positive = later). Missing from older servers. */
  subtitleOffset?: number;
  /** Room-wide subtitle time scale (frame-rate drift), shown = original × scale + offset; 1 when absent */
  subtitleScale?: number;
}

/** Who sent a room-wide playback change (REC:play / REC:pause / REC:subtitleOffset) */
interface PlaybackActor {
  id: string;
  name?: string;
}

/** REC:roomDeleted: an owner deleted the room (`by` is null for Home's delete button and the inactivity sweep) */
interface RoomDeletedInfo {
  by: PlaybackActor | null;
}

/**
 * What the room's current video is, when it came from the AIOStreams picker (CMD:videoMeta / REC:videoMeta).
 * Cleared whenever a different video is hosted. Used for "Pick another", next episode, history and subtitles.
 */
interface VideoMeta {
  source: "aiostreams";
  type: "movie" | "series" | "anime";
  /** Addon id the stream was resolved with: "tt0111161", "tt0903747:2:4" or "kitsu:11:5" */
  id: string;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  /** Movie or show name */
  title: string;
  episodeTitle: string | null;
  poster: string | null;
  bingeGroup: string | null;
}

/** REC:playbackIssue: a viewer's browser can't play the room's video */
interface PlaybackIssue {
  userId: string;
  name: string;
  reason: string;
}

/** Room-wide settings (CMD:roomSettings patch / REC:roomSettings full object). Defaults in server/roomSettings.ts. */
interface RoomSettings {
  /** "" = use the generated room name */
  title: string;
  readyCheck: boolean;
  /** seconds before the end to show the next-episode card, 5–120 */
  nextEpisodeOffset: number;
  /** Align newly loaded subtitles to the audio once (one viewer computes it, see server/subtitleAutoSync.ts) */
  autoSyncSubtitles: boolean;
}

/**
 * CMD:subtitleSync (room auto-sync, see server/subtitleAutoSync.ts). `key` names the subtitle (e.g. "room:<url>").
 * claim: "I can compute it"; result: what it found (offset null = no confident match); failed: couldn't compute.
 */
type SubtitleSyncCommand =
  | { action: "claim"; video: string; key: string }
  | {
      action: "result";
      video: string;
      key: string;
      offset: number | null;
      /** Time scale for frame-rate drift (0.9–1.1): shown = original × scale + offset; default 1 */
      scale?: number;
      confidence?: number;
    }
  | { action: "failed"; video: string; key: string };

/**
 * REC:subtitleSync: `running` (to everyone: `by` is computing it), `done` (to everyone; `offset` was applied room-wide,
 * or null = no confident match), `released` (to everyone: the computing viewer failed or left, someone else may claim),
 * `denied` (to the claimer only: someone else has it, it's done, or the offset was set by hand).
 */
interface SubtitleSyncEvent {
  status: "running" | "done" | "released" | "denied";
  video: string;
  key: string;
  by?: PlaybackActor;
  offset?: number | null;
  /** With `done`: the time scale applied when it isn't 1 */
  scale?: number;
  reason?: "off" | "stale" | "manual" | "busy" | "done";
}

/**
 * REC:roomAccess: the room password state. Owners get `password`; guests only `enabled` (never the password).
 * Sent on connect and after every change (CMD:roomPassword).
 */
interface RoomAccessInfo {
  /** Whether guests need the password to join */
  enabled: boolean;
  password?: string;
}

/** Why a ready check started: someone stalled, or someone joined mid-play */
type ReadyCheckReason = "buffering" | "join";
/** How a ready check ended: everyone ready, timed out, "Resume now", or a manual pause/play/video change */
type ReadyCheckOutcome = "ready" | "timeout" | "skipped" | "cancelled";

/** REC:readyCheck: the room is paused until these viewers have enough buffered (see server/readyCheck.ts) */
interface ReadyCheckState {
  active: boolean;
  /** clientIds still buffering */
  waitingFor: string[];
  /** Server time (ms) when it resumes anyway */
  deadline?: number;
  reason?: ReadyCheckReason;
  /** Who stalled or joined */
  trigger?: string;
  /** Set once a check has ended */
  outcome?: ReadyCheckOutcome;
  /** Who pressed "Resume now" (outcome "skipped") */
  actorId?: string;
}

/** The episode the next-episode card offers. No stream URL: the server keeps that until it plays. */
interface NextEpisodeInfo {
  /** VideoMeta of the next episode (what the room gets when it plays) */
  meta: VideoMeta;
  thumbnail: string | null;
}

/** REC:nextEpisode: the room-wide next-episode card (see server/nextEpisodeController.ts) */
type NextEpisodeState =
  | { state: "none" }
  /** Show the card. `startAt` is in video seconds (the video's end): countdown = startAt - currentTime */
  | { state: "offered"; next: NextEpisodeInfo; startAt: number }
  | { state: "cancelled"; by: PlaybackActor | null }
  /** The next episode is being hosted (REC:host follows) */
  | { state: "starting"; next: NextEpisodeInfo; by: PlaybackActor | null }
  /** It couldn't be found or has no playable stream (`next` is set when the episode itself is known) */
  | { state: "failed"; next: NextEpisodeInfo | null };

/** Someone in the room's voice call (REC:callState). Call membership is separate from the roster. */
interface CallMember {
  clientId: string;
  /** The member's call instance (new per page load): a new session means a new peer connection */
  session: string;
  muted: boolean;
  /** Server time (ms) they joined; kept across a rejoin */
  joinedAt: number;
  /** Their socket dropped; they stay listed for a short grace period (see server/callState.ts) */
  reconnecting: boolean;
}

/** REC:callState: everyone in the voice call, in join order (sent on connect and on every change) */
interface CallState {
  members: CallMember[];
}

/** WebRTC session description or ICE candidate for the voice call (CMD:callSignal / REC:callSignal) */
interface CallSignalPayload {
  description?: { type: "offer" | "answer" | "rollback"; sdp: string };
  /** null = end of candidates */
  candidate?: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment: string | null;
  } | null;
}

/** REC:callSignal: relayed from another call member (the server sets `from` and `session`) */
interface CallSignalEvent extends CallSignalPayload {
  from: string;
  /** The sender's session */
  session: string;
  /** The recipient session it was meant for (drop it if that isn't ours anymore) */
  toSession: string;
}

/** REC:callModerated: an owner asked you to mute (you mute yourself) or removed you from the call */
interface CallModeratedEvent {
  action: "mute" | "remove";
  by: PlaybackActor;
}
