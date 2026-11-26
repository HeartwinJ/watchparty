// Opening the camera and listing devices, per-device prefs that survive storage errors, the session id fallback,
// CallVideo's snapshot rules, and the tile layout's remaining edges.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTrack, installMediaDevices } from "../../../test/browserFakes";
import { listCameras, openCamera } from "./video";
import { newCallSession, readPref, readRejoin, writePref } from "./logic";
import { CallVideo } from "./videoStreams";
import { parseStripPrefs, stripInsets, tileSize } from "./tileLayout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("openCamera", () => {
  beforeEach(() => {
    installMediaDevices();
  });

  it("opens the camera and hints that faces move", async () => {
    const res = await openCamera("cam-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stream.getVideoTracks()[0].contentHint).toBe("motion");
    }
  });

  it("falls back to the default camera when the remembered one is gone", async () => {
    const devices = installMediaDevices();
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotFoundError" });
    expect((await openCamera("old")).ok).toBe(true);
    devices.getUserMedia
      .mockRejectedValueOnce({ name: "NotFoundError" })
      .mockRejectedValueOnce({ name: "NotAllowedError" });
    expect(await openCamera("old")).toEqual({ ok: false, error: "blocked" });
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotReadableError" });
    expect(await openCamera("cam-1")).toEqual({ ok: false, error: "in-use" });
  });

  it("is unsupported without getUserMedia; lists no cameras when enumerating fails", async () => {
    const devices = installMediaDevices();
    expect(await listCameras()).toEqual([
      { kind: "videoinput", deviceId: "cam-1", label: "Desk cam" },
    ]);
    devices.enumerateDevices.mockRejectedValueOnce(new Error("no"));
    expect(await listCameras()).toEqual([]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    expect(await openCamera()).toEqual({ ok: false, error: "unsupported" });
    expect(await listCameras()).toEqual([]);
  });
});

describe("call prefs and session", () => {
  it("prefs survive blocked storage", () => {
    writePref("wp-test", "1");
    expect(readPref("wp-test")).toBe("1");
    writePref("wp-test", null);
    expect(readPref("wp-test")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readPref("wp-test")).toBeNull();
    expect(() => writePref("wp-test", "1")).not.toThrow();
  });

  it("a corrupt rejoin marker reads as none", () => {
    window.sessionStorage.setItem("wp-call:r", "{not json");
    expect(readRejoin("r")).toBeNull();
    window.sessionStorage.setItem("wp-call:r", '{"muted":"yes"}');
    expect(readRejoin("r")).toEqual({ muted: false });
  });

  it("makes a session id without crypto.randomUUID", () => {
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("insecure context");
    });
    expect(newCallSession()).toMatch(/^[a-z0-9]{24}$/);
  });
});

describe("CallVideo", () => {
  it("only notifies on real changes and drops listeners on unsubscribe", () => {
    const video = new CallVideo();
    const fn = vi.fn();
    const off = video.subscribe(fn);
    video.setLocal(null);
    expect(fn).not.toHaveBeenCalled();
    const cam = new FakeTrack("video") as unknown as MediaStreamTrack;
    video.setLocal(cam);
    expect(fn).toHaveBeenCalledTimes(1);
    // The same track again: nothing
    video.setLocal(cam);
    expect(fn).toHaveBeenCalledTimes(1);
    // Audio isn't video; removing someone unknown changes nothing
    video.addRemote("a", new FakeTrack("audio") as unknown as MediaStreamTrack);
    video.remove("a");
    expect(fn).toHaveBeenCalledTimes(1);
    const remote = new FakeTrack("video");
    video.addRemote("a", remote as unknown as MediaStreamTrack);
    expect(video.getSnapshot().remote.a.live).toBe(true);
    remote.dispatch("ended");
    expect(video.getSnapshot().remote.a.live).toBe(false);
    video.clear();
    expect(video.getSnapshot()).toEqual({ local: null, remote: {} });
    // Listeners were removed with the track
    const calls = fn.mock.calls.length;
    remote.dispatch("mute");
    expect(fn).toHaveBeenCalledTimes(calls);
    off();
    video.setLocal(cam);
    expect(fn).toHaveBeenCalledTimes(calls);
  });
});

describe("tile layout edges", () => {
  it("phone insets in fullscreen with the controls and reserved edges", () => {
    expect(
      stripInsets({
        fullscreen: true,
        phone: true,
        controls: true,
        reserve: { top: 1, right: 2, bottom: 3, left: 4 },
      }),
    ).toEqual({ top: 49, right: 10, bottom: 67, left: 12 });
  });

  it("enlarged tiles on phones, and a tiny available height keeps 40 px", () => {
    expect(
      tileSize({ width: 400, height: 300 }, { phone: true, enlarged: true })
        .width,
    ).toBe(180);
    expect(
      tileSize(
        { width: 1280, height: 720 },
        { phone: false, availableHeight: 10 },
      ),
    ).toEqual({ width: 53, height: 40 });
  });

  it("parses prefs with partial or wrong fields", () => {
    expect(parseStripPrefs("null")).toEqual({ fx: 0, fy: 0, collapsed: false });
    expect(parseStripPrefs('{"fx":"1","fy":2}')).toEqual({
      fx: 0,
      fy: 1,
      collapsed: false,
    });
  });
});
