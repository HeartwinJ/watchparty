// usePlayer on its own: play/pause/seek for the room, drift correction on REC:tsMap, fullscreen (incl. the iOS
// native fallback), what happens when a video ends, the YouTube iframe callbacks and the 1 s CMD:ts/CMD:duration loop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  installFullscreen,
  installMatchMedia,
} from "../../../test/browserFakes";

let autoplay = true;
let mobile = false;
vi.mock("../../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/utils")>()),
  testAutoplay: async () => autoplay,
  isMobile: () => mobile,
}));

const { usePlayer } = await import("./usePlayer");
const { useStore } = await import("./useStore");
const { createInitialRoomState } = await import("../roomState");
const { createShareSession } = await import("./useShare");

const ME = "me";
const MEDIA = "https://cdn.example.com/movie.mp4";
const YT = "https://www.youtube.com/watch?v=abc";

function makeCmd() {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setPlaybackRate: vi.fn(),
    setLoop: vi.fn(),
    playlistNext: vi.fn(),
    setMedia: vi.fn(),
    nextEpisode: vi.fn(),
    askHost: vi.fn(),
    reportTime: vi.fn(),
    reportDuration: vi.fn(),
  };
}

let video: HTMLVideoElement;
let time = 0;
let duration = 100;

function setup(
  opts: { connected?: boolean; state?: Record<string, unknown> } = {},
) {
  const cmd = makeCmd();
  const share = createShareSession();
  const hook = renderHook(
    ({ connected }) => {
      const [state, store] = useStore(createInitialRoomState);
      const player = usePlayer({
        store,
        cmd: cmd as any,
        clientId: ME,
        share,
        connected,
      });
      return { state, store, player };
    },
    { initialProps: { connected: opts.connected ?? false } },
  );
  act(() =>
    hook.result.current.store.set({
      roomMedia: MEDIA,
      isAutoPlayable: true,
      loading: false,
      socketConnected: true,
      ...opts.state,
    } as any),
  );
  const api = () => hook.result.current.player;
  // useRoom stores REC:tsMap before running the drift controller
  const tick = (tsMap: Record<string, number>) =>
    act(() => {
      hook.result.current.store.set({ tsMap });
      hook.result.current.player.onTsMap(tsMap);
    });
  const get = () => hook.result.current.store.get();
  const set = (patch: Record<string, unknown>) =>
    act(() => hook.result.current.store.set(patch as any));
  return { ...hook, cmd, share, api, get, set, tick };
}

