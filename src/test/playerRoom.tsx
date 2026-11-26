// A room for player UI tests (PlayerArea, ControlBar, menus): state lives in a real `useStore` (so `store.set`
// re-renders like the app), commands go through the real `createRoomCommands` to a FakeSocket (assert on
// `socket.emits("CMD:…")`), and `player` is a mock whose media (time, duration, paused, volume…) the test controls
// through `media`.
import { act, render } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import type React from "react";
import { useStore, type Store } from "../components/App/hooks/useStore";
import type { Room } from "../components/App/hooks/useRoom";
import {
  createInitialRoomState,
  type RoomState,
} from "../components/App/roomState";
import { createRoomCommands } from "../components/App/socketEvents";
import { CallVideo } from "../components/App/call/videoStreams";
import { VIDEO_ELEMENT_ID } from "../components/App/hooks/usePlayer";
import { FakeSocket } from "./fakeSocket";
import { Providers, type RenderUiOptions } from "./renderRoom";

/** What the fake player reports; change it, then fire a media event (or rerender) */
export interface FakeMedia {
  time: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  rate: number;
  buffered: { start: number; end: number }[];
  youtube: boolean;
  native: boolean;
  fullscreen: boolean;
  pauseDisabled: boolean;
  webrtcShare: boolean;
  hasDuration: boolean;
  ytSubtitled: boolean;
  /** The native player's subtitle tracks */
  tracks: {
    index: number;
    label: string;
    language: string;
    fromRoom: boolean;
  }[];
  selectedTrack: number;
}

const defaultMedia = (): FakeMedia => ({
  time: 30,
  duration: 600,
  paused: false,
  muted: false,
  volume: 0.8,
  rate: 1,
  buffered: [{ start: 0, end: 120 }],
  youtube: false,
  native: true,
  fullscreen: false,
  pauseDisabled: false,
  webrtcShare: false,
  hasDuration: true,
  ytSubtitled: false,
  tracks: [],
  selectedTrack: -1,
});

export function createFakePlayer(media: FakeMedia) {
  const videoEl = () =>
    document.getElementById(VIDEO_ELEMENT_ID) as HTMLVideoElement | null;
  const current = {
    getCurrentTime: () => media.time,
    getDuration: () => media.duration,
    isMuted: () => media.muted,
    getVolume: () => media.volume,
    getPlaybackRate: () => media.rate,
    shouldPlay: () => media.paused,
    getTimeRanges: () => media.buffered,
    getVideoEl: videoEl,
  };
  const html = {
    getVideoEl: videoEl,
    getSubtitleTracks: () => media.tracks,
    getSelectedSubtitleTrack: () => media.selectedTrack,
    getActiveSubtitleTrack: () => null,
    selectSubtitleTrack: vi.fn((i: number) => {
      media.selectedTrack = i;
    }),
  };
  const youtube = {
    isSubtitled: () => media.ytSubtitled,
    setSubtitleMode: vi.fn((mode: string) => {
      media.ytSubtitled = mode === "showing";
    }),
  };
  return {
    current: () => current,
    html: () => html,
    youtube: () => youtube,
    usingYoutube: () => media.youtube,
    usingNative: () => media.native,
    hasDuration: () => media.hasDuration,
    isPauseDisabled: () => media.pauseDisabled,
    isWebRTCShare: () => media.webrtcShare,
    getDuration: () => media.duration,
    isFullscreen: () => media.fullscreen,
    setContainer: vi.fn(),
    roomTogglePlay: vi.fn(() => {
      media.paused = !media.paused;
    }),
    roomSeek: vi.fn(),
    roomSeekBy: vi.fn(),
    roomSetLoop: vi.fn(),
    localSetVolume: vi.fn((v: number) => {
      media.volume = Math.min(1, Math.max(0, v));
      media.muted = false;
    }),
    localToggleMute: vi.fn(() => {
      media.muted = !media.muted;
    }),
    localSetMute: vi.fn((m: boolean) => {
      media.muted = m;
    }),
    toggleFullscreen: vi.fn(() => {
      media.fullscreen = !media.fullscreen;
      document.dispatchEvent(new Event("fullscreenchange"));
    }),
    onVideoEnded: vi.fn(),
    setBuffering: vi.fn(),
    resync: vi.fn(),
  };
}

