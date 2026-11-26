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

describe("mesh transport: video only to peers showing the tiles", () => {
  // "z" offers to both (it owns the senders from the start)
  const member = (clientId: string, wantsVideo?: boolean) => ({
    ...peer(clientId),
    ...(wantsVideo === undefined ? {} : { wantsVideo }),
  });
  const videoSender = (pc: FakePC) => pc.transceivers[1].sender;
  const audioSender = (pc: FakePC) => pc.transceivers[0].sender;
  const connect = async (pc: FakePC) => {
    pc.connectionState = "connected";
    (pc.onconnectionstatechange as () => void)();
    await flush();
  };
  const lastVideoBitrate = (pc: FakePC) => {
    const calls = videoSender(pc).setParameters.mock.calls as unknown as [
      { encodings: { maxBitrate?: number }[] },
    ][];
    return calls[calls.length - 1]?.[0].encodings[0].maxBitrate;
  };

  it("sends the camera only to members that want it; voice goes to everyone", () => {
    const { t } = transport("z");
    t.setLocalTrack("audio", mic as MediaStreamTrack);
    t.setLocalTrack("video", cam as MediaStreamTrack);
    // An older client (no wantsVideo) still gets video
    t.setPeers([member("a", true), member("c", false), member("d")]);
    const [pa, pc, pd] = pcs;
    expect(videoSender(pa).track).toBe(cam);
    expect(videoSender(pc).track).toBeNull();
    expect(videoSender(pd).track).toBe(cam);
    for (const p of pcs) {
      expect(audioSender(p).track).toBe(mic);
    }
    t.close();
  });

  it("replaceTrack(null) only for the peer that hides the tiles, and resumes when it shows them again", async () => {
    const { t } = transport("z");
    t.setLocalTrack("audio", mic as MediaStreamTrack);
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setPeers([member("a", true), member("c", true)]);
    const [pa, pc] = pcs;
    t.setPeers([member("a", true), member("c", false)]);
    await flush();
    expect(videoSender(pc).replaceTrack.mock.calls).toEqual([[null]]);
    expect(videoSender(pa).replaceTrack).not.toHaveBeenCalled();
    expect(audioSender(pc).replaceTrack).not.toHaveBeenCalled();
    // The same state again changes nothing
    t.setPeers([member("a", true), member("c", false)]);
    expect(videoSender(pc).replaceTrack).toHaveBeenCalledTimes(1);

    // A camera switch while c hides the tiles: only a gets the new camera
    const cam2 = { kind: "video", getSettings: () => ({}) } as FakeTrack;
    t.setLocalTrack("video", cam2 as MediaStreamTrack);
    await flush();
    expect(videoSender(pa).replaceTrack.mock.calls).toEqual([[cam2]]);
    expect(videoSender(pc).replaceTrack).toHaveBeenCalledTimes(1);

    // c shows the tiles again: the current camera resumes, without renegotiating
    t.setPeers([member("a", true), member("c", true)]);
    await flush();
    expect(videoSender(pc).replaceTrack.mock.calls).toEqual([[null], [cam2]]);
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.addTrack).not.toHaveBeenCalled();

    // Camera off while c hides: nothing to stop for c, a stops
    t.setPeers([member("a", true), member("c", false)]);
    t.setLocalTrack("video", null);
    await flush();
    expect(videoSender(pa).track).toBeNull();
    expect(videoSender(pc).replaceTrack.mock.calls).toEqual([
      [null],
      [cam2],
      [null],
    ]);
    t.close();
  });

  it("a quick hide/show doesn't lose the camera while replaceTrack is still pending", async () => {
    const { t } = transport("z");
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setPeers([member("a", true)]);
    const sender = videoSender(pcs[0]);
    // replaceTrack resolves later (sender.track only changes then)
    const pending: (() => void)[] = [];
    sender.replaceTrack.mockImplementation(
      (tr: FakeTrack | null) =>
        new Promise<void>((resolve) =>
          pending.push(() => {
            sender.track = tr;
            resolve();
          }),
        ),
    );
    t.setPeers([member("a", false)]);
    t.setPeers([member("a", true)]);
    expect(sender.replaceTrack.mock.calls).toEqual([[null], [cam]]);
    pending.forEach((fn) => fn());
    await flush();
    expect(sender.track).toBe(cam);
    t.close();
  });

  it("retries after a failed replaceTrack", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t } = transport("z");
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setPeers([member("a", true)]);
    const sender = videoSender(pcs[0]);
    sender.replaceTrack.mockRejectedValueOnce(new Error("bad"));
    t.setPeers([member("a", false)]);
    await flush();
    expect(warn).toHaveBeenCalled();
    // The sender still has the camera; the next change goes through
    t.setLocalTrack("video", cam as MediaStreamTrack);
    expect(sender.replaceTrack.mock.calls).toEqual([[null], [null]]);
    warn.mockRestore();
    t.close();
  });

  it("a peer created while it hides the tiles starts without our camera", () => {
    const { t } = transport("z");
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setPeers([member("a", false)]);
    expect(videoSender(pcs[0]).track).toBeNull();
    t.close();
  });

  it("the answering side follows wantsVideo on the senders it adopts", async () => {
    const { t } = transport("a");
    t.setLocalTrack("audio", mic as MediaStreamTrack);
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setPeers([member("b", false)]);
    t.handleSignal({
      from: "b",
      session: "their-session",
      toSession: "my-session",
      description: { type: "offer", sdp: "m=audio sendrecv\nm=video sendrecv" },
    });
    await flush();
    const [pc] = pcs;
    expect(pc.transceivers.map((x) => x.sender.track)).toEqual([mic, null]);
    t.setPeers([member("b", true)]);
    await flush();
    expect(videoSender(pc).track).toBe(cam);
    t.close();
  });

  it("video caps count only the peers that receive our camera", async () => {
    const { t } = transport("z");
    t.setLocalTrack("video", cam as MediaStreamTrack);
    t.setPeers([member("a", true), member("c", true)]);
    const [pa, pc] = pcs;
    await connect(pa);
    await connect(pc);
    // Two receivers: 700 kbps each
    expect(lastVideoBitrate(pa)).toBe(700_000);
    // c hides the tiles: a is the only receiver, so it gets the one-peer caps
    t.setPeers([member("a", true), member("c", false)]);
    await flush();
    expect(lastVideoBitrate(pa)).toBe(1_200_000);
    t.setPeers([member("a", true), member("c", true)]);
    await flush();
    expect(lastVideoBitrate(pa)).toBe(700_000);
    t.close();
  });
});
