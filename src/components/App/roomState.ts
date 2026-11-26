import type { AudioTrackInfo } from "../../utils/clientTranscode";
import type { Store } from "./hooks/useStore";
import type { SyncStatus } from "./logic/sync";
import type { SubtitleScope } from "./logic/subtitles";
import { initialCallState, type CallUiState } from "./call/callReducer";
import { CALL_PREFS, readPref } from "./call/logic";

const readCallPrefs = () => ({
  pushToTalk: readPref(CALL_PREFS.pushToTalk) === "1",
  ducking: readPref(CALL_PREFS.ducking) === "1",
  tilesHidden: readPref(CALL_PREFS.tilesHidden) === "1",
});

/**
 * A subtitle the menu can offer besides the room's own (e.g. auto subtitles found for an AIOStreams title). Picking
 * one makes it the room subtitle (CMD:subtitle).
 */
export interface SubtitleTrackOption {
  id: string;
  label: string;
  /** ISO 639-1 where known */
  lang?: string;
  url: string;
  /** Secondary line, e.g. "OpenSubtitles · hearing impaired" */
  detail?: string;
  /** "auto" tracks get an Auto badge and are listed first */
  source?: "auto" | "manual";
}

/** Everything the room page renders. Hooks read/write it through a shared Store (see hooks/useStore.ts). */
export interface RoomState {
  connection: "starting" | "connected";
  // Synced room state (from REC:* events)
  roomMedia: string;
  roomSubtitle: string;
  roomPaused: boolean;
  roomLoop: boolean;
  /** 0 means automatic (catch-up sync) */
  roomPlaybackRate: number;
  participants: User[];
  tsMap: NumberDict;
  nameMap: StringDict;
  pictureMap: StringDict;
  playlist: PlaylistVideo[];
  // Chat
  chat: ChatMessage[];
  /** Changes when the chat should scroll to the bottom (if the user is near it) */
  scrollTimestamp: number;
  unreadCount: number;
  /** The visible sidebar tab ("chat" | "queue" | "people"), or "none" when the sidebar/sheet is hidden */
  currentTab: string;
  myName: string;
  // Local player state
  loading: boolean;
  isAutoPlayable: boolean;
  nonPlayableMedia: boolean;
  isLiveStream: boolean;
  /** AIOStreams metadata of the current video (REC:videoMeta), null for anything else */
  videoMeta: VideoMeta | null;
  /** The latest REC:playbackIssue, with a receive timestamp so repeats are distinct */
  playbackIssue: (PlaybackIssue & { at: number }) | undefined;
  /** REC:readyCheck (null until the server sends it) */
  readyCheck: ReadyCheckState | null;
  /** The latest REC:nextEpisode, with a receive timestamp (see nextEpisode/) */
  nextEpisode: NextEpisodeState & { at: number };
  // Client-side conversion (see useConvert)
  /** Per-device "Auto-convert when needed" (default on). Kept as `convertEnabled` for compatibility. */
  convertEnabled: boolean;
  /** How this device plays the current direct link (see useConvert.playUrl / logic/playback.ts) */
  playback: PlaybackState | undefined;
  convertProgress: number | undefined;
  audioTracks: AudioTrackInfo[] | undefined;
  audioTrackId: number | undefined;
  /** Whether this device is sharing its screen or a file (see useShare) */
  isPublishing: boolean;
  // Messages
  overlayMsg: string;
  errorMessage: string;
  successMessage: string;
  warningMessage: string;
  // Layout (sidebar collapse, picker and settings live in ui/RoomUi.tsx)
  fullScreen: boolean;
  isScreenShareModalOpen: boolean;
  isFileShareModalOpen: boolean;
  isSubtitleModalOpen: boolean;
  /** "Search subtitles…" (subtitleSearch/SubtitleSearch.tsx) */
  isSubtitleSearchOpen: boolean;
  // Player redesign (player/)
  /** Socket connected (false while reconnecting) */
  socketConnected: boolean;
  /** This device's <video>/YouTube player is waiting for data */
  buffering: boolean;
  /** What the sync indicator shows (see logic/sync.ts) */
  syncStatus: SyncStatus;
  /** Room-wide subtitle offset in seconds (REC:host / REC:subtitleOffset) */
  roomSubtitleOffset: number;
  /** "Just me" override, null when following the room */
  localSubtitleOffset: number | null;
  /** Room-wide subtitle time scale (frame-rate drift): cues show at original × scale + offset */
  roomSubtitleScale: number;
  /** "Just me" time scale, set together with localSubtitleOffset (null when following the room) */
  localSubtitleScale: number | null;
  subtitleScope: SubtitleScope;
  /** Subtitle auto-sync running on this device (subsync/): manual wand or the room's auto-sync, progress 0..1 */
  subtitleSyncJob: { auto: boolean; progress: number } | null;
  /** Someone else's device is computing the room's subtitle auto-sync */
  subtitleSyncRemote: { by: string } | null;
  /** Extra subtitle tracks for the menu (slot for auto subtitles; optional) */
  subtitleTracks?: SubtitleTrackOption[];
  /** A short message for the player's on-screen display (e.g. "Alex paused" in fullscreen) */
  playerNotice: { text: string; at: number } | null;
  /** Room-wide settings (REC:roomSettings), the default until the server sends them */
  roomSettings: RoomSettings;
  /** REC:roomAccess: whether the room password is on, and (owners only) the password. Null until it arrives. */
  roomAccess: RoomAccessInfo | null;
  /** Set when an owner deleted the room while we were in it (REC:roomDeleted): the room page shows RoomDeleted */
  roomDeleted: { by: string | null } | null;
  /** The voice call: membership (REC:callState) and this device's status, peers and speaking (call/) */
  call: CallUiState;
}