beforeEach(() => {
  autoplay = true;
  mobile = false;
  time = 0;
  duration = 100;
  document.body.innerHTML = '<video id="leftVideo"></video>';
  video = document.getElementById("leftVideo") as HTMLVideoElement;
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => time,
    set: (v) => (time = v),
  });
  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => duration,
  });
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(video, "pause").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usePlayer playback", () => {
  it("picks the YouTube player for YouTube links and the <video> otherwise", () => {
    const { api, set } = setup();
    expect(api().usingNative()).toBe(true);
    expect(api().current()).toBe(api().html());
    expect(api().hasDuration()).toBe(true);
    expect(api().isWebRTCShare()).toBe(false);
    set({ roomMedia: YT });
    expect(api().usingYoutube()).toBe(true);
    expect(api().current()).toBe(api().youtube());
    set({ roomMedia: "screenshare://alex" });
    expect(api().isPauseDisabled()).toBe(true);
    expect(api().isWebRTCShare()).toBe(true);
  });

  it("localPlay unmutes when autoplay is allowed and plays", async () => {
    const { api, get } = setup();
    video.muted = true;
    await act(() => api().localPlay());
    expect(get().roomPaused).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalled();
  });

  it("localPlay mutes to get past the autoplay policy", async () => {
    autoplay = false;
    const { api, get } = setup({ state: { isAutoPlayable: false } });
    await act(() => api().localPlay());
    expect(get().isAutoPlayable).toBe(false);
    expect(video.muted).toBe(true);
  });

  it("localPlay mutes the screen sharer (no echo)", async () => {
    const { api, share } = setup();
    share.localStream = {} as MediaStream;
    share.isFile = false;
    await act(() => api().localPlay());
    expect(video.muted).toBe(true);
  });

  it("localPlay does nothing without media and waits while probing", async () => {
    const { api, set, get } = setup();
    set({ roomMedia: "" });
    await act(() => api().localPlay());
    expect(video.play).not.toHaveBeenCalled();
    set({ roomMedia: MEDIA, playback: { mode: "probing" }, roomPaused: true });
    await act(() => api().localPlay());
    expect(get().roomPaused).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("marks the media unplayable on NotSupportedError", async () => {
    const { api, get } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (video.play as any).mockRejectedValueOnce(
      Object.assign(new Error("no"), { name: "NotSupportedError" }),
    );
    await act(() => api().localPlay());
    expect(get().nonPlayableMedia).toBe(true);
    expect(get().loading).toBe(false);
    // Other errors (e.g. NotAllowedError) aren't
    (video.play as any).mockRejectedValueOnce(
      Object.assign(new Error("no"), { name: "NotAllowedError" }),
    );
    act(() => api().localPause());
  });

  it("roomTogglePlay tells the room and plays or pauses", async () => {
    const { api, cmd, get } = setup();
    Object.defineProperty(video, "paused", { configurable: true, value: true });
    await act(async () => api().roomTogglePlay());
    expect(cmd.play).toHaveBeenCalled();
    Object.defineProperty(video, "paused", {
      configurable: true,
      value: false,
    });
    await act(async () => api().roomTogglePlay());
    expect(cmd.pause).toHaveBeenCalled();
    expect(get().roomPaused).toBe(true);
    expect(video.pause).toHaveBeenCalled();
  });

  it("roomTogglePlay is disabled for screen shares", () => {
    const { api, cmd, set } = setup();
    set({ roomMedia: "screenshare://alex" });
    api().roomTogglePlay();
    expect(cmd.play).not.toHaveBeenCalled();
    expect(cmd.pause).not.toHaveBeenCalled();
  });

  it("roomSeek clamps at 0 and sends the room time", () => {
    const { api, cmd } = setup();
    api().roomSeek(-5);
    expect(time).toBe(0);
    expect(cmd.seek).toHaveBeenLastCalledWith(0);
    api().roomSeek(30);
    expect(cmd.seek).toHaveBeenLastCalledWith(30);
  });

  it("roomSeekBy stays just before the end", () => {
    const { api, cmd } = setup();
    time = 95;
    api().roomSeekBy(10);
    expect(cmd.seek).toHaveBeenLastCalledWith(99.9);
    time = 20;
    api().roomSeekBy(-10);
    expect(cmd.seek).toHaveBeenLastCalledWith(10);
  });

  it("live streams send the offset from the live edge", () => {
    const { api, cmd } = setup({ state: { isLiveStream: true } });
    api().roomSeek(90);
    expect(cmd.seek).toHaveBeenLastCalledWith(-10);
    // localSeek to a live offset goes relative to the edge
    api().localSeek(-20);
    expect(time).toBe(80);
  });

  it("localSeek follows the leader", () => {
    const { api, set } = setup();
    set({ participants: [{ id: ME }, { id: "b" }], tsMap: { [ME]: 5, b: 42 } });
    expect(api().getLeaderTime()).toBe(42);
    api().localSeek();
    expect(time).toBe(42);
  });

  it("volume clamps and unmutes when raised", () => {
    const { api } = setup();
    video.muted = true;
    api().localSetVolume(2);
    expect(video.volume).toBe(1);
    expect(video.muted).toBe(false);
    api().localToggleMute();
    expect(video.muted).toBe(true);
    api().localSetVolume(0);
    expect(video.muted).toBe(true);
  });

  it("speed and loop are room commands", () => {
    const { api, cmd } = setup();
    api().roomSetPlaybackRate(1.5);
    api().roomSetLoop(true);
    expect(cmd.setPlaybackRate).toHaveBeenCalledWith(1.5);
    expect(cmd.setLoop).toHaveBeenCalledWith(true);
  });

  it("uses the end of the seekable range as a live dash stream's duration", () => {
    duration = Infinity;
    const { api } = setup({ state: { isLiveStream: true } });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, end: () => 300 },
    });
    expect(api().getDuration()).toBe(300);
  });
});

