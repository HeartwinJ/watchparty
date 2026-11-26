import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createInitialRoomState } from "../roomState";
import { useStore } from "./useStore";
import type { PlayerApi } from "./usePlayer";
import type { RoomCommands } from "../socketEvents";

const toast = vi.fn();
vi.mock("../ui/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));

const { useReadyCheck } = await import("./useReadyCheck");

function setup() {
  const media = {
    time: 30,
    ranges: [{ start: 0, end: 40 }],
    readyState: 3,
    share: false,
  };
  const player = {
    current: () => ({
      getCurrentTime: () => media.time,
      getDuration: () => 600,
      getTimeRanges: () => media.ranges,
      getVideoEl: () => ({ readyState: media.readyState }),
    }),
    isWebRTCShare: () => media.share,
    usingYoutube: () => false,
    toRoomTime: (t: number) => t,
  } as unknown as PlayerApi;
  const cmd = {
    reportReadyState: vi.fn(),
    skipReadyCheck: vi.fn(),
  } as unknown as RoomCommands & {
    reportReadyState: ReturnType<typeof vi.fn>;
  };
  const hook = renderHook(() => {
    const [state, store] = useStore(createInitialRoomState);
    const rc = useReadyCheck({
      store,
      cmd,
      player,
      clientId: "me",
      connected: true,
    });
    return { state, store, rc };
  });
  act(() =>
    hook.result.current.store.set({
      roomMedia: "https://v.example.com/a.mp4",
      loading: false,
      socketConnected: true,
      nameMap: { sam: "Sam" },
      roomSettings: {
        ...hook.result.current.store.get().roomSettings,
        readyCheck: true,
      },
    }),
  );
  return { ...hook, media, cmd };
}

beforeEach(() => {
  vi.useFakeTimers();
  toast.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useReadyCheck", () => {
  it("reports readiness when it changes, and a stall only after 1.5 s", () => {
    const { result, media, cmd } = setup();
    act(() => vi.advanceTimersByTime(500));
    expect(cmd.reportReadyState).toHaveBeenLastCalledWith({
      ready: true,
      buffering: false,
      time: 30,
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(cmd.reportReadyState).toHaveBeenCalledTimes(1);

    // Playback stalls with nothing buffered ahead
    media.ranges = [{ start: 0, end: 30.5 }];
    act(() => result.current.store.set({ buffering: true }));
    act(() => vi.advanceTimersByTime(500));
    expect(cmd.reportReadyState).toHaveBeenLastCalledWith({
      ready: false,
      buffering: false,
      time: 30,
    });
    act(() => vi.advanceTimersByTime(1500));
    expect(cmd.reportReadyState).toHaveBeenLastCalledWith({
      ready: false,
      buffering: true,
      time: 30,
    });
  });

  it("doesn't count a stall while the room is paused", () => {
    const { result, media, cmd } = setup();
    media.ranges = [];
    act(() => result.current.store.set({ buffering: true, roomPaused: true }));
    act(() => vi.advanceTimersByTime(3000));
    expect(cmd.reportReadyState).toHaveBeenCalledTimes(1);
    expect(cmd.reportReadyState).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, buffering: false }),
    );
  });

  it("stores REC:readyCheck, toasts the pause and re-sends its state", () => {
    const { result, cmd } = setup();
    act(() => vi.advanceTimersByTime(500));
    expect(cmd.reportReadyState).toHaveBeenCalledTimes(1);
    const state: ReadyCheckState = {
      active: true,
      waitingFor: ["sam"],
      reason: "buffering",
      trigger: "sam",
    };
    act(() => result.current.rc.onState(state));
    expect(result.current.state.readyCheck).toEqual(state);
    expect(toast).toHaveBeenCalledWith(
      "Paused — waiting for Sam to buffer",
      expect.objectContaining({ tone: "warning" }),
    );
    act(() => vi.advanceTimersByTime(500));
    expect(cmd.reportReadyState).toHaveBeenCalledTimes(2);

    result.current.rc.skip();
    expect(cmd.skipReadyCheck).toHaveBeenCalledOnce();
  });

  it("doesn't report while the room setting is off, and reports as soon as it's on", () => {
    const { result, cmd } = setup();
    const settings = result.current.store.get().roomSettings;
    act(() =>
      result.current.store.set({
        roomSettings: { ...settings, readyCheck: false },
      }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(cmd.reportReadyState).not.toHaveBeenCalled();
    act(() => result.current.store.set({ roomSettings: settings }));
    act(() => vi.advanceTimersByTime(500));
    expect(cmd.reportReadyState).toHaveBeenCalledOnce();
  });

  it("never blocks for screen share", () => {
    const { result, media, cmd } = setup();
    media.ranges = [];
    media.share = true;
    act(() =>
      result.current.store.set({
        roomMedia: "screenshare://abc",
        buffering: true,
      }),
    );
    act(() => vi.advanceTimersByTime(3000));
    expect(cmd.reportReadyState).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, buffering: false }),
    );
  });
});
