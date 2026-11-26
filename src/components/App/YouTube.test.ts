// The YouTube player wrapper over a fake YT.Player (the iframe API isn't loaded in tests).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YouTube } from "./YouTube";

function fakeYT(overrides: Record<string, unknown> = {}) {
  let volume = 80;
  return {
    getCurrentTime: vi.fn(() => 12),
    getDuration: vi.fn(() => 100),
    isMuted: vi.fn(() => true),
    getPlaybackRate: vi.fn(() => 1.5),
    setPlaybackRate: vi.fn(),
    cueVideoById: vi.fn(),
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    seekTo: vi.fn(),
    getPlayerState: vi.fn(() => 1),
    mute: vi.fn(),
    unMute: vi.fn(),
    setVolume: vi.fn((v: number) => {
      volume = v;
    }),
    getVolume: vi.fn(() => volume),
    setOption: vi.fn(),
    stopVideo: vi.fn(),
    getAvailablePlaybackRates: vi.fn(() => [0.5, 1, 2]),
    getVideoLoadedFraction: vi.fn(() => 0.25),
    setLoop: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  (window as any).YT = { PlayerState: { PAUSED: 2, BUFFERING: 3 } };
});
afterEach(() => {
  delete (window as any).YT;
  vi.useRealTimers();
});

describe("YouTube player", () => {
  it("reads time, duration, mute and rate from the YT player", () => {
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    expect(p.getCurrentTime()).toBe(12);
    expect(p.getDuration()).toBe(100);
    expect(p.isMuted()).toBe(true);
    expect(p.getPlaybackRate()).toBe(1.5);
    expect(p.getAvailablePlaybackRates()).toEqual([0.5, 1, 2]);
    expect(p.isReady()).toBe(true);
    p.setPlaybackRate(2);
    expect(yt.setPlaybackRate).toHaveBeenCalledWith(2);
  });

  it("has safe defaults without a YT player", () => {
    const p = new YouTube(null);
    expect(p.getCurrentTime()).toBe(0);
    expect(p.getDuration()).toBe(0);
    expect(p.isMuted()).toBe(false);
    expect(p.getPlaybackRate()).toBe(1);
    expect(p.getVolume()).toBe(0);
    expect(p.getAvailablePlaybackRates()).toEqual([1]);
    expect(p.isReady()).toBe(false);
    expect(p.getTimeRanges()).toEqual([{ start: 0, end: 0 }]);
    // No-ops don't throw
    p.setDuck(0.5);
    p.setMute(true);
    p.seekVideo(3);
    p.pauseVideo();
    p.stopVideo();
    p.setLoop(true);
    p.clearState();
    p.clearDashState();
    p.setDashState({} as any);
    p.syncSubtitles(1);
    p.setSubtitleOffset(2);
    return p.loadSubtitles("x");
  });

  it("cues the video id from watch and short links at the given time", async () => {
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    await p.setSrcAndTime("https://www.youtube.com/watch?v=abc123&t=5", 30);
    expect(yt.cueVideoById).toHaveBeenLastCalledWith("abc123", 30);
    await p.setSrcAndTime("https://youtu.be/xyz789?si=foo", 0);
    expect(yt.cueVideoById).toHaveBeenLastCalledWith("xyz789", 0);
  });

  it("plays after a short delay, pauses and seeks", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    await p.playVideo();
    expect(yt.playVideo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(yt.playVideo).toHaveBeenCalled();
    p.pauseVideo();
    expect(yt.pauseVideo).toHaveBeenCalled();
    p.seekVideo(42);
    expect(yt.seekTo).toHaveBeenCalledWith(42, true);
    p.stopVideo();
    expect(yt.stopVideo).toHaveBeenCalled();
  });

  it("shouldPlay when paused or at the end", () => {
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    expect(p.shouldPlay()).toBe(false);
    yt.getPlayerState.mockReturnValue(2);
    expect(p.shouldPlay()).toBe(true);
    yt.getPlayerState.mockReturnValue(1);
    yt.getCurrentTime.mockReturnValue(100);
    expect(p.shouldPlay()).toBe(true);
  });

  it("reports buffering from the player state", () => {
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    expect(p.isBuffering()).toBe(false);
    yt.getPlayerState.mockReturnValue(3);
    expect(p.isBuffering()).toBe(true);
  });

  it("mutes and unmutes", () => {
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    p.setMute(true);
    expect(yt.mute).toHaveBeenCalled();
    p.setMute(false);
    expect(yt.unMute).toHaveBeenCalled();
  });

  it("keeps the viewer's volume while ducked", () => {
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    expect(p.getVolume()).toBe(0.8);
    p.setDuck(0.25);
    expect(yt.setVolume).toHaveBeenLastCalledWith(20);
    // getVolume is still the viewer's own volume
    expect(p.getVolume()).toBe(0.8);
    p.setVolume(0.4);
    expect(yt.setVolume).toHaveBeenLastCalledWith(10);
    expect(p.getVolume()).toBe(0.4);
    // Another duck factor keeps the viewer's volume (not the ducked one)
    p.setDuck(0.5);
    expect(yt.setVolume).toHaveBeenLastCalledWith(20);
    p.setDuck(1);
    expect(yt.setVolume).toHaveBeenLastCalledWith(40);
    expect(p.getVolume()).toBe(0.4);
  });

  it("ignores ducking when the player has no volume API", () => {
    const p = new YouTube({ getVolume: () => 50 } as any);
    p.setDuck(0.5);
    // Not ducked: the volume is still the player's
    expect(p.getVolume()).toBe(0.5);
  });

  it("toggles captions through setOption", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    expect(p.isSubtitled()).toBe(false);
    p.setSubtitleMode();
    expect(p.isSubtitled()).toBe(true);
    expect(p.getSubtitleMode()).toBe("showing");
    expect(yt.setOption).toHaveBeenCalledWith("captions", "track", {
      languageCode: "en",
    });
    p.setSubtitleMode();
    expect(p.getSubtitleMode()).toBe("hidden");
    expect(yt.setOption).toHaveBeenLastCalledWith("captions", "track", {});
    (p.setSubtitleMode as any)("showing", "fr");
    expect(yt.setOption).toHaveBeenLastCalledWith("captions", "track", {
      languageCode: "fr",
    });
  });

  it("buffered range is the loaded fraction of the duration", () => {
    const yt = fakeYT();
    const p = new YouTube(yt as any);
    expect(p.getTimeRanges()).toEqual([{ start: 0, end: 25 }]);
    p.setLoop(true);
    expect(yt.setLoop).toHaveBeenCalledWith(true);
  });

  it("finds its element by id", () => {
    document.body.innerHTML = '<div id="leftYt"></div>';
    expect(new YouTube(null).getVideoEl()?.id).toBe("leftYt");
  });
});
