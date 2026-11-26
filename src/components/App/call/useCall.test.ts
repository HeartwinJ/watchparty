// The voice call through the room hooks: a fake socket, a fake mic and a fake RTCPeerConnection.
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
  kind = "audio";
  enabled = true;
  readyState = "live";
  label = "Desk mic";
  onended: (() => void) | null = null;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = () => ({ deviceId: "mic-1" });
}
class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks;
  addTrack = (t: FakeTrack) => this.tracks.push(t);
  removeTrack = (t: FakeTrack) => {
    this.tracks = this.tracks.filter((x) => x !== t);
  };
}
const peers: FakePC[] = [];
class FakePC {
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
  addTrack() {
    return { replaceTrack: async () => {} };
  }
  getConfiguration() {
    return {};
  }
  close() {
    this.closed = true;
  }
}
let tracks: FakeTrack[] = [];
const getUserMedia = vi.fn(async (_c: unknown) => {
  const t = new FakeTrack();
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
  joinedAt: 1,
  reconnecting: false,
});
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  sockets.length = 0;
  peers.length = 0;
  tracks = [];
  getUserMedia.mockClear();
  window.localStorage.clear();
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
      { action: "join", session, muted: false },
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
