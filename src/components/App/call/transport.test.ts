// The mesh transport's negotiation roles with a fake RTCPeerConnection. Regression: both sides used to addTrack and
// offer at once; Chrome then lost connections whose colliding offer had a video m-line (rolled back, no ICE
// candidates for the answer, remote video stuck muted), so camera video never showed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMeshTransport } from "./transport";

type Kind = "audio" | "video";
interface FakeTrack {
  kind: Kind;
  getSettings?: () => { height?: number };
}

const fakeSender = (track: FakeTrack | null) => {
  const sender = {
    track,
    replaceTrack: vi.fn(async (t: FakeTrack | null) => {
      sender.track = t;
    }),
    getParameters: () => ({ encodings: [{}] }),
    setParameters: vi.fn(async () => {}),
  };
  return sender;
};

class FakePC {
  transceivers: {
    mid: string | null;
    direction: string;
    receiver: { track: { kind: Kind } };
    sender: ReturnType<typeof fakeSender>;
  }[] = [];
  signalingState = "stable";
  connectionState = "new";
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  onsignalingstatechange: unknown = null;
  restartIce = vi.fn();
  addTrack = vi.fn();
  constructor() {
    pcs.push(this);
  }
  addTransceiver(trackOrKind: FakeTrack | Kind, init: { direction: string }) {
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const kind = typeof trackOrKind === "string" ? trackOrKind : track!.kind;
    const t = {
      mid: null,
      direction: init.direction,
      receiver: { track: { kind } },
      sender: fakeSender(track),
    };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  private sdp() {
    return this.transceivers
      .map((t) => `m=${t.receiver.track.kind} ${t.direction}`)
      .join("\n");
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === "offer") {
      // Each m-line gets a transceiver (recvonly until we decide to send)
      d.sdp.split("\n").forEach((line, i) => {
        const kind = /^m=(audio|video)/.exec(line)?.[1] as Kind | undefined;
        if (kind && !this.transceivers[i]) {
          this.transceivers.push({
            mid: String(i),
            direction: "recvonly",
            receiver: { track: { kind } },
            sender: fakeSender(null),
          });
        }
      });
      this.signalingState = "have-remote-offer";
    } else {
      this.transceivers.forEach((t, i) => (t.mid = String(i)));
      this.signalingState = "stable";
    }
  }
  async setLocalDescription(d?: { type: string }) {
    if (d?.type === "rollback") {
      this.signalingState = "stable";
      this.localDescription = null;
    } else if (this.signalingState === "have-remote-offer") {
      this.localDescription = { type: "answer", sdp: this.sdp() };
      this.signalingState = "stable";
    } else {
      this.localDescription = { type: "offer", sdp: this.sdp() };
      this.signalingState = "have-local-offer";
    }
  }
  getConfiguration() {
    return {};
  }
  setConfiguration() {}
  close() {}
}
class FakeStream {
  tracks: FakeTrack[] = [];
  getTracks = () => this.tracks;
  addTrack = (t: FakeTrack) => this.tracks.push(t);
  removeTrack = (t: FakeTrack) => {
    this.tracks = this.tracks.filter((x) => x !== t);
  };
}

let pcs: FakePC[] = [];
const mic = { kind: "audio" } as FakeTrack;
const cam = {
  kind: "video",
  getSettings: () => ({ height: 720 }),
} as FakeTrack;

function transport(selfId: string) {
  const send = vi.fn();
  const t = createMeshTransport({
    selfId,
    session: "my-session",
    iceServers: [],
    send,
    events: { onTrack: vi.fn(), onPeerClosed: vi.fn(), onPeerStatus: vi.fn() },
  });
  return { t, send };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  pcs = [];
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// "b" > "a": b is the impolite side, which makes the offers
const peer = (clientId: string) => ({
  clientId,
  session: "their-session",
  reconnecting: false,
});

describe("mesh transport negotiation", () => {
  it("the offering side has an audio and a video sender from the start; the camera is only replaceTrack", async () => {
    const { t, send } = transport("b");
    t.setLocalTrack("audio", mic as MediaStreamTrack);
    t.setLocalTrack("video", null);
    t.setPeers([peer("a")]);
    const [pc] = pcs;
    expect(
      pc.transceivers.map((x) => [
        x.receiver.track.kind,
        x.direction,
        x.sender.track,
      ]),
    ).toEqual([
      ["audio", "sendrecv", mic],
      ["video", "sendrecv", null],
    ]);
    await pc.onnegotiationneeded!();
    expect(send).toHaveBeenCalledWith("a", "their-session", {
      description: { type: "offer", sdp: "m=audio sendrecv\nm=video sendrecv" },
    });

    // Camera on and off: same sender, no new transceiver (no renegotiation)
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setLocalTrack("video", null);
    t.setLocalTrack("video", cam as MediaStreamTrack);
    const video = pc.transceivers[1].sender;
    expect(video.replaceTrack.mock.calls).toEqual([[cam], [null], [cam]]);
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.addTrack).not.toHaveBeenCalled();
    t.close();
  });

  it("the answering side never offers first and answers with the offer's transceivers", async () => {
    const { t, send } = transport("a");
    t.setLocalTrack("audio", mic as MediaStreamTrack);
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setPeers([peer("b")]);
    const [pc] = pcs;
    // Nothing of its own, so no colliding offer
    expect(pc.transceivers).toEqual([]);
    await pc.onnegotiationneeded!();
    expect(send).not.toHaveBeenCalled();

    t.handleSignal({
      from: "b",
      session: "their-session",
      toSession: "my-session",
      description: { type: "offer", sdp: "m=audio sendrecv\nm=video sendrecv" },
    });
    await flush();
    expect(pc.transceivers.map((x) => [x.direction, x.sender.track])).toEqual([
      ["sendrecv", mic],
      ["sendrecv", cam],
    ]);
    expect(send).toHaveBeenCalledWith("b", "their-session", {
      description: {
        type: "answer",
        sdp: "m=audio sendrecv\nm=video sendrecv",
      },
    });

    // Later camera changes go to the adopted sender
    t.setLocalTrack("video", null);
    expect(pc.transceivers[1].sender.replaceTrack).toHaveBeenLastCalledWith(
      null,
    );
    t.close();
  });

  it("only the offering side restarts ICE", async () => {
    vi.useFakeTimers();
    const offering = transport("b");
    const answering = transport("a");
    offering.t.setPeers([peer("a")]);
    answering.t.setPeers([peer("b")]);
    const [offerPc, answerPc] = pcs;
    // Never connects: the 10 s grace runs out
    await vi.advanceTimersByTimeAsync(12_000);
    expect(offerPc.restartIce).toHaveBeenCalled();
    expect(answerPc.restartIce).not.toHaveBeenCalled();
    offering.t.close();
    answering.t.close();
  });
});
