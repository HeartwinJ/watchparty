// The voice call through the room hooks: a fake socket, a fake mic and camera, and a fake RTCPeerConnection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

type Listener = (...args: any[]) => void;

class FakeSocket {
  listeners = new Map<string, Listener[]>();
  emitted: [string, ...unknown[]][] = [];
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push([event, ...args]);
    return this;
  }
  disconnect() {
    return this;
  }
  receive(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
  emits(event: string) {
    return this.emitted.filter(([e]) => e === event).map(([, ...a]) => a);
  }
}

const sockets: FakeSocket[] = [];
vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }),
}));
vi.mock("../../../utils/generateName", () => ({
  generateName: async () => "Sam",
}));
vi.mock("../../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/api")>()),
  apiFetch: vi.fn(async () => new Response("")),
}));
vi.mock("../../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/utils")>()),
  testAutoplay: async () => true,
}));
vi.mock("../../../utils/iceServers", () => ({
  getIceServers: async () => [{ urls: "stun:stun.example.com:3478" }],
}));

// --- Fake media ---
class FakeTrack {
  kind: string;
  enabled = true;
  readyState = "live";
  muted = false;
  label: string;
  contentHint = "";
  onended: (() => void) | null = null;
  constructor(kind = "audio") {
    this.kind = kind;
    this.label = kind === "video" ? "Desk cam" : "Desk mic";
  }
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = () =>
    this.kind === "video"
      ? { deviceId: "cam-1", height: 720 }
      : { deviceId: "mic-1" };
  addEventListener() {}
  removeEventListener() {}
}
class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks.filter((t) => t.kind === "audio");
  getVideoTracks = () => this.tracks.filter((t) => t.kind === "video");
  addTrack = (t: FakeTrack) => this.tracks.push(t);
  removeTrack = (t: FakeTrack) => {
    this.tracks = this.tracks.filter((x) => x !== t);
  };
}
const peers: FakePC[] = [];
const fakeSender = (kind: string, track: FakeTrack | null) => {
  const sender = {
    kind,
    track,
    replaceTrack: vi.fn(async (t: FakeTrack | null) => {
      sender.track = t;
    }),
    getParameters: () => ({ encodings: [{}] }),
    setParameters: vi.fn(async (_p: any) => {}),
  };
  return sender;
};
class FakePC {
  senders: ReturnType<typeof fakeSender>[] = [];
  onsignalingstatechange: unknown = null;
  closed = false;
  onnegotiationneeded: unknown = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  connectionState = "new";
  signalingState = "stable";
  constructor() {
    peers.push(this);
  }
  addTransceiver(trackOrKind: FakeTrack | string) {
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const sender = fakeSender(track?.kind ?? (trackOrKind as string), track);
    this.senders.push(sender);
    return { sender };
  }
  getConfiguration() {
    return {};
  }
  close() {
    this.closed = true;
  }
}
let tracks: FakeTrack[] = [];
const getUserMedia = vi.fn(async (c: unknown) => {
  const t = new FakeTrack((c as { video?: unknown }).video ? "video" : "audio");
  tracks.push(t);
  return new FakeStream([t]);
});
vi.stubGlobal("MediaStream", FakeStream);
vi.stubGlobal("RTCPeerConnection", FakePC);
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: (c: unknown) => getUserMedia(c),
    enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk mic" },
      { kind: "videoinput", deviceId: "cam-1", label: "Desk cam" },
    ],
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

const { useRoom } = await import("../hooks/useRoom");
const { AuthContext } = await import("../../AuthGate/AuthGate");
const React = await import("react");

async function setup() {
  const hook = renderHook(() => useRoom("call-room"), {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        AuthContext.Provider,
        {
          value: {
            authRequired: true,
            role: "owner",
            logout: async () => {},
            roomAccessLost: () => {},
          },
        },
        children,
      ),
  });
  await waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  await act(async () => socket.receive("connect"));
  return { ...hook, socket };
}