export type FakePlayer = ReturnType<typeof createFakePlayer>;

export interface PlayerRoomMocks {
  media: FakeMedia;
  player: FakePlayer;
  socket: FakeSocket;
  subtitles: Record<string, Mock>;
  subsync: Record<string, Mock>;
  call: { toggleMute: Mock; toggleCamera: Mock; video: CallVideo } & Record<
    string,
    any
  >;
  readyCheck: { skip: Mock };
  convert: { setAudioTrack: Mock; status: null };
  chatRef: { current: any };
}

export function createPlayerRoomMocks(
  media: Partial<FakeMedia> = {},
): PlayerRoomMocks {
  const m = { ...defaultMedia(), ...media };
  const socket = new FakeSocket();
  return {
    media: m,
    player: createFakePlayer(m),
    socket,
    subtitles: {
      nudgeOffset: vi.fn((d: number) => d),
      setOffset: vi.fn(),
      resetOffset: vi.fn(),
      setScope: vi.fn(),
      openSearch: vi.fn(),
      getTiming: vi.fn(() => ({ offset: 0, scale: 1 })),
    },
    subsync: {
      unavailableReason: vi.fn(() => null),
      syncNow: vi.fn(),
      cancel: vi.fn(),
      evaluate: vi.fn(),
    },
    call: {
      toggleMute: vi.fn(() => true),
      toggleCamera: vi.fn(async () => true),
      setTilesHidden: vi.fn(),
      video: new CallVideo(),
    },
    readyCheck: { skip: vi.fn() },
    convert: { setAudioTrack: vi.fn(), status: null },
    chatRef: { current: null },
  };
}

const commands = new WeakMap<PlayerRoomMocks, unknown>();

/** Builds the Room for one render from the store snapshot and the stable mocks */
function useFakeRoom(
  init: Partial<RoomState>,
  mocks: PlayerRoomMocks,
): [Room, Store<RoomState>] {
  const [state, store] = useStore<RoomState>(() => ({
    ...createInitialRoomState(),
    loading: false,
    ...init,
  }));
  let cmd = commands.get(mocks);
  if (!cmd) {
    cmd = createRoomCommands(() => mocks.socket as any);
    commands.set(mocks, cmd);
  }
  const room = {
    state,
    store,
    clientId: "me",
    cmd,
    socket: mocks.socket,
    chatRef: mocks.chatRef,
    player: mocks.player,
    convert: mocks.convert,
    share: {},
    playlist: {},
    subtitles: mocks.subtitles,
    subsync: mocks.subsync,
    readyCheck: mocks.readyCheck,
    call: mocks.call,
    showError: vi.fn(),
    updateName: vi.fn(),
    getMediaDisplayName: (u?: string) => (u ? (u.split("/").pop() ?? u) : ""),
  };
  return [room as unknown as Room, store];
}

export interface RenderPlayerOptions extends RenderUiOptions {
  state?: Partial<RoomState>;
  media?: Partial<FakeMedia>;
}

/**
 * Renders `ui(room)` with a fake room inside the app's providers. Returns the mocks, the latest `room()`, the
 * `store` (call `setState` to change room state inside act) and the testing-library result.
 */
export function renderWithPlayerRoom(
  ui: (room: Room) => React.ReactElement,
  opts: RenderPlayerOptions = {},
) {
  const mocks = createPlayerRoomMocks(opts.media);
  const latest: { room: Room | null; store: Store<RoomState> | null } = {
    room: null,
    store: null,
  };
  function Harness() {
    const [room, store] = useFakeRoom(opts.state ?? {}, mocks);
    latest.room = room;
    latest.store = store;
    return ui(room);
  }
  const result = render(<Harness />, {
    wrapper: ({ children }) => <Providers {...opts}>{children}</Providers>,
  });
  return {
    ...result,
    ...mocks,
    room: () => latest.room!,
    store: () => latest.store!,
    /** Patches room state (re-renders) */
    setState: (patch: Partial<RoomState>) =>
      act(() => {
        latest.store!.set(patch);
      }),
  };
}
