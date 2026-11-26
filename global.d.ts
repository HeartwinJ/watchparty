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
}

/** Who sent a room-wide playback change (REC:play / REC:pause / REC:subtitleOffset) */
interface PlaybackActor {
  id: string;
  name?: string;
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
