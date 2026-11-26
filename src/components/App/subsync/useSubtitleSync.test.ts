import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createInitialRoomState } from "../roomState";
import { useStore } from "../hooks/useStore";
import type { PlayerApi } from "../hooks/usePlayer";
import type { SubtitlesApi } from "../hooks/useSubtitles";
import type { RoomCommands } from "../socketEvents";
import { createShareSession } from "../hooks/useShare";
import { AutoSyncError, type AutoSyncOptions } from "./run";
import type { SyncResult } from "./signal";

const toast = vi.fn();
vi.mock("../ui/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));

const { useSubtitleSync } = await import("./useSubtitleSync");

const VIDEO = "https://cdn.example.com/movie.mkv";
const SUB = "https://subs.example.com/movie.srt";
const KEY = `room:${SUB}`;
const CUES = Array.from({ length: 20 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 2,
}));

const confident = (offset: number): SyncResult => ({
  offset,
  scale: 1,
  confidence: 0.6,
  peakZ: 10,
  candidate: offset,
});

function setup(opts: { cues?: typeof CUES; supported?: boolean } = {}) {
  const tracks = { selected: 0, cues: opts.cues ?? CUES };
  const player = {
    html: () => ({
      getSelectedSubtitleTrack: () => tracks.selected,
      getSubtitleTracks: () =>
        tracks.selected < 0
          ? []
          : [{ index: 0, label: "English", language: "en", fromRoom: true }],
      getOriginalCues: () => tracks.cues,
    }),
  } as unknown as PlayerApi;
  const cmd = { subtitleSync: vi.fn() } as unknown as RoomCommands & {
    subtitleSync: ReturnType<typeof vi.fn>;
  };
  const subtitles = {
    setOffset: vi.fn(),
    setTiming: vi.fn(),
  } as unknown as SubtitlesApi & {
    setOffset: ReturnType<typeof vi.fn>;
    setTiming: ReturnType<typeof vi.fn>;
  };
  const calls: AutoSyncOptions[] = [];
  let settle: {
    resolve: (r: SyncResult) => void;
    reject: (e: unknown) => void;
  } = { resolve: () => {}, reject: () => {} };
  const run = vi.fn((o: AutoSyncOptions) => {
    calls.push(o);
    return new Promise<SyncResult>((resolve, reject) => {
      settle = { resolve, reject };
      o.signal?.addEventListener("abort", () =>
        reject(new AutoSyncError("Cancelled", true)),
      );
    });
  });
  const share = createShareSession();
  const supported = () => opts.supported ?? true;
  const hook = renderHook(() => {
    const [state, store] = useStore(createInitialRoomState);
    const sync = useSubtitleSync({
      store,
      player,
      cmd,
      clientId: "me",
      subtitles,
      share,
      run,
      supported,
    });
    return { state, store, sync };
  });
  act(() =>
    hook.result.current.store.set({
      roomMedia: VIDEO,
      roomSubtitle: SUB,
      nameMap: { bob: "Bob" },
    }),
  );
  const autoOn = () =>
    act(() =>
      hook.result.current.store.set({
        roomSettings: {
          ...hook.result.current.store.get().roomSettings,
          autoSyncSubtitles: true,
        },
      }),
    );
  return {
    ...hook,
    tracks,
    cmd,
    subtitles,
    run,
    calls,
    share,
    autoOn,
    finish: (r: SyncResult) => settle.resolve(r),
    fail: (e: unknown) => settle.reject(e),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  toast.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => {});

describe("the wand (syncNow)", () => {
  it("aligns the selected track's original cues and applies the offset in the current scope", async () => {
    const t = setup();
    act(() => void t.result.current.sync.syncNow());
    expect(t.calls[0]).toMatchObject({ source: VIDEO, cues: CUES });
    expect(t.result.current.state.subtitleSyncJob).toEqual({
      auto: false,
      progress: 0,
    });
    act(() => t.calls[0].onProgress?.(0.42));
    expect(t.result.current.state.subtitleSyncJob?.progress).toBe(0.4);
    t.finish(confident(2.35));
    await flush();
    expect(t.subtitles.setTiming).toHaveBeenCalledWith(2.35, 1);
    expect(toast).toHaveBeenCalledWith(
      "Subtitles synced: +2.35 s",
      expect.objectContaining({ tone: "success" }),
    );
    expect(t.result.current.state.subtitleSyncJob).toBeNull();
  });

  it("applies a time scale for frame-rate drift", async () => {
    const t = setup();
    act(() => void t.result.current.sync.syncNow());
    t.finish({ ...confident(-1.2), scale: 24000 / 1001 / 25 });
    await flush();
    expect(t.subtitles.setTiming).toHaveBeenCalledWith(-1.2, 24000 / 1001 / 25);
    expect(toast).toHaveBeenCalledWith(
      "Subtitles synced: −1.2 s · speed 0.959 (23.976→25 fps)",
      expect.anything(),
    );
  });

  it("leaves the offset alone without a confident match", async () => {
    const t = setup();
    act(() => void t.result.current.sync.syncNow());
    t.finish({ ...confident(0), offset: null, confidence: 0.1 });
    await flush();
    expect(t.subtitles.setTiming).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Couldn't find a confident match, offset unchanged",
      expect.anything(),
    );
  });

  it("is cancelled quietly (menu closed / new video)", async () => {
    const t = setup();
    act(() => void t.result.current.sync.syncNow());
    act(() => t.result.current.sync.cancel("manual"));
    await flush();
    expect(toast).not.toHaveBeenCalled();
    expect(t.result.current.state.subtitleSyncJob).toBeNull();
    expect(t.subtitles.setOffset).not.toHaveBeenCalled();
  });

  it("explains why it can't run", async () => {
    const t = setup();
    act(() =>
      t.result.current.store.set({
        roomMedia: "https://www.youtube.com/watch?v=abc",
      }),
    );
    expect(t.result.current.sync.unavailableReason()).toBe(
      "Not available for YouTube videos",
    );
    await act(() => t.result.current.sync.syncNow());
    expect(t.run).not.toHaveBeenCalled();

    act(() => t.result.current.store.set({ roomMedia: VIDEO }));
    t.tracks.selected = -1;
    await act(() => t.result.current.sync.syncNow());
    expect(t.run).not.toHaveBeenCalled();
    expect(toast).toHaveBeenLastCalledWith(
      "Pick a subtitle track first",
      expect.anything(),
    );
  });

  it("shows a read error", async () => {
    const t = setup();
    act(() => void t.result.current.sync.syncNow());
    t.fail(new AutoSyncError("Timed out reading the video's audio"));
    await flush();
    expect(toast).toHaveBeenCalledWith(
      "Timed out reading the video's audio",
      expect.objectContaining({ tone: "danger" }),
    );
  });

  it("reads a shared file from this device", async () => {
    const t = setup();
    const file = new File(["x"], "movie.mkv");
    t.share.isFile = true;
    t.share.file = file;
    act(() => t.result.current.store.set({ roomMedia: "fileshare://me" }));
    act(() => void t.result.current.sync.syncNow());
    expect(t.calls[0].source).toBe(file);
  });
});

