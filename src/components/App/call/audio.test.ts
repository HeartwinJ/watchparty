// CallAudio (remote playback, levels, speaking detection) and the mic helpers, with fake WebAudio and media.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeAudioContext,
  FakeTrack,
  installAudioContext,
  installMediaDevices,
} from "../../../test/browserFakes";
import { CallAudio, listMics, openMic } from "./audio";

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playError: unknown = null;
  autoplay = false;
  srcObject: unknown = null;
  paused = true;
  constructor() {
    FakeAudio.instances.push(this);
  }
  play = vi.fn(() => {
    if (FakeAudio.playError) {
      return Promise.reject(FakeAudio.playError);
    }
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

const track = (kind = "audio") =>
  new FakeTrack(kind) as unknown as MediaStreamTrack;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
  });
  installAudioContext();
  installMediaDevices();
  FakeAudio.instances = [];
  FakeAudio.playError = null;
  vi.stubGlobal("Audio", FakeAudio);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CallAudio", () => {
  it("creates and resumes one AudioContext and ticks", async () => {
    const audio = new CallAudio();
    const onTick = vi.fn();
    audio.onTick = onTick;
    await audio.start();
    await audio.start();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(130);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick).toHaveBeenLastCalledWith(false);
    audio.close();
    vi.advanceTimersByTime(200);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled();
  });

  it("works without WebAudio (no levels, still plays remote audio)", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const audio = new CallAudio();
    await audio.start();
    audio.addRemote("bob", track());
    expect(FakeAudio.instances).toHaveLength(1);
    expect(audio.levelOf("bob")).toBe(-100);
    audio.close();
  });

  it("survives a resume() that rejects", async () => {
    const audio = new CallAudio();
    await audio.start();
    FakeAudioContext.instances[0].resume.mockRejectedValueOnce(new Error("x"));
    await expect(audio.start()).resolves.toBeUndefined();
    audio.close();
  });

  it("plays remote audio through an element and ignores video tracks", async () => {
    const audio = new CallAudio();
    await audio.start();
    audio.addRemote("bob", track("video"));
    expect(FakeAudio.instances).toHaveLength(0);
    audio.addRemote("bob", track());
    const el = FakeAudio.instances[0];
    expect(el.autoplay).toBe(true);
    expect(el.play).toHaveBeenCalled();
    // Replacing the track tears down the old element
    audio.addRemote("bob", track());
    expect(el.pause).toHaveBeenCalled();
    expect(el.srcObject).toBeNull();
    audio.remove("bob");
    audio.remove("nobody");
    expect(FakeAudio.instances[1].srcObject).toBeNull();
    audio.close();
  });

  it("reports autoplay blocking only for NotAllowedError", async () => {
    const audio = new CallAudio();
    const onBlocked = vi.fn();
    audio.onBlocked = onBlocked;
    await audio.start();
    FakeAudio.playError = { name: "AbortError" };
    audio.addRemote("a", track());
    await Promise.resolve();
    await Promise.resolve();
    expect(onBlocked).not.toHaveBeenCalled();
    FakeAudio.playError = { name: "NotAllowedError" };
    audio.addRemote("b", track());
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1));
    audio.close();
  });

  it("unblock() replays every element and says whether all played", async () => {
    const audio = new CallAudio();
    await audio.start();
    FakeAudio.playError = { name: "NotAllowedError" };
    audio.addRemote("a", track());
    expect(await audio.unblock()).toBe(false);
    FakeAudio.playError = null;
    expect(await audio.unblock()).toBe(true);
    audio.close();
  });

  it("detects speaking with hysteresis and reports remote speech for ducking", async () => {
    const audio = new CallAudio();
    const onSpeaking = vi.fn();
    const onTick = vi.fn();
    audio.onSpeaking = onSpeaking;
    audio.onTick = onTick;
    await audio.start();
    const ctx = FakeAudioContext.instances[0];
    const mine = new FakeTrack("audio");
    audio.setLocal("me", mine as unknown as MediaStreamTrack);
    audio.addRemote("bob", track());

    ctx.level = 0.1; // -20 dBFS, well above the speaking threshold
    vi.advanceTimersByTime(300);
    expect(onSpeaking).toHaveBeenLastCalledWith(["bob", "me"]);
    expect(onTick).toHaveBeenLastCalledWith(true);
    expect(audio.levelOf("bob")).toBeCloseTo(-20, 0);

    // A muted mic is silent, so only bob keeps speaking
    mine.enabled = false;
    vi.advanceTimersByTime(800);
    expect(onSpeaking).toHaveBeenLastCalledWith(["bob"]);
    expect(audio.levelOf("me")).toBe(-100);

    // Only our own voice never ducks
    mine.enabled = true;
    audio.remove("bob");
    vi.advanceTimersByTime(300);
    expect(onSpeaking).toHaveBeenLastCalledWith(["me"]);
    expect(onTick).toHaveBeenLastCalledWith(false);

    ctx.level = 0;
    vi.advanceTimersByTime(800);
    expect(onSpeaking).toHaveBeenLastCalledWith([]);
    const calls = onSpeaking.mock.calls.length;
    vi.advanceTimersByTime(300);
    // Unchanged → not reported again
    expect(onSpeaking).toHaveBeenCalledTimes(calls);
    audio.close();
  });

  it("setLocal replaces and clears the local source", async () => {
    const audio = new CallAudio();
    await audio.start();
    audio.setLocal("me", track());
    audio.setLocal("me2", track());
    expect(audio.levelOf("me")).toBe(-100);
    audio.setLocal("me2", null);
    FakeAudioContext.instances[0].level = 0.5;
    const onSpeaking = vi.fn();
    audio.onSpeaking = onSpeaking;
    vi.advanceTimersByTime(500);
    expect(onSpeaking).not.toHaveBeenCalled();
    audio.close();
  });

  it("keeps a source without levels when analysing fails", async () => {
    const audio = new CallAudio();
    await audio.start();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    FakeAudioContext.instances[0].createMediaStreamSource.mockImplementationOnce(
      () => {
        throw new Error("no");
      },
    );
    audio.addRemote("bob", track());
    expect(warn).toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(audio.levelOf("bob")).toBe(-100);
    warn.mockRestore();
    audio.close();
  });
});

