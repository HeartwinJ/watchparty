// useCall on its own (no socket): a fake transport, fake mic/camera and WebAudio, toasts recorded. Covers the edge
// cases the room-level test (useCall.test.ts) doesn't: rejoin after reload, join timeout, mic/camera loss, push to
// talk, ducking, autoplay blocking and leaving.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  FakeAudioContext,
  FakeTrack,
  installAudioContext,
  installMediaDevices,
  type FakeMediaDevices,
} from "../../../test/browserFakes";

const toast = vi.fn();
vi.mock("../ui/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));
const getIceServers = vi.fn(async () => [{ urls: "stun:stun.example.com" }]);
vi.mock("../../../utils/iceServers", () => ({
  getIceServers: () => getIceServers(),
}));

interface FakeTransport {
  opts: any;
  setLocalTrack: ReturnType<typeof vi.fn>;
  setPeers: ReturnType<typeof vi.fn>;
  handleSignal: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
const transports: FakeTransport[] = [];
vi.mock("./transport", () => ({
  createMeshTransport: (opts: unknown) => {
    const t = {
      opts,
      setLocalTrack: vi.fn(),
      setPeers: vi.fn(),
      handleSignal: vi.fn(),
      close: vi.fn(),
    };
    transports.push(t);
    return t;
  },
}));

class FakeAudio {
  static instances: FakeAudio[] = [];
  static blocked = false;
  srcObject: unknown = null;
  autoplay = false;
  constructor() {
    FakeAudio.instances.push(this);
  }
  play = vi.fn(() =>
    FakeAudio.blocked
      ? Promise.reject({ name: "NotAllowedError" })
      : Promise.resolve(),
  );
  pause = vi.fn();
}

const { useCall } = await import("./useCall");
const { useStore } = await import("../hooks/useStore");
const { createInitialRoomState } = await import("../roomState");
const { rejoinKey, CALL_PREFS } = await import("./logic");

const ME = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOM = "call-unit";

let devices: FakeMediaDevices;
const htmlDuck = vi.fn();
const ytDuck = vi.fn();

function setup(init: Partial<ReturnType<typeof createInitialRoomState>> = {}) {
  const cmd = {
    call: vi.fn(),
    callSignal: vi.fn(),
    moderateCall: vi.fn(),
  };
  const player = {
    html: () => ({ setDuck: htmlDuck }),
    youtube: () => ({ setDuck: ytDuck }),
  };
  const hook = renderHook(
    ({ roomId }) => {
      const [state, store] = useStore(() => ({
        ...createInitialRoomState(),
        ...init,
      }));
      const api = useCall({
        store,
        cmd: cmd as any,
        clientId: ME,
        roomId,
        player: player as any,
      });
      return { state, store, api };
    },
    { initialProps: { roomId: ROOM } },
  );
  const api = () => hook.result.current.api;
  const call = () => hook.result.current.store.get().call;
  return { ...hook, cmd, api, call };
}

const member = (clientId: string, session: string, extra = {}) => ({
  clientId,
  session,
  muted: false,
  camera: false,
  joinedAt: 1,
  reconnecting: false,
  ...extra,
});

/** Joins and lets the server list us */
async function joined(ctx: ReturnType<typeof setup>) {
  await act(() => ctx.api().join());
  const session = ctx.call().session!;
  act(() =>
    ctx.api().onState({
      members: [member(ME, session), member(BOB, "bobsession")],
    }),
  );
  return session;
}

beforeEach(() => {
  devices = installMediaDevices();
  installAudioContext();
  FakeAudio.instances = [];
  FakeAudio.blocked = false;
  vi.stubGlobal("Audio", FakeAudio);
  transports.length = 0;
  toast.mockClear();
  htmlDuck.mockClear();
  ytDuck.mockClear();
  getIceServers.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useCall: joining", () => {
  it("joins with the mic, lists peers and clears the join timer once listed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ctx = setup();
    await joined(ctx);
    expect(ctx.call().status).toBe("joined");
    expect(ctx.cmd.call).toHaveBeenCalledWith(
      expect.objectContaining({ action: "join", muted: false, camera: false }),
    );
    expect(transports[0].setPeers).toHaveBeenLastCalledWith([
      { clientId: BOB, session: "bobsession", reconnecting: false },
    ]);
    // The rejoin marker for a reload
    expect(JSON.parse(window.sessionStorage.getItem(rejoinKey(ROOM))!)).toEqual(
      { muted: false },
    );
    act(() => vi.advanceTimersByTime(9000));
    expect(ctx.call().status).toBe("joined");
  });

  it("gives up after 8 s if the server never lists us", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ctx = setup();
    await act(() => ctx.api().join());
    expect(ctx.call().status).toBe("joining");
    act(() => vi.advanceTimersByTime(8000));
    expect(ctx.call().status).toBe("idle");
    expect(transports[0].close).toHaveBeenCalled();
    expect(window.sessionStorage.getItem(rejoinKey(ROOM))).toBeNull();
    expect(toast).toHaveBeenCalledWith(
      "Couldn't join the voice call. Try again in a moment.",
      expect.anything(),
    );
  });

  it("ignores a second join while joining", async () => {
    const ctx = setup();
    await act(() => ctx.api().join());
    await act(() => ctx.api().join());
    expect(transports).toHaveLength(1);
  });

  it("tells push-to-talk users how to talk when joining muted", async () => {
    window.localStorage.setItem(CALL_PREFS.pushToTalk, "1");
    const ctx = setup({
      roomMedia: "https://example.com/v.mp4",
      roomPaused: false,
    });
    await act(() => ctx.api().join());
    expect(toast).toHaveBeenCalledWith(
      "You joined the call. Hold T to talk.",
      expect.anything(),
    );
  });

  it("a leave while ICE servers load cancels the join", async () => {
    let release!: (v: { urls: string }[]) => void;
    getIceServers.mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    const ctx = setup();
    let joining!: Promise<void>;
    act(() => {
      joining = ctx.api().join();
    });
    await vi.waitFor(() => expect(getIceServers).toHaveBeenCalled());
    act(() => ctx.api().leave());
    await act(async () => {
      release([]);
      await joining;
    });
    expect(transports).toHaveLength(0);
    expect(ctx.call().status).toBe("idle");
  });

  it("rejoins after a reload with the remembered mute state, once", async () => {
    window.sessionStorage.setItem(rejoinKey(ROOM), '{"muted":true}');
    const ctx = setup();
    await act(async () => ctx.api().onConnect());
    await vi.waitFor(() => expect(ctx.call().status).toBe("joining"));
    expect(ctx.call().muted).toBe(true);
    // No "you joined muted" toast for a rejoin
    expect(toast).not.toHaveBeenCalled();
    act(() => ctx.api().leave());
    window.sessionStorage.setItem(rejoinKey(ROOM), '{"muted":true}');
    await act(async () => ctx.api().onConnect());
    expect(transports).toHaveLength(1);
  });

  it("a failed rejoin says why, forgets the marker and offers to try again", async () => {
    window.sessionStorage.setItem(rejoinKey(ROOM), '{"muted":false}');
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotAllowedError" });
    const ctx = setup();
    await act(async () => ctx.api().onConnect());
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatch(/^Couldn't rejoin the voice call/);
    expect(window.sessionStorage.getItem(rejoinKey(ROOM))).toBeNull();
    expect(ctx.call().micError).toBe("blocked");
    // Try again
    await act(async () => toast.mock.calls[0][1].action.onClick());
    await vi.waitFor(() => expect(ctx.call().status).toBe("joining"));
  });

  it("resumes the call on a socket reconnect, and a server disconnect ends it", async () => {
    const ctx = setup();
    await joined(ctx);
    ctx.cmd.call.mockClear();
    act(() => ctx.api().onDisconnect("transport close"));
    expect(ctx.call().status).toBe("joined");
    act(() => ctx.api().onConnect());
    expect(ctx.call().status).toBe("joining");
    expect(ctx.cmd.call).toHaveBeenCalledWith(
      expect.objectContaining({ action: "join" }),
    );
    act(() => ctx.api().onDisconnect("io server disconnect"));
    expect(ctx.call().status).toBe("idle");
  });

  it("leaves when the server stops listing us", async () => {
    const ctx = setup();
    await joined(ctx);
    act(() => ctx.api().onState({ members: [member(BOB, "bobsession")] }));
    expect(ctx.call().status).toBe("idle");
    expect(toast).toHaveBeenCalledWith(
      "You're no longer in the voice call.",
      expect.anything(),
    );
    // Not in the call: state updates just store the members
    act(() => ctx.api().onState({ members: [member(BOB, "bobsession")] }));
    expect(ctx.call().members).toHaveLength(1);
  });

  it("passes signals to the transport and routes tracks", async () => {
    const ctx = setup();
    await joined(ctx);
    const t = transports[0];
    const sig = { from: BOB, session: "s", toSession: "x" } as any;
    ctx.api().onSignal(sig);
    expect(t.handleSignal).toHaveBeenCalledWith(sig);
    act(() => {
      t.opts.events.onTrack(BOB, new FakeTrack("video"));
      t.opts.events.onTrack(BOB, new FakeTrack("audio"));
    });
    expect(ctx.api().video.getSnapshot().remote[BOB]).toBeTruthy();
    expect(FakeAudio.instances).toHaveLength(1);
    act(() => t.opts.events.onPeerStatus(BOB, "connected"));
    expect(ctx.call().peers[BOB]).toBe("connected");
    act(() => t.opts.events.onPeerClosed(BOB));
    expect(ctx.call().peers[BOB]).toBeUndefined();
    expect(ctx.api().video.getSnapshot().remote[BOB]).toBeUndefined();
  });

  it("leaves on unmount (teardown) and on a room change", async () => {
    const ctx = setup();
    await joined(ctx);
    ctx.cmd.call.mockClear();
    ctx.rerender({ roomId: "other-room" });
    expect(ctx.cmd.call).toHaveBeenCalledWith({ action: "leave" });
  });
});

describe("useCall: mic", () => {
  it("switches to the default mic when the one in use ends", async () => {
    const ctx = setup();
    await joined(ctx);
    const first = devices.tracks[0];
    await act(async () => {
      first.onended?.();
    });
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith(
      "Microphone disconnected. Using Desk mic now.",
      expect.anything(),
    );
    expect(transports[0].setLocalTrack).toHaveBeenLastCalledWith(
      "audio",
      devices.tracks[1],
    );
    expect(first.stop).toHaveBeenCalled();
  });

  it("says 'default microphone' when the new mic has no label", async () => {
    const ctx = setup();
    await joined(ctx);
    devices.getUserMedia.mockImplementationOnce(async () => {
      const t = new FakeTrack("audio", "");
      devices.tracks.push(t);
      return { getAudioTracks: () => [t], getTracks: () => [t] } as any;
    });
    await act(async () => {
      devices.tracks[0].onended?.();
    });
    expect(toast).toHaveBeenCalledWith(
      "Microphone disconnected. Switched to the default microphone.",
      expect.anything(),
    );
  });

  it("mutes and shows the error when no mic is left", async () => {
    const ctx = setup();
    await joined(ctx);
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotFoundError" });
    await act(async () => {
      devices.tracks[0].onended?.();
    });
    expect(ctx.call().muted).toBe(true);
    expect(ctx.call().micError).toBe("no-device");
    expect(toast).toHaveBeenCalledWith(
      "Microphone disconnected.",
      expect.anything(),
    );
  });

  it("checks the mic on devicechange (ended track, or its device gone)", async () => {
    const ctx = setup();
    await joined(ctx);
    // Still there: nothing happens
    await act(() => ctx.api().checkMic());
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    devices.enumerateDevices.mockResolvedValueOnce([
      { kind: "audioinput", deviceId: "usb-mic", label: "USB" },
    ]);
    await act(() => ctx.api().checkMic());
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    devices.tracks[1].readyState = "ended";
    await act(() => ctx.api().checkMic());
    expect(devices.getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("checkMic does nothing outside the call", async () => {
    const ctx = setup();
    await act(() => ctx.api().checkMic());
    expect(devices.getUserMedia).not.toHaveBeenCalled();
  });

  it("setDevice switches mics and remembers it, or shows why it can't", async () => {
    const ctx = setup();
    await joined(ctx);
    await act(() => ctx.api().setDevice("mic-2"));
    expect(window.localStorage.getItem(CALL_PREFS.mic)).toBe("mic-2");
    expect(ctx.api().currentDeviceId()).toBe("mic-1");
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotReadableError" });
    await act(() => ctx.api().setDevice("mic-3"));
    expect(ctx.call().micError).toBe("in-use");
    expect(toast).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ tone: "danger" }),
    );
  });

  it("previews the mic before joining and releases it when the panel closes", async () => {
    const ctx = setup();
    await act(() => ctx.api().startPreview());
    expect(devices.tracks).toHaveLength(1);
    expect(ctx.api().getLevel()).toBe(0);
    act(() => ctx.api().stopPreview());
    expect(devices.tracks[0].stop).toHaveBeenCalled();
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled();
  });

  it("a panel closed while the mic opens releases it once it's open", async () => {
    const ctx = setup();
    let p!: Promise<void>;
    act(() => {
      p = ctx.api().startPreview();
      ctx.api().stopPreview();
    });
    await act(() => p);
    expect(devices.tracks[0].stop).toHaveBeenCalled();
  });

  it("closing the panel keeps the mic while in the call", async () => {
    const ctx = setup();
    await joined(ctx);
    act(() => ctx.api().stopPreview());
    expect(devices.tracks[0].stop).not.toHaveBeenCalled();
  });
});

describe("useCall: push to talk and mute", () => {
  it("opens the mic only while T is held (not while typing), and on blur releases", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    window.localStorage.setItem(CALL_PREFS.pushToTalk, "1");
    const ctx = setup();
    await joined(ctx);
    const track = devices.tracks[0];
    expect(track.enabled).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    });
    expect(ctx.call().pttHeld).toBe(true);
    expect(track.enabled).toBe(true);
    // Repeats and modifiers are ignored
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "t", repeat: true }),
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "t" }));
    });
    expect(ctx.call().pttHeld).toBe(false);
    expect(track.enabled).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "T" }));
    });
    expect(ctx.call().pttHeld).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(ctx.call().pttHeld).toBe(false);
    // Typing in an input doesn't talk
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "t", bubbles: true }),
      );
    });
    expect(ctx.call().pttHeld).toBe(false);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "t", ctrlKey: true }),
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    });
    expect(ctx.call().pttHeld).toBe(false);
    input.remove();
    // The throttled state updates went out
    act(() => vi.advanceTimersByTime(500));
    expect(
      ctx.cmd.call.mock.calls.filter(([p]) => p.action === "state").length,
    ).toBeGreaterThan(0);
  });

  it("turning push to talk off goes back to the mute toggle and remembers it", async () => {
    const ctx = setup();
    await joined(ctx);
    act(() => ctx.api().setPushToTalk(true));
    expect(window.localStorage.getItem(CALL_PREFS.pushToTalk)).toBe("1");
    expect(devices.tracks[0].enabled).toBe(false);
    act(() => ctx.api().setPushToTalk(false));
    expect(window.localStorage.getItem(CALL_PREFS.pushToTalk)).toBeNull();
    expect(devices.tracks[0].enabled).toBe(true);
  });

  it("pttDown does nothing without push to talk; toggleMute returns the new state", async () => {
    const ctx = setup();
    await joined(ctx);
    act(() => ctx.api().pttDown());
    expect(ctx.call().pttHeld).toBe(false);
    let muted = false;
    act(() => {
      muted = ctx.api().toggleMute();
    });
    expect(muted).toBe(true);
    expect(devices.tracks[0].enabled).toBe(false);
  });
});