const member = (clientId: string, session: string, muted = false) => ({
  clientId,
  session,
  muted,
  camera: false,
  joinedAt: 1,
  reconnecting: false,
});
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ME = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

beforeEach(() => {
  sockets.length = 0;
  peers.length = 0;
  tracks = [];
  getUserMedia.mockClear();
  window.localStorage.clear();
  // Sort after BOB, so we're the side that offers and creates the senders
  window.localStorage.setItem("watchparty-clientid", ME);
  window.sessionStorage.clear();
  document.body.innerHTML = '<video id="leftVideo"></video>';
});
afterEach(() => cleanup());

describe("voice call", () => {
  it("stores REC:callState", async () => {
    const { result, socket } = await setup();
    act(() =>
      socket.receive("REC:callState", {
        members: [member(BOB, "bobsession1")],
      }),
    );
    expect(result.current.state.call.members).toHaveLength(1);
    expect(result.current.state.call.status).toBe("idle");
  });

  it("joins muted while the video plays, then mutes/unmutes with the track", async () => {
    const { result, socket } = await setup();
    act(() =>
      result.current.store.set({
        roomMedia: "https://example.com/a.mp4",
        roomPaused: false,
      }),
    );
    await act(() => result.current.call.join());
    const [[join]] = socket.emits("CMD:call") as [[any]];
    expect(join).toMatchObject({ action: "join", muted: true });
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    expect(tracks[0].enabled).toBe(false);
    expect(result.current.state.call.status).toBe("joining");

    const me = result.current.clientId;
    act(() =>
      socket.receive("REC:callState", {
        members: [member(BOB, "bobsession1"), member(me, join.session, true)],
      }),
    );
    expect(result.current.state.call.status).toBe("joined");
    // One peer connection, to Bob
    expect(peers).toHaveLength(1);

    // Later play/pause doesn't touch it; M (toggleMute) does
    act(() => result.current.store.set({ roomPaused: true }));
    expect(result.current.state.call.muted).toBe(true);
    act(() => void result.current.call.toggleMute());
    expect(tracks[0].enabled).toBe(true);
    expect(socket.emits("CMD:call").at(-1)).toEqual([
      { action: "state", muted: false },
    ]);

    // Bob leaves: his connection closes
    act(() =>
      socket.receive("REC:callState", {
        members: [member(me, join.session)],
      }),
    );
    expect(peers[0].closed).toBe(true);

    // Leave: tells the server, stops the mic
    act(() => result.current.call.leave());
    expect(socket.emits("CMD:call").at(-1)).toEqual([{ action: "leave" }]);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(result.current.state.call.status).toBe("idle");
  });

  it("joins unmuted when paused or nothing is playing", async () => {
    const { result, socket } = await setup();
    await act(() => result.current.call.join());
    expect(socket.emits("CMD:call")[0][0]).toMatchObject({
      action: "join",
      muted: false,
    });
    expect(tracks[0].enabled).toBe(true);
  });

  it("shows why the mic couldn't start and doesn't join", async () => {
    const { result, socket } = await setup();
    getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    await act(() => result.current.call.join());
    expect(result.current.state.call.micError).toBe("blocked");
    expect(result.current.state.call.busy).toBe(false);
    expect(socket.emits("CMD:call")).toEqual([]);
  });

  it("rejoins with the same session after a socket reconnect", async () => {
    const { result, socket } = await setup();
    await act(() => result.current.call.join());
    const session = (socket.emits("CMD:call")[0][0] as { session: string })
      .session;
    const me = result.current.clientId;
    act(() =>
      socket.receive("REC:callState", { members: [member(me, session)] }),
    );
    act(() => socket.receive("disconnect", "transport close"));
    expect(result.current.state.call.status).toBe("joined");
    await act(async () => socket.receive("connect"));
    // The server restarted and forgot us: we stay in "joining" until it lists us again
    act(() => socket.receive("REC:callState", { members: [] }));
    expect(result.current.state.call.status).toBe("joining");
    expect(socket.emits("CMD:call").at(-1)).toEqual([
      {
        action: "join",
        session,
        muted: false,
        camera: false,
        wantsVideo: true,
      },
    ]);
    // Reload marker for this tab
    expect(window.sessionStorage.getItem("wp-call:call-room")).toBe(
      '{"muted":false}',
    );
  });

  it("follows an owner's mute request and removal", async () => {
    const { result, socket } = await setup();
    await act(() => result.current.call.join());
    const session = (socket.emits("CMD:call")[0][0] as { session: string })
      .session;
    const me = result.current.clientId;
    act(() =>
      socket.receive("REC:callState", { members: [member(me, session)] }),
    );
    act(() =>
      socket.receive("REC:callModerated", {
        action: "mute",
        by: { id: BOB, name: "Bob" },
      }),
    );
    expect(result.current.state.call.muted).toBe(true);
    expect(tracks[0].enabled).toBe(false);
    act(() =>
      socket.receive("REC:callModerated", {
        action: "remove",
        by: { id: BOB, name: "Bob" },
      }),
    );
    expect(result.current.state.call.status).toBe("idle");
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(window.sessionStorage.getItem("wp-call:call-room")).toBeNull();
  });

  it("sends owner moderation", async () => {
    const { result, socket } = await setup();
    act(() => result.current.call.moderate(BOB, "remove"));
    expect(socket.emits("CMD:callModerate")).toEqual([
      [{ action: "remove", clientId: BOB }],
    ]);
  });
});

