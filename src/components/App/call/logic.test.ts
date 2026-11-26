import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyMicError,
  createStateThrottle,
  isPttKey,
  isTransmitting,
  joinMuted,
  micConstraints,
  newCallSession,
  readRejoin,
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