describe("openMic", () => {
  it("returns the stream and the device it opened", async () => {
    const res = await openMic(null);
    expect(res).toMatchObject({ ok: true, deviceId: "mic-1" });
  });

  it("falls back to the default mic when the remembered one is gone", async () => {
    const devices = installMediaDevices();
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotFoundError" });
    const res = await openMic("old-mic");
    expect(res.ok).toBe(true);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("reports the error when the fallback fails too", async () => {
    const devices = installMediaDevices();
    devices.getUserMedia
      .mockRejectedValueOnce({ name: "OverconstrainedError" })
      .mockRejectedValueOnce({ name: "NotAllowedError" });
    expect(await openMic("old-mic")).toEqual({ ok: false, error: "blocked" });
  });

  it("doesn't retry without a remembered device or for other errors", async () => {
    const devices = installMediaDevices();
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotFoundError" });
    expect(await openMic(null)).toEqual({ ok: false, error: "no-device" });
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotReadableError" });
    expect(await openMic("mic-1")).toEqual({ ok: false, error: "in-use" });
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("falls back to the requested id when the track has no settings", async () => {
    const devices = installMediaDevices();
    devices.getUserMedia.mockResolvedValueOnce({
      getAudioTracks: () => [],
    } as never);
    expect(await openMic("mic-9")).toMatchObject({ deviceId: "mic-9" });
    devices.getUserMedia.mockResolvedValueOnce({
      getAudioTracks: () => [],
    } as never);
    expect(await openMic()).toMatchObject({ deviceId: null });
  });

  it("is unsupported without getUserMedia", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    expect(await openMic()).toEqual({ ok: false, error: "unsupported" });
    expect(await listMics()).toEqual([]);
  });
});

describe("listMics", () => {
  it("lists only microphones", async () => {
    expect(await listMics()).toEqual([
      { kind: "audioinput", deviceId: "mic-1", label: "Desk mic" },
    ]);
  });
  it("returns [] when enumerating fails", async () => {
    const devices = installMediaDevices();
    devices.enumerateDevices.mockRejectedValueOnce(new Error("no"));
    expect(await listMics()).toEqual([]);
  });
});