describe("usePlayer sync", () => {
  const playing = {
    roomPaused: false,
    participants: [{ id: ME }, { id: "b" }],
  };

  it("nudges the rate for small drift, then back to the room rate", () => {
    const { api, get, tick } = setup({ state: playing });
    tick({ [ME]: 10, b: 11 });
    expect(video.playbackRate).toBeCloseTo(1.05);
    expect(get().syncStatus).toEqual({ kind: "catching-up", behind: 1 });
    tick({ [ME]: 11, b: 11.05 });
    expect(video.playbackRate).toBe(1);
    expect(get().syncStatus).toEqual({ kind: "in-sync" });
  });

  it("seeks for large drift", () => {
    const { tick } = setup({ state: playing });
    tick({ [ME]: 10, b: 20 });
    expect(time).toBe(20);
  });

  it("stops correcting (and resets the rate) when paused or loading", () => {
    const { api, set, get, tick } = setup({ state: playing });
    tick({ [ME]: 10, b: 11 });
    expect(video.playbackRate).toBeCloseTo(1.05);
    set({ roomPaused: true });
    tick({ [ME]: 10, b: 11 });
    expect(video.playbackRate).toBe(1);
    expect(get().syncStatus.kind).toBe("in-sync");
    // Not reporting yet: inactive too
    set({ roomPaused: false });
    tick({ b: 11 });
    expect(video.playbackRate).toBe(1);
  });

  it("only uses YouTube's available rates", () => {
    const { api, set, tick } = setup({ state: playing });
    set({ roomMedia: YT });
    const yt = api().youtube();
    const setRate = vi.spyOn(yt, "setPlaybackRate");
    vi.spyOn(yt, "getPlaybackRate").mockReturnValue(1);
    vi.spyOn(yt, "getAvailablePlaybackRates").mockReturnValue([1, 1.25]);
    const seek = vi.spyOn(yt, "seekVideo");
    // No usable nudge: seeks from 1 s instead of 2 s
    tick({ [ME]: 10, b: 11.5 });
    expect(setRate).not.toHaveBeenCalled();
    expect(seek).toHaveBeenCalledWith(11.5);
  });

  it("buffering and connection show in the sync status", () => {
    const { api, get, set } = setup({ state: { roomPaused: false } });
    act(() => api().setBuffering(true));
    expect(get().syncStatus).toEqual({ kind: "buffering" });
    // Same value: no change
    act(() => api().setBuffering(true));
    act(() => api().setSocketConnected(false));
    expect(get().syncStatus).toEqual({ kind: "reconnecting" });
    act(() => api().setSocketConnected(true));
    act(() => api().setBuffering(false));
    expect(get().syncStatus).toEqual({ kind: "in-sync" });
    set({ roomPlaybackRate: 1.5 });
  });

  it("resync jumps to the leader at the room rate", () => {
    const { api } = setup({
      state: { ...playing, roomPlaybackRate: 1.5, tsMap: { [ME]: 1, b: 33 } },
    });
    video.playbackRate = 1.05;
    act(() => api().resync());
    expect(video.playbackRate).toBe(1.5);
    expect(time).toBe(33);
  });
});