describe("useCall: ducking and audio", () => {
  it("lowers the movie while someone else talks, only with ducking on", async () => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "performance",
      ],
    });
    window.localStorage.setItem(CALL_PREFS.ducking, "1");
    const ctx = setup();
    await joined(ctx);
    act(() => transports[0].opts.events.onTrack(BOB, new FakeTrack("audio")));
    FakeAudioContext.instances[0].level = 0.2;
    act(() => vi.advanceTimersByTime(1000));
    expect(htmlDuck).toHaveBeenCalled();
    expect(htmlDuck.mock.calls.at(-1)![0]).toBeLessThan(1);
    expect(ytDuck).toHaveBeenCalled();
    expect(ctx.call().speaking).toContain(BOB);
    act(() => ctx.api().setDucking(false));
    expect(window.localStorage.getItem(CALL_PREFS.ducking)).toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(htmlDuck).toHaveBeenLastCalledWith(1);
    // Leaving restores full volume once and forgets the speaking
    act(() => ctx.api().leave());
    expect(ctx.call().speaking).toEqual([]);
  });

  it("asks to play blocked call audio, once, and the toast button plays it", async () => {
    FakeAudio.blocked = true;
    const ctx = setup();
    await joined(ctx);
    await act(async () => {
      transports[0].opts.events.onTrack(BOB, new FakeTrack("audio"));
      transports[0].opts.events.onTrack("carol", new FakeTrack("audio"));
    });
    await vi.waitFor(() => expect(ctx.call().audioBlocked).toBe(true));
    const blocked = toast.mock.calls.filter(
      ([m]) => m === "Your browser paused the call audio.",
    );
    expect(blocked).toHaveLength(1);
    FakeAudio.blocked = false;
    await act(async () => blocked[0][1].action.onClick());
    expect(ctx.call().audioBlocked).toBe(false);
  });

  it("levelOf reports a member's level and tilesHidden is remembered", async () => {
    const ctx = setup();
    expect(ctx.api().levelOf(BOB)).toBe(0);
    act(() => ctx.api().setTilesHidden(true));
    expect(ctx.call().tilesHidden).toBe(true);
    expect(window.localStorage.getItem(CALL_PREFS.tilesHidden)).toBe("1");
    act(() => ctx.api().setTilesHidden(false));
    expect(window.localStorage.getItem(CALL_PREFS.tilesHidden)).toBeNull();
  });
});