describe("room auto-sync", () => {
  it("does nothing while the room setting is off", () => {
    const t = setup();
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(5000));
    expect(t.cmd.subtitleSync).not.toHaveBeenCalled();
  });

  it("claims once, computes only when granted and reports the result to the server", async () => {
    const t = setup();
    t.autoOn();
    act(() => t.result.current.sync.evaluate());
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(2000));
    expect(t.cmd.subtitleSync).toHaveBeenCalledTimes(1);
    expect(t.cmd.subtitleSync).toHaveBeenCalledWith({
      action: "claim",
      video: VIDEO,
      key: KEY,
    });
    act(() =>
      t.result.current.sync.onEvent({
        status: "running",
        video: VIDEO,
        key: KEY,
        by: { id: "me" },
      }),
    );
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.result.current.state.subtitleSyncJob?.auto).toBe(true);
    t.finish(confident(-1.5));
    await flush();
    expect(t.cmd.subtitleSync).toHaveBeenLastCalledWith({
      action: "result",
      video: VIDEO,
      key: KEY,
      offset: -1.5,
      confidence: 0.6,
    });
    // The server applies it (REC:subtitleOffset); this device doesn't set it itself
    expect(t.subtitles.setOffset).not.toHaveBeenCalled();
    act(() =>
      t.result.current.sync.onEvent({
        status: "done",
        video: VIDEO,
        key: KEY,
        by: { id: "me" },
        offset: -1.5,
      }),
    );
    expect(toast).toHaveBeenCalledWith(
      "Subtitles auto-synced: −1.5 s",
      expect.anything(),
    );
  });

  it("sends a time scale with the room result", async () => {
    const t = setup();
    t.autoOn();
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(2000));
    act(() =>
      t.result.current.sync.onEvent({
        status: "running",
        video: VIDEO,
        key: KEY,
        by: { id: "me" },
      }),
    );
    t.finish({ ...confident(3), scale: 25 / 24 });
    await flush();
    expect(t.cmd.subtitleSync).toHaveBeenLastCalledWith({
      action: "result",
      video: VIDEO,
      key: KEY,
      offset: 3,
      scale: 25 / 24,
      confidence: 0.6,
    });
    act(() =>
      t.result.current.sync.onEvent({
        status: "done",
        video: VIDEO,
        key: KEY,
        by: { id: "bob" },
        offset: 3,
        scale: 1.041667,
      }),
    );
    expect(toast).toHaveBeenLastCalledWith(
      "Subtitles auto-synced by Bob: +3.0 s · speed 1.042 (25→24 fps)",
      expect.anything(),
    );
  });

  it("waits for the subtitle's cues to load", () => {
    const t = setup({ cues: [] });
    t.autoOn();
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(3000));
    expect(t.cmd.subtitleSync).not.toHaveBeenCalled();
    t.tracks.cues = CUES;
    act(() => vi.advanceTimersByTime(3000));
    expect(t.cmd.subtitleSync).toHaveBeenCalledTimes(1);
  });

  it("doesn't duplicate someone else's work, and takes over when it's released", () => {
    const t = setup();
    t.autoOn();
    act(() =>
      t.result.current.sync.onEvent({
        status: "running",
        video: VIDEO,
        key: KEY,
        by: { id: "bob", name: "Bob" },
      }),
    );
    expect(t.result.current.state.subtitleSyncRemote).toEqual({ by: "Bob" });
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(2000));
    expect(t.cmd.subtitleSync).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();

    act(() =>
      t.result.current.sync.onEvent({
        status: "released",
        video: VIDEO,
        key: KEY,
      }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(t.cmd.subtitleSync).toHaveBeenCalledWith({
      action: "claim",
      video: VIDEO,
      key: KEY,
    });
    expect(t.result.current.state.subtitleSyncRemote).toBeNull();
  });

  it("a denied claim doesn't compute", () => {
    const t = setup();
    t.autoOn();
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(2000));
    act(() =>
      t.result.current.sync.onEvent({
        status: "denied",
        video: VIDEO,
        key: KEY,
        reason: "manual",
      }),
    );
    act(() =>
      t.result.current.sync.onEvent({
        status: "running",
        video: VIDEO,
        key: KEY,
        by: { id: "me" },
      }),
    );
    expect(t.run).not.toHaveBeenCalled();
  });

  it("tells the server when it can't compute, but not after the video changed", async () => {
    const t = setup();
    t.autoOn();
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(2000));
    act(() =>
      t.result.current.sync.onEvent({
        status: "running",
        video: VIDEO,
        key: KEY,
        by: { id: "me" },
      }),
    );
    t.fail(new AutoSyncError("Couldn't read the video"));
    await flush();
    expect(t.cmd.subtitleSync).toHaveBeenLastCalledWith({
      action: "failed",
      video: VIDEO,
      key: KEY,
    });

    // Granted again, then the room moves on to another video: the job is cancelled silently
    act(() =>
      t.result.current.sync.onEvent({
        status: "released",
        video: VIDEO,
        key: KEY,
      }),
    );
    act(() => vi.advanceTimersByTime(2000));
    act(() =>
      t.result.current.sync.onEvent({
        status: "running",
        video: VIDEO,
        key: KEY,
        by: { id: "me" },
      }),
    );
    const sent = t.cmd.subtitleSync.mock.calls.length;
    act(() => {
      t.result.current.store.set({
        roomMedia: "https://cdn.example.com/next.mkv",
      });
      t.result.current.sync.onVideoChange();
    });
    await flush();
    expect(t.cmd.subtitleSync.mock.calls.length).toBe(sent);
  });

  it("toasts other people's results, and stays quiet about their unconfident ones", () => {
    const t = setup();
    act(() =>
      t.result.current.sync.onEvent({
        status: "done",
        video: VIDEO,
        key: KEY,
        by: { id: "bob" },
        offset: 3,
      }),
    );
    expect(toast).toHaveBeenCalledWith(
      "Subtitles auto-synced by Bob: +3.0 s",
      expect.anything(),
    );
    toast.mockClear();
    act(() =>
      t.result.current.sync.onEvent({
        status: "done",
        video: VIDEO,
        key: "room:other",
        by: { id: "bob" },
        offset: null,
      }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("never claims when this device can't compute it", () => {
    const t = setup({ supported: false });
    t.autoOn();
    act(() => t.result.current.sync.evaluate());
    act(() => vi.advanceTimersByTime(5000));
    expect(t.cmd.subtitleSync).not.toHaveBeenCalled();
  });
});