describe("camera", () => {
  const blocked = () =>
    Object.assign(new Error("denied"), { name: "NotAllowedError" });

  it("turns on and off in the call by replacing the track (no new sender), stopping the camera", async () => {
    const { result, socket } = await setup();
    await act(() => result.current.call.join());
    const [[join]] = socket.emits("CMD:call") as [[any]];
    // Off by default
    expect(join.camera).toBe(false);
    const me = result.current.clientId;
    act(() =>
      socket.receive("REC:callState", {
        members: [member(BOB, "bobsession1"), member(me, join.session)],
      }),
    );
    const pc = peers[0];
    // An audio and a video sender from the start (the video one sends nothing yet)
    expect(pc.senders.map((s) => [s.kind, s.track?.kind ?? null])).toEqual([
      ["audio", "audio"],
      ["video", null],
    ]);

    let on: boolean | undefined;
    await act(async () => {
      on = await result.current.call.toggleCamera();
    });
    expect(on).toBe(true);
    expect(getUserMedia.mock.calls.at(-1)![0]).toMatchObject({
      audio: false,
      video: { height: { ideal: 720 } },
    });
    const cam = tracks.at(-1)!;
    expect(cam.kind).toBe("video");
    // Camera on: the video sender gets the track (no new sender, no renegotiation)
    expect(pc.senders).toHaveLength(2);
    expect(pc.senders[1].replaceTrack).toHaveBeenLastCalledWith(cam);
    expect(socket.emits("CMD:call").at(-1)).toEqual([
      { action: "state", camera: true },
    ]);
    expect(result.current.state.call.camera).toBe(true);
    expect(result.current.call.video.getSnapshot().local).not.toBeNull();

    // Capped for one peer, low priority, keeps the frame rate; audio gets high priority
    const video = pc.senders[1];
    await waitFor(() => expect(video.setParameters).toHaveBeenCalled());
    const params = video.setParameters.mock.calls.at(-1)![0];
    expect(params.encodings[0]).toMatchObject({
      maxBitrate: 1_200_000,
      scaleResolutionDownBy: 1,
      priority: "low",
    });
    expect(params.degradationPreference).toBe("maintain-framerate");
    await waitFor(() =>
      expect(pc.senders[0].setParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          encodings: [expect.objectContaining({ priority: "high" })],
        }),
      ),
    );

    // Off: the camera stops (light off), the sender sends nothing, no new sender
    await act(() => result.current.call.toggleCamera());
    expect(cam.stop).toHaveBeenCalled();
    expect(video.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(socket.emits("CMD:call").at(-1)).toEqual([
      { action: "state", camera: false },
    ]);
    expect(result.current.call.video.getSnapshot().local).toBeNull();

    // On again: same sender, new track
    await act(() => result.current.call.toggleCamera());
    expect(pc.senders).toHaveLength(2);
    expect(video.replaceTrack).toHaveBeenLastCalledWith(tracks.at(-1));

    // An owner asks us to turn it off
    act(() =>
      socket.receive("REC:callModerated", {
        action: "camera",
        by: { id: BOB, name: "Bob" },
      }),
    );
    await waitFor(() => expect(result.current.state.call.camera).toBe(false));
    expect(tracks.at(-1)!.stop).toHaveBeenCalled();

    // Leaving with the camera on stops it too
    await act(() => result.current.call.toggleCamera());
    act(() => result.current.call.leave());
    expect(tracks.at(-1)!.stop).toHaveBeenCalled();
    expect(result.current.state.call.camera).toBe(false);
  });

  it("joins with the camera on after the preview, and sends video from the first offer", async () => {
    const { result, socket } = await setup();
    await act(async () => void (await result.current.call.setCamera(true)));
    expect(result.current.state.call.camera).toBe(true);
    // Not in the call yet: nothing sent
    expect(socket.emits("CMD:call")).toEqual([]);
    await act(() => result.current.call.join());
    const [[join]] = socket.emits("CMD:call") as [[any]];
    expect(join.camera).toBe(true);
    const me = result.current.clientId;
    act(() =>
      socket.receive("REC:callState", {
        members: [member(BOB, "bobsession1"), member(me, join.session)],
      }),
    );
    // The camera's track is on the video sender from the first offer
    expect(peers[0].senders.map((s) => s.track?.kind)).toEqual([
      "audio",
      "video",
    ]);
  });

  it("joins with audio when the camera can't start, and says why", async () => {
    const { result, socket } = await setup();
    getUserMedia.mockImplementation(async (c: unknown) => {
      if ((c as { video?: unknown }).video) {
        throw blocked();
      }
      const t = new FakeTrack("audio");
      tracks.push(t);
      return new FakeStream([t]);
    });
    try {
      let on: boolean | undefined;
      await act(async () => {
        on = await result.current.call.setCamera(true);
      });
      expect(on).toBe(false);
      expect(result.current.state.call.cameraError).toBe("blocked");
      expect(result.current.state.call.camera).toBe(false);
      await act(() => result.current.call.join());
      expect(socket.emits("CMD:call")[0][0]).toMatchObject({
        action: "join",
        camera: false,
      });
      expect(result.current.state.call.status).toBe("joining");
      // V in the call: still can't, still in the call
      await act(async () => void (await result.current.call.toggleCamera()));
      expect(result.current.state.call.status).toBe("joining");
      expect(
        socket.emits("CMD:call").filter(([c]: any) => c.camera === true),
      ).toEqual([]);
    } finally {
      getUserMedia.mockReset();
      getUserMedia.mockImplementation(async (c: unknown) => {
        const t = new FakeTrack(
          (c as { video?: unknown }).video ? "video" : "audio",
        );
        tracks.push(t);
        return new FakeStream([t]);
      });
    }
  });

  it("closing the pre-join panel turns the preview camera off", async () => {
    const { result } = await setup();
    await act(() => result.current.call.startPreview());
    await act(async () => void (await result.current.call.setCamera(true)));
    const cam = tracks.find((t) => t.kind === "video")!;
    act(() => result.current.call.stopPreview());
    expect(cam.stop).toHaveBeenCalled();
    expect(result.current.state.call.camera).toBe(false);
  });

  it("remembers the chosen camera on this device", async () => {
    const { result } = await setup();
    await act(() => result.current.call.setCameraDevice("cam-2"));
    expect(window.localStorage.getItem("wp-call-camera")).toBe("cam-2");
    await act(async () => void (await result.current.call.setCamera(true)));
    expect(getUserMedia.mock.calls.at(-1)![0]).toMatchObject({
      video: { deviceId: { exact: "cam-2" } },
    });
  });
});
