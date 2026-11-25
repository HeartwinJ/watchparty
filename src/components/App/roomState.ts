import type { AudioTrackInfo } from "../../utils/clientTranscode";
import type { Store } from "./hooks/useStore";
import type { SyncStatus } from "./logic/sync";
import type { SubtitleScope } from "./logic/subtitles";

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
  // Client-side conversion (see useConvert)
  convertEnabled: boolean;
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
  subtitleScope: SubtitleScope;
  /** Extra subtitle tracks for the menu (slot for auto subtitles; optional) */
  subtitleTracks?: SubtitleTrackOption[];
  /** A short message for the player's on-screen display (e.g. "Alex paused" in fullscreen) */
  playerNotice: { text: string; at: number } | null;
}

export type RoomStore = Store<RoomState>;

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
    convertEnabled: window.localStorage.getItem("watchparty-convert") === "1",
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
    socketConnected: false,
    buffering: false,
    syncStatus: { kind: "in-sync" },
    roomSubtitleOffset: 0,
    localSubtitleOffset: null,
    subtitleScope: "everyone",
    playerNotice: null,
  };
}
