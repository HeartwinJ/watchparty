import type { AudioTrackInfo } from "../../utils/clientTranscode";
import { isMobile } from "../../utils/utils";
import type { Store } from "./hooks/useStore";

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
  currentTab: string;
  myName: string;
  // Local player state
  loading: boolean;
  isAutoPlayable: boolean;
  nonPlayableMedia: boolean;
  isLiveStream: boolean;
  /** Changing it remounts the controls so they re-read the player (e.g. after mute) */
  controlsTimestamp: number;
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
  // Layout
  fullScreen: boolean;
  showChatColumn: boolean;
  showPeopleColumn: boolean;
  isScreenShareModalOpen: boolean;
  isFileShareModalOpen: boolean;
  isSubtitleModalOpen: boolean;
  settingsModalOpen: boolean;
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
    controlsTimestamp: 0,
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
    showChatColumn: isMobile()
      ? true
      : Boolean(
          Number(
            window.localStorage.getItem("watchparty-showchatcolumn") ?? "1",
          ),
        ),
    showPeopleColumn: false,
    isScreenShareModalOpen: false,
    isFileShareModalOpen: false,
    isSubtitleModalOpen: false,
    settingsModalOpen: false,
  };
}