describe("useCall: moderation", () => {
  it("ignores moderation when not in the call", () => {
    const ctx = setup();
    act(() =>
      ctx.api().onModerated({ action: "mute", by: { id: BOB, name: "Bob" } }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("an owner turning our camera off stops it; nothing to do when it's already off", async () => {
    const ctx = setup({ nameMap: { [BOB]: "Bob" } } as any);
    await joined(ctx);
    act(() =>
      ctx.api().onModerated({ action: "camera", by: { id: BOB, name: "" } }),
    );
    expect(toast).not.toHaveBeenCalled();
    await act(() => ctx.api().setCamera(true));
    act(() =>
      ctx.api().onModerated({ action: "camera", by: { id: BOB, name: "" } }),
    );
    expect(toast).toHaveBeenLastCalledWith(
      "Bob turned off your camera.",
      expect.anything(),
    );
    await vi.waitFor(() => expect(ctx.call().camera).toBe(false));
  });

  it("names an unknown owner 'Someone'", async () => {
    const ctx = setup();
    await joined(ctx);
    act(() =>
      ctx.api().onModerated({ action: "remove", by: { id: "x", name: "" } }),
    );
    expect(toast).toHaveBeenLastCalledWith(
      "Someone removed you from the voice call.",
      expect.anything(),
    );
    expect(ctx.call().status).toBe("idle");
  });
});

describe("useCall: camera", () => {
  it("cancels a camera that's still opening when toggled again", async () => {
    const ctx = setup();
    await joined(ctx);
    let resolve!: (s: unknown) => void;
    devices.getUserMedia.mockImplementationOnce(
      () => new Promise<any>((r) => (resolve = r)),
    );
    let opening!: Promise<boolean>;
    act(() => {
      opening = ctx.api().toggleCamera();
    });
    expect(ctx.call().cameraBusy).toBe(true);
    await act(() => ctx.api().toggleCamera());
    const late = new FakeTrack("video");
    let on = true;
    await act(async () => {
      resolve({ getTracks: () => [late], getVideoTracks: () => [late] });
      on = await opening;
    });
    expect(on).toBe(false);
    expect(late.stop).toHaveBeenCalled();
    expect(ctx.call().camera).toBe(false);
  });

  it("retries after releasing the current camera when the new one is in use (phones)", async () => {
    const ctx = setup();
    await joined(ctx);
    await act(() => ctx.api().setCamera(true));
    const first = devices.tracks.find((t) => t.kind === "video")!;
    devices.getUserMedia.mockRejectedValueOnce({ name: "NotReadableError" });
    await act(() => ctx.api().setCameraDevice("cam-2"));
    expect(first.stop).toHaveBeenCalled();
    expect(ctx.call().camera).toBe(true);
    expect(window.localStorage.getItem(CALL_PREFS.camera)).toBe("cam-2");
  });

  it("turning the camera off when switching fails tells the room", async () => {
    const ctx = setup();
    await joined(ctx);
    await act(() => ctx.api().setCamera(true));
    ctx.cmd.call.mockClear();
    devices.getUserMedia
      .mockRejectedValueOnce({ name: "NotReadableError" })
      .mockRejectedValueOnce({ name: "NotReadableError" });
    await act(() => ctx.api().setCameraDevice("cam-2"));
    expect(ctx.call().camera).toBe(false);
    expect(ctx.call().cameraError).toBe("in-use");
    expect(ctx.cmd.call).toHaveBeenCalledWith({
      action: "state",
      camera: false,
    });
  });

  it("setCameraDevice only remembers when the camera is off or already that one", async () => {
    const ctx = setup();
    await act(() => ctx.api().setCameraDevice("cam-9"));
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(ctx.api().currentCameraId()).toBe("cam-9");
  });

  it("turns the camera off when it's unplugged or ends", async () => {
    const ctx = setup();
    await joined(ctx);
    await act(() => ctx.api().setCamera(true));
    expect(ctx.api().currentCameraId()).toBe("cam-1");
    // Still listed: stays on
    await act(() => ctx.api().checkCamera());
    expect(ctx.call().camera).toBe(true);
    devices.enumerateDevices.mockResolvedValueOnce([
      { kind: "videoinput", deviceId: "other", label: "Other" },
    ]);
    await act(() => ctx.api().checkCamera());
    expect(ctx.call().camera).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      "Camera disconnected. It's off now.",
      expect.anything(),
    );
    // An ended track is noticed too
    await act(() => ctx.api().setCamera(true));
    const cam = devices.tracks.filter((t) => t.kind === "video").at(-1)!;
    cam.readyState = "ended";
    await act(() => ctx.api().checkCamera());
    expect(ctx.call().camera).toBe(false);
    // And the track's own ended event
    await act(() => ctx.api().setCamera(true));
    const cam2 = devices.tracks.filter((t) => t.kind === "video").at(-1)!;
    await act(async () => cam2.onended?.());
    expect(ctx.call().camera).toBe(false);
    // Nothing to check without a camera
    await act(() => ctx.api().checkCamera());
  });

  it("devicechange checks the mic and camera while in the call", async () => {
    let onChange: (() => void) | undefined;
    const md = navigator.mediaDevices as any;
    md.addEventListener = (_t: string, fn: () => void) => (onChange = fn);
    md.removeEventListener = vi.fn();
    const ctx = setup();
    await joined(ctx);
    expect(onChange).toBeTypeOf("function");
    devices.enumerateDevices.mockClear();
    await act(async () => onChange!());
    expect(devices.enumerateDevices).toHaveBeenCalled();
    act(() => ctx.api().leave());
    expect(md.removeEventListener).toHaveBeenCalled();
  });

  it("switching to another camera while it's on replaces and stops the old one", async () => {
    const ctx = setup();
    await joined(ctx);
    await act(() => ctx.api().setCamera(true));
    const first = devices.tracks.find((t) => t.kind === "video")!;
    await act(() => ctx.api().setCameraDevice("cam-2"));
    expect(first.stop).toHaveBeenCalled();
    expect(ctx.call().camera).toBe(true);
    expect(transports[0].setLocalTrack).toHaveBeenLastCalledWith(
      "video",
      devices.tracks.at(-1),
    );
  });
});

describe("useCall: preview then join", () => {
  it("joins with the previewed mic (no second getUserMedia) and ignores join while busy", async () => {
    const ctx = setup();
    await act(() => ctx.api().startPreview());
    let first!: Promise<void>;
    act(() => {
      first = ctx.api().join();
    });
    // Busy: a second click does nothing
    await act(() => ctx.api().join());
    await act(() => first);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(transports).toHaveLength(1);
    // Closing the panel while joining keeps everything
    act(() => ctx.api().stopPreview());
    expect(devices.tracks[0].stop).not.toHaveBeenCalled();
  });

  it("a mic that ends after it was released is ignored", async () => {
    const ctx = setup();
    await act(() => ctx.api().startPreview());
    const track = devices.tracks[0];
    const onended = track.onended;
    act(() => ctx.api().stopPreview());
    await act(async () => onended?.());
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });
});
