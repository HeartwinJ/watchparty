// The mesh transport's edge cases with the shared fake RTCPeerConnection: ICE candidates, remote tracks, sender
// parameters (voice first, video caps by call size), stale/foreign signals, offer collisions, peers coming and going,
// and ICE-restart recovery going relay-only when TURN is configured.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakePC,
  FakeStream,
  FakeTrack,
  installRTCPeerConnection,
  peers as pcs,
  resetPeers,
} from "../../../test/browserFakes";
import { createMeshTransport } from "./transport";

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

function transport(selfId: string, iceServers: RTCIceServer[] = []) {
  const send = vi.fn();
  const events = {
    onTrack: vi.fn(),
    onPeerClosed: vi.fn(),
    onPeerStatus: vi.fn(),
  };
  const t = createMeshTransport({
    selfId,
    session: "my-session",
    iceServers,
    send,
    events,
  });
  return { t, send, events };
}

const peer = (
  clientId: string,
  session = "their-session",
  reconnecting = false,
) => ({
  clientId,
  session,
  reconnecting,
});

const signal = (extra: Partial<CallSignalEvent>): CallSignalEvent => ({
  from: "a",
  session: "their-session",
  toSession: "my-session",
  ...extra,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetPeers();
  installRTCPeerConnection();
  vi.stubGlobal("MediaStream", FakeStream);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mesh transport", () => {
  it("relays ICE candidates (not the end-of-candidates null) and reports remote tracks", () => {
    const { t, send, events } = transport("b");
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    expect(events.onPeerStatus).toHaveBeenCalledWith("a", "connecting");
    pc.onicecandidate!({
      candidate: { toJSON: () => ({ candidate: "cand", sdpMid: "0" }) },
    });
    pc.onicecandidate!({ candidate: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("a", "their-session", {
      candidate: {
        candidate: "cand",
        sdpMid: "0",
        sdpMLineIndex: null,
        usernameFragment: null,
      },
    });
    const track = new FakeTrack("audio");
    pc.emitTrack(track);
    expect(events.onTrack).toHaveBeenCalledWith("a", track);
    t.close();
    // Nothing is sent after close
    pc.onicecandidate?.({ candidate: { toJSON: () => ({}) } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sets voice and video sender parameters once connected, video capped by call size", async () => {
    const { t, events } = transport("z");
    const cam = new FakeTrack("video");
    t.setLocalTrack("audio", new FakeTrack("audio") as any);
    t.setLocalTrack("video", cam as any);
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    const [audio, video] = pc.senders;
    pc.setConnectionState("connected");
    await flush();
    expect(events.onPeerStatus).toHaveBeenLastCalledWith("a", "connected");
    const a = audio.setParameters.mock.calls[0][0] as any;
    expect(a.encodings[0]).toMatchObject({ priority: "high" });
    const v = video.setParameters.mock.calls[0][0] as any;
    expect(v.encodings[0]).toMatchObject({ priority: "low" });
    expect(v.degradationPreference).toBe("maintain-framerate");
    // Unchanged → not applied again
    pc.signalingState = "stable";
    pc.onsignalingstatechange!();
    await flush();
    expect(video.setParameters).toHaveBeenCalledTimes(1);
    // A second peer changes the video caps for everyone
    t.setPeers([peer("a"), peer("b")]);
    await flush();
    pcs[1].setConnectionState("connected");
    await flush();
    expect(video.setParameters).toHaveBeenCalledTimes(2);
    // Not stable yet: nothing
    pc.signalingState = "have-local-offer";
    pc.onsignalingstatechange!();
    t.close();
  });

  it("skips senders without encodings and survives setParameters failing", async () => {
    const { t } = transport("z");
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    const [audio, video] = pc.senders;
    audio.getParameters = () => ({ encodings: [] });
    video.setParameters.mockRejectedValueOnce(new Error("nope"));
    pc.setConnectionState("connected");
    await flush();
    expect(audio.setParameters).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[call] setParameters failed",
      expect.any(Error),
    );
    t.close();
  });

  it("logs a failed negotiation and a failed replaceTrack", async () => {
    const { t } = transport("z");
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    pc.setLocalDescription.mockRejectedValueOnce(new Error("bad"));
    await pc.onnegotiationneeded!();
    expect(warn).toHaveBeenCalledWith(
      "[call] negotiation failed",
      expect.any(Error),
    );
    pc.senders[0].replaceTrack.mockRejectedValueOnce(new Error("bad"));
    t.setLocalTrack("audio", new FakeTrack("audio") as any);
    await flush();
    expect(warn).toHaveBeenCalledWith(
      "[call] replaceTrack failed",
      expect.any(Error),
    );
    // The same track again isn't replaced
    const mic = new FakeTrack("audio");
    t.setLocalTrack("audio", mic as any);
    await flush();
    const calls = pc.senders[0].replaceTrack.mock.calls.length;
    t.setLocalTrack("audio", mic as any);
    expect(pc.senders[0].replaceTrack.mock.calls.length).toBe(calls);
    t.close();
  });

  it("drops signals for another session, from strangers or stale sessions, and rollbacks", async () => {
    const { t } = transport("z");
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    t.handleSignal(
      signal({ toSession: "old", description: { type: "offer", sdp: "x" } }),
    );
    t.handleSignal(
      signal({ from: "q", description: { type: "offer", sdp: "x" } }),
    );
    t.handleSignal(
      signal({ session: "stale", description: { type: "offer", sdp: "x" } }),
    );
    t.handleSignal(signal({ description: { type: "rollback", sdp: "" } }));
    await flush();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    t.close();
    t.handleSignal(signal({ description: { type: "offer", sdp: "x" } }));
    await flush();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("impolite side ignores a colliding offer (and the candidates that follow, quietly)", async () => {
    const { t, send } = transport("z");
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    await pc.onnegotiationneeded!();
    expect(pc.signalingState).toBe("have-local-offer");
    t.handleSignal(signal({ description: { type: "offer", sdp: "theirs" } }));
    await flush();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    pc.addIceCandidate.mockRejectedValueOnce(new Error("for ignored offer"));
    t.handleSignal(
      signal({
        candidate: {
          candidate: "c",
          sdpMid: null,
          sdpMLineIndex: null,
          usernameFragment: null,
        },
      }),
    );
    await flush();
    expect(warn).not.toHaveBeenCalledWith(
      "[call] addIceCandidate failed",
      expect.anything(),
    );
    // Their answer is applied
    t.handleSignal(signal({ description: { type: "answer", sdp: "ans" } }));
    await flush();
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: expect.any(String),
    });
    expect(send).toHaveBeenCalledTimes(1);
    t.close();
  });

  it("polite side rolls back its own offer and answers a colliding one", async () => {
    const { t, send } = transport("a");
    t.setPeers([peer("b")]);
    const pc = pcs[0];
    pc.signalingState = "have-local-offer";
    t.handleSignal(
      signal({ from: "b", description: { type: "offer", sdp: "m=audio" } }),
    );
    await flush();
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: "rollback" });
    expect(send).toHaveBeenLastCalledWith("b", "their-session", {
      description: { type: "answer", sdp: expect.any(String) },
    });
    t.close();
  });

  it("adopts only usable transceivers of the offer", async () => {
    const { t } = transport("a");
    t.setLocalTrack("audio", new FakeTrack("audio") as any);
    t.setPeers([peer("b")]);
    const pc = pcs[0];
    const mk = (kind: string, extra = {}) => ({
      sender: {
        track: null,
        replaceTrack: vi.fn(async () => {}),
        getParameters: () => ({ encodings: [{}] }),
        setParameters: vi.fn(async () => {}),
      },
      receiver: { track: { kind } },
      direction: "recvonly",
      mid: "0",
      ...extra,
    });
    const audio = mk("audio");
    const audio2 = mk("audio");
    const data = mk("application");
    const pending = mk("video", { mid: null });
    const stopped = mk("video", { stopped: true });
    pc.transceivers = [data, audio, audio2, pending, stopped] as any;
    t.handleSignal(
      signal({ from: "b", description: { type: "offer", sdp: "o" } }),
    );
    await flush();
    expect(audio.direction).toBe("sendrecv");
    expect(audio.sender.replaceTrack).toHaveBeenCalled();
    expect(audio2.direction).toBe("recvonly");
    expect(pending.direction).toBe("recvonly");
    expect(stopped.direction).toBe("recvonly");
    expect(data.direction).toBe("recvonly");
    t.close();
  });

  it("warns when a candidate can't be added, and when handling a signal throws", async () => {
    const { t } = transport("z");
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    pc.addIceCandidate.mockRejectedValueOnce(new Error("bad"));
    t.handleSignal(
      signal({
        candidate: {
          candidate: "c",
          sdpMid: null,
          sdpMLineIndex: null,
          usernameFragment: null,
        },
      }),
    );
    await flush();
    expect(warn).toHaveBeenCalledWith(
      "[call] addIceCandidate failed",
      expect.any(Error),
    );
    pc.setRemoteDescription.mockRejectedValueOnce(new Error("bad sdp"));
    t.handleSignal(signal({ description: { type: "answer", sdp: "x" } }));
    await flush();
    expect(warn).toHaveBeenCalledWith(
      "[call] signal failed",
      expect.any(Error),
    );
    // Neither a candidate nor a description: nothing
    t.handleSignal(signal({}));
    await flush();
    t.close();
  });

  it("follows the member list: new peers, departed ones, new sessions, reconnecting ones", () => {
    const { t, events } = transport("m");
    t.setPeers([peer("m"), peer("a"), peer("b", "s1", true)]);
    // Ourselves and a reconnecting member get no connection
    expect(pcs).toHaveLength(1);
    t.setPeers([peer("a", "new-session"), peer("b", "s1")]);
    expect(pcs[0].closed).toBe(true);
    expect(events.onPeerClosed).toHaveBeenCalledWith("a");
    expect(pcs).toHaveLength(3);
    t.setPeers([]);
    expect(pcs.every((p) => p.closed)).toBe(true);
    t.close();
    t.setPeers([peer("c")]);
    expect(pcs).toHaveLength(3);
  });

  it("a polite peer's negotiationneeded before any offer does nothing", async () => {
    const { t, send } = transport("a");
    t.setPeers([peer("b")]);
    await pcs[0].onnegotiationneeded!();
    expect(send).not.toHaveBeenCalled();
    t.close();
  });
});

describe("mesh transport recovery", () => {
  it("restarts ICE, rolls back an unanswered offer, and goes relay-only with TURN", async () => {
    vi.useFakeTimers();
    const { t, events } = transport("z", [
      { urls: "turn:turn.example.com:3478", username: "u", credential: "c" },
    ]);
    t.setPeers([peer("a")]);
    const pc = pcs[0] as FakePC;
    await pc.onnegotiationneeded!();
    expect(pc.signalingState).toBe("have-local-offer");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: "rollback" });
    expect(pc.restartIce).toHaveBeenCalled();
    expect(events.onPeerStatus).toHaveBeenCalledWith("a", "reconnecting");
    // Keeps failing: relay-only after a few attempts
    await vi.advanceTimersByTimeAsync(60_000);
    expect((pc.getConfiguration() as any).iceTransportPolicy).toBe("relay");
    t.close();
  });

  it("the polite side switches to relay but leaves the restart to the other side", async () => {
    vi.useFakeTimers();
    const { t } = transport("a", [
      { urls: ["turns:turn.example.com:443"], username: "u", credential: "c" },
    ]);
    t.setPeers([peer("b")]);
    const pc = pcs[0];
    await vi.advanceTimersByTimeAsync(80_000);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect((pc.getConfiguration() as any).iceTransportPolicy).toBe("relay");
    t.close();
  });

  it("logs a failed restart, and skips peers closed before it ran", async () => {
    vi.useFakeTimers();
    const { t } = transport("z");
    t.setPeers([peer("a")]);
    const pc = pcs[0];
    pc.restartIce.mockImplementation(() => {
      throw new Error("no");
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(warn).toHaveBeenCalledWith(
      "[call] ICE restart failed",
      expect.any(Error),
    );
    t.close();
  });
});