describe("usePlayer when a video ends", () => {
  it("restarts when looping", async () => {
    const { api } = setup({ state: { roomLoop: true } });
    time = 100;
    await act(async () => api().onVideoEnded(MEDIA));
    expect(time).toBe(0);
    expect(video.play).toHaveBeenCalled();
  });

  it("advances the playlist with the ended URL", async () => {
    const { api, cmd } = setup({
      state: { playlist: [{ url: "https://x/b.mp4" }] },
    });
    await act(async () => api().onVideoEnded(MEDIA));
    expect(cmd.playlistNext).toHaveBeenCalledWith(MEDIA);
  });

  it("plays the next file index", async () => {
    const url = "https://x/a?x=1&fileIndex=2";
    const { api, cmd } = setup({ state: { roomMedia: url } });
    await act(async () => api().onVideoEnded(url));
    expect(cmd.setMedia).toHaveBeenCalledWith("https://x/a?x=1&fileIndex=3");
  });

  it("tells the room an episode ended (next episode card)", async () => {
    const { api, cmd, set } = setup();
    await act(async () => api().onVideoEnded(MEDIA));
    expect(cmd.nextEpisode).not.toHaveBeenCalled();
    set({ videoMeta: { title: "Show" } });
    await act(async () => api().onVideoEnded(MEDIA));
    expect(cmd.nextEpisode).toHaveBeenCalledWith({
      action: "ended",
      url: MEDIA,
    });
  });

  it("ignores ends while loading and videos shorter than the intro skip", async () => {
    const { api, cmd, set, get } = setup({
      state: { loading: true, roomLoop: true },
    });
    await act(async () => api().onVideoEnded(MEDIA));
    expect(get().roomPaused).toBe(false);
    set({
      loading: false,
      roomLoop: false,
      introSkip: { seconds: 120, at: 1 },
    });
    await act(async () => api().onVideoEnded(MEDIA));
    expect(cmd.nextEpisode).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
  });
});

describe("usePlayer fullscreen", () => {
  it("puts the player container in fullscreen and back", async () => {
    const fs = installFullscreen();
    const { api } = setup();
    const container = document.createElement("div");
    act(() => api().setContainer(container));
    expect(api().getContainer()).toBe(container);
    expect(api().isFullscreen()).toBe(false);
    await act(() => api().toggleFullscreen());
    expect(fs.request).toHaveBeenCalled();
    expect(api().isFullscreen()).toBe(true);
    await act(() => api().toggleFullscreen());
    expect(fs.exit).toHaveBeenCalled();
    expect(api().isFullscreen()).toBe(false);
  });

  it("locks phones to landscape", async () => {
    installFullscreen();
    installMatchMedia({ "(pointer: coarse)": true });
    const lock = vi.fn(async () => {});
    Object.defineProperty(screen, "orientation", {
      configurable: true,
      value: { lock, unlock: vi.fn() },
    });
    const { api } = setup();
    act(() => api().setContainer(document.createElement("div")));
    await act(() => api().toggleFullscreen());
    expect(lock).toHaveBeenCalledWith("landscape");
    await act(() => api().toggleFullscreen());
    expect((screen.orientation as any).unlock).toHaveBeenCalled();
  });

  it("uses the webkit prefixed API (old Safari)", async () => {
    mobile = true;
    const { api } = setup();
    const el = document.createElement("div") as any;
    el.requestFullscreen = undefined;
    el.webkitRequestFullscreen = vi.fn(async () => {
      (document as any).webkitFullscreenElement = el;
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: undefined,
    });
    (document as any).webkitExitFullscreen = vi.fn(async () => {
      (document as any).webkitFullscreenElement = null;
    });
    act(() => api().setContainer(el));
    await act(() => api().toggleFullscreen());
    expect(el.webkitRequestFullscreen).toHaveBeenCalled();
    expect(api().isFullscreen()).toBe(true);
    await act(() => api().toggleFullscreen());
    expect((document as any).webkitExitFullscreen).toHaveBeenCalled();
    delete (document as any).webkitExitFullscreen;
    delete (document as any).webkitFullscreenElement;
  });

  it("falls back to the video's native fullscreen on iOS", async () => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    const { api, set } = setup();
    const el = document.createElement("div") as any;
    el.requestFullscreen = undefined;
    (video as any).webkitEnterFullscreen = vi.fn();
    act(() => api().setContainer(el));
    await act(() => api().toggleFullscreen());
    expect((video as any).webkitEnterFullscreen).toHaveBeenCalled();
    // Not for YouTube, and nothing to do without any API
    (video as any).webkitEnterFullscreen.mockClear();
    set({ roomMedia: YT });
    await act(() => api().toggleFullscreen());
    expect((video as any).webkitEnterFullscreen).not.toHaveBeenCalled();
  });

  it("logs a failed request instead of throwing", async () => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api } = setup();
    const el = document.createElement("div") as any;
    el.requestFullscreen = vi.fn(async () => {
      throw new Error("denied");
    });
    act(() => api().setContainer(el));
    await act(() => api().toggleFullscreen());
    expect(warn).toHaveBeenCalledWith("fullscreen failed", expect.any(Error));
  });
});

