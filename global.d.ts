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
