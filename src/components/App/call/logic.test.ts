import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyMicError,
  createDebouncedFlag,
  createStateThrottle,
  deviceOptions,
  isPttKey,
  isTransmitting,
  joinMuted,
  micConstraints,
  newCallSession,
  readRejoin,
  wantsVideo,
  WANTS_VIDEO_DELAY_MS,
  writeRejoin,
} from "./logic";

describe("joinMuted", () => {
  it("joins muted only while a video is playing", () => {
    expect(joinMuted({ roomMedia: "https://x/a.mp4", roomPaused: false })).toBe(
      true,
    );
    expect(joinMuted({ roomMedia: "https://x/a.mp4", roomPaused: true })).toBe(
      false,
    );
    expect(joinMuted({ roomMedia: "", roomPaused: false })).toBe(false);
  });
});

describe("isTransmitting", () => {
  it("follows the mute toggle, or the held key with push-to-talk", () => {
    expect(
      isTransmitting({ muted: false, pushToTalk: false, pttHeld: false }),
    ).toBe(true);
    expect(
      isTransmitting({ muted: true, pushToTalk: false, pttHeld: true }),
    ).toBe(false);
    expect(
      isTransmitting({ muted: false, pushToTalk: true, pttHeld: false }),
    ).toBe(false);
    expect(
      isTransmitting({ muted: true, pushToTalk: true, pttHeld: true }),
    ).toBe(true);
  });
  it("uses T, which no room shortcut uses", () => {
    expect(isPttKey("t")).toBe(true);
    expect(isPttKey("T")).toBe(true);
    expect(isPttKey("m")).toBe(false);
  });
});

describe("classifyMicError", () => {
  const err = (name: string) => Object.assign(new Error("x"), { name });
  it("explains the usual getUserMedia failures", () => {
    expect(classifyMicError(err("NotAllowedError"))).toBe("blocked");
    expect(classifyMicError(err("NotReadableError"))).toBe("in-use");
    expect(classifyMicError(err("NotFoundError"))).toBe("no-device");
    expect(classifyMicError(err("OverconstrainedError"))).toBe("no-device");
    expect(classifyMicError(err("TypeError"))).toBe("unsupported");
    expect(classifyMicError("boom")).toBe("unknown");
  });
});

describe("micConstraints", () => {
  it("turns on echo cancellation, noise suppression and auto gain", () => {
    expect(micConstraints()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
    expect(micConstraints("abc").deviceId).toEqual({ exact: "abc" });
  });
});

describe("rejoin marker", () => {
  it("round-trips through sessionStorage and survives storage errors", () => {
    writeRejoin("room-a", { muted: true });
    expect(readRejoin("room-a")).toEqual({ muted: true });
    expect(readRejoin("room-b")).toBeNull();
    writeRejoin("room-a", null);
    expect(readRejoin("room-a")).toBeNull();
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(readRejoin("room-a")).toBeNull();
    spy.mockRestore();
  });
});

describe("newCallSession", () => {
  it("matches the server's session format", () => {
    expect(newCallSession()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("createStateThrottle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends at once, then coalesces quick changes into the latest value", () => {
    const sent: boolean[] = [];
    const t = createStateThrottle<boolean>((v) => sent.push(v), 200);
    t.reset(true);
    t.push(false);
    expect(sent).toEqual([false]);
    t.push(true);
    t.push(false);
    t.push(true);
    expect(sent).toEqual([false]);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([false, true]);
    // A burst that ends where it started sends nothing
    t.push(false);
    t.push(true);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([false, true]);
  });
});

describe("wantsVideo", () => {
  it("only while the tiles show: not hidden, not collapsed, tab visible", () => {
    const shown = { tilesHidden: false, tilesCollapsed: false };
    expect(wantsVideo(shown, true)).toBe(true);
    expect(wantsVideo(shown, false)).toBe(false);
    expect(wantsVideo({ ...shown, tilesHidden: true }, true)).toBe(false);
    expect(wantsVideo({ ...shown, tilesCollapsed: true }, true)).toBe(false);
  });
});

describe("createDebouncedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a value once it has held for its delay, and only when it changed", () => {
    const send = vi.fn();
    const flag = createDebouncedFlag(send, { show: 100, hide: 400 });
    flag.reset(true);
    flag.push(true);
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
    // Off waits the longer delay; pushing it again doesn't restart it
    flag.push(false);
    vi.advanceTimersByTime(300);
    flag.push(false);
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenLastCalledWith(false);
    // On is quicker
    flag.push(true);
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenLastCalledWith(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a change back before the delay sends nothing (no flapping)", () => {
    const send = vi.fn();
    const flag = createDebouncedFlag(send);
    flag.reset(true);
    flag.push(false);
    vi.advanceTimersByTime(WANTS_VIDEO_DELAY_MS.hide - 1);
    flag.push(true);
    flag.push(false);
    flag.push(true);
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it("reset and cancel drop a pending value; nothing sent yet means any value is new", () => {
    const send = vi.fn();
    const flag = createDebouncedFlag(send, { show: 10, hide: 10 });
    flag.push(false);
    flag.cancel();
    vi.advanceTimersByTime(100);
    expect(send).not.toHaveBeenCalled();
    flag.push(false);
    flag.reset(false);
    vi.advanceTimersByTime(100);
    expect(send).not.toHaveBeenCalled();
    flag.push(true);
    vi.advanceTimersByTime(10);
    expect(send).toHaveBeenCalledWith(true);
    const fresh = vi.fn();
    const other = createDebouncedFlag(fresh, { show: 10, hide: 10 });
    other.push(true);
    vi.advanceTimersByTime(10);
    expect(fresh).toHaveBeenCalledWith(true);
  });
});

describe("deviceOptions", () => {
  it("drops devices without an id and repeated ids", () => {
    expect(
      deviceOptions(
        [
          { deviceId: "", label: "" },
          { deviceId: "a", label: "Desk cam" },
          { deviceId: "a", label: "Desk cam" },
          { deviceId: "b", label: "" },
        ],
        "Camera",
      ),
    ).toEqual([
      { value: "a", label: "Desk cam" },
      { value: "b", label: "Camera 2" },
    ]);
  });
});