/** Mirrors DEFAULT_ROOM_SETTINGS in server/roomSettings.ts */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  title: "",
  readyCheck: true,
  nextEpisodeOffset: 25,
  autoSyncSubtitles: false,
};

export type RoomStore = Store<RoomState>;

export type PlaybackState =
  | { mode: "probing" }
  | { mode: "direct"; note?: string }
  | { mode: "convert"; heavy: boolean; reason: string }
  | { mode: "fail"; reason: string };

/** localStorage key of the per-device auto-convert setting ("0" = off) */
export const AUTO_CONVERT_KEY = "wp-auto-convert";

function readAutoConvert(): boolean {
  try {
    return window.localStorage.getItem(AUTO_CONVERT_KEY) !== "0";
  } catch {
    return true;
  }
}

export function createInitialRoomState(): RoomState {
  return {
    connection: "starting",
    roomMedia: "",
    roomSubtitle: "",
    roomPaused: false,
    roomLoop: false,
    roomPlaybackRate: 0,
    participants: [],
    tsMap: {},
    nameMap: {},
    pictureMap: {},
    playlist: [],
    chat: [],
    scrollTimestamp: 0,
    unreadCount: 0,
    currentTab:
      new URLSearchParams(window.location.search).get("tab") ?? "chat",
    myName: window.localStorage.getItem("watchparty-username") ?? "",
    loading: true,
    isAutoPlayable: true,
    nonPlayableMedia: false,
    isLiveStream: false,
    videoMeta: null,
    playbackIssue: undefined,
    readyCheck: null,
    nextEpisode: { state: "none", at: 0 },
    convertEnabled: readAutoConvert(),
    playback: undefined,
    convertProgress: undefined,
    audioTracks: undefined,
    audioTrackId: undefined,
    isPublishing: false,
    overlayMsg: "",
    errorMessage: "",
    successMessage: "",
    warningMessage: "",
    fullScreen: false,
    isScreenShareModalOpen: false,
    isFileShareModalOpen: false,
    isSubtitleModalOpen: false,
    isSubtitleSearchOpen: false,
    socketConnected: false,
    buffering: false,
    syncStatus: { kind: "in-sync" },
    roomSubtitleOffset: 0,
    localSubtitleOffset: null,
    roomSubtitleScale: 1,
    localSubtitleScale: null,
    subtitleScope: "everyone",
    playerNotice: null,
    roomSettings: { ...DEFAULT_ROOM_SETTINGS },
    subtitleSyncJob: null,
    subtitleSyncRemote: null,
    roomAccess: null,
    roomDeleted: null,
    call: initialCallState(readCallPrefs()),
  };
}