describe("usePlayer time reports", () => {
  it("reports the time every second and the duration on change / every 30 s", () => {
    vi.useFakeTimers();
    const { cmd, set, rerender } = setup({ connected: false });
    vi.advanceTimersByTime(2000);
    expect(cmd.reportTime).not.toHaveBeenCalled();
    rerender({ connected: true });
    time = 12;
    vi.advanceTimersByTime(1000);
    expect(cmd.reportTime).toHaveBeenLastCalledWith(12);
    expect(cmd.reportDuration).toHaveBeenCalledTimes(1);
    expect(cmd.reportDuration).toHaveBeenLastCalledWith(100);
    vi.advanceTimersByTime(5000);
    expect(cmd.reportDuration).toHaveBeenCalledTimes(1);
    duration = 200;
    vi.advanceTimersByTime(1000);
    expect(cmd.reportDuration).toHaveBeenLastCalledWith(200);
    // Not while loading (the player is still at ~0)
    cmd.reportTime.mockClear();
    set({ loading: true });
    vi.advanceTimersByTime(3000);
    expect(cmd.reportTime).not.toHaveBeenCalled();
  });
});

describe("usePlayer YouTube iframe API", () => {
  function loadYT() {
    const ctx = setup();
    let config: any;
    const ytPlayer = {
      getVideoUrl: () => YT,
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      getPlayerState: () => 1,
      getCurrentTime: () => 0,
      getDuration: () => 100,
      mute: vi.fn(),
      unMute: vi.fn(),
      isMuted: () => false,
      setPlaybackRate: vi.fn(),
      getPlaybackRate: () => 1,
      seekTo: vi.fn(),
    };
    (window as any).YT = {
      Player: vi.fn(function (_id: string, c: unknown) {
        config = c;
        return ytPlayer;
      }),
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    };
    ctx.api().loadYouTube();
    expect(document.querySelector("script")?.src).toBe(
      "https://www.youtube.com/iframe_api",
    );
    (window as any).onYouTubeIframeAPIReady();
    return { ...ctx, events: () => config.events, ytPlayer };
  }
  afterEach(() => {
    delete (window as any).YT;
  });

  it("creates the YouTube player once the API is ready and asks for the video again", () => {
    const { events, set, cmd, api, get } = loadYT();
    set({ roomMedia: YT, loading: true });
    act(() => events().onReady());
    expect(api().youtube().isReady()).toBe(true);
    expect(get().loading).toBe(false);
    expect(cmd.askHost).toHaveBeenCalled();
  });

  it("tracks buffering, cued and ended states", async () => {
    const { events, set, get, cmd } = loadYT();
    set({
      roomMedia: YT,
      loading: true,
      roomPaused: false,
      videoMeta: { title: "x" },
    });
    act(() => events().onStateChange({ data: 3, target: {} }));
    expect(get().buffering).toBe(true);
    act(() => events().onStateChange({ data: 5, target: {} }));
    expect(get().loading).toBe(false);
    expect(get().buffering).toBe(false);
    await act(async () =>
      events().onStateChange({ data: 0, target: { getVideoUrl: () => YT } }),
    );
    expect(cmd.nextEpisode).toHaveBeenCalledWith({ action: "ended", url: YT });
  });

  it("sends play/pause from the YouTube UI to the room, debounced", async () => {
    vi.useFakeTimers();
    const { events, set, cmd } = loadYT();
    set({ roomMedia: YT, roomPaused: true });
    await act(async () => events().onStateChange({ data: 1, target: {} }));
    expect(cmd.play).toHaveBeenCalledTimes(1);
    // Within 500 ms: ignored
    await act(async () => events().onStateChange({ data: 2, target: {} }));
    expect(cmd.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    await act(async () => events().onStateChange({ data: 2, target: {} }));
    expect(cmd.pause).toHaveBeenCalledTimes(1);
  });

  it("ignores state changes while the room isn't on YouTube", () => {
    const { events, get } = loadYT();
    act(() => events().onStateChange({ data: 3, target: {} }));
    expect(get().buffering).toBe(false);
    act(() => events().onReady());
  });
});
