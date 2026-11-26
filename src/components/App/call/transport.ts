// How call media gets between members. `CallTransport` is the seam: today a P2P full mesh (one RTCPeerConnection
// per other member, fine for < 5 people); an SFU (e.g. Cloudflare Realtime) could implement the same interface.
import { stripExtmapAllowMixed } from "../logic/sdp";
import {
  hasTurn,
  isPolite,
  offerDecision,
  PeerRecovery,
  type PeerStatus,
} from "./negotiation";
import { tuneVoiceSdp, VOICE_MAX_BITRATE } from "./sdp";

export type CallMediaKind = "audio" | "video";

export interface CallPeerInfo {
  clientId: string;
  session: string;
  /** Their socket is reconnecting: keep an existing connection, but don't start a new one (they can't signal) */
  reconnecting: boolean;
}

export interface CallTransportEvents {
  /** A remote track arrived (audio now; video in a later version) */
  onTrack: (peerId: string, track: MediaStreamTrack) => void;
  /** A peer connection was closed (member left, or a new session replaced it) */
  onPeerClosed: (peerId: string) => void;
  onPeerStatus: (peerId: string, status: PeerStatus) => void;
}

export interface CallTransport {
  /** Sends `track` (or nothing, with null) to everyone. Switching devices replaces the track, no renegotiation. */
  setLocalTrack: (kind: CallMediaKind, track: MediaStreamTrack | null) => void;
  /** The other call members; connects to new ones, drops departed ones */
  setPeers: (peers: CallPeerInfo[]) => void;
  /** A REC:callSignal for us */
  handleSignal: (signal: CallSignalEvent) => void;
  close: () => void;
}

export interface MeshTransportOptions {
  selfId: string;
  session: string;
  iceServers: RTCIceServer[];
  /** Relay a signal through the server (CMD:callSignal) */
  send: (to: string, toSession: string, payload: CallSignalPayload) => void;
  events: CallTransportEvents;
}

interface MeshPeer {
  id: string;
  session: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  /** Signals are handled one at a time, in order */
  queue: Promise<void>;
  recovery: PeerRecovery;
  senders: Map<CallMediaKind, RTCRtpSender>;
  status: PeerStatus;
  bitrateSet: boolean;
}

/** P2P full mesh with perfect negotiation and ICE-restart recovery. */
export function createMeshTransport(opts: MeshTransportOptions): CallTransport {
  const { selfId, session, iceServers, send, events } = opts;
  const peers = new Map<string, MeshPeer>();
  const localTracks = new Map<CallMediaKind, MediaStreamTrack | null>();
  const localStream = new MediaStream();
  const canRelay = hasTurn(iceServers);
  let closed = false;

  const setStatus = (peer: MeshPeer) => {
    const status = peer.recovery.status;
    if (status !== peer.status) {
      peer.status = status;
      events.onPeerStatus(peer.id, status);
    }
  };

  const signal = (peer: MeshPeer, payload: CallSignalPayload) => {
    if (!closed && peers.get(peer.id) === peer) {
      send(peer.id, peer.session, payload);
    }
  };

  const addTrack = (peer: MeshPeer, kind: CallMediaKind) => {
    const track = localTracks.get(kind);
    const sender = peer.senders.get(kind);
    if (sender) {
      sender.replaceTrack(track ?? null).catch((e) => {
        console.warn("[call] replaceTrack failed", e);
      });
    } else if (track) {
      // addTrack (not addTransceiver) so a colliding remote offer can reuse the transceiver
      peer.senders.set(kind, peer.pc.addTrack(track, localStream));
    }
  };

  const limitBitrate = async (peer: MeshPeer) => {
    const sender = peer.senders.get("audio");
    if (!sender || peer.bitrateSet) {
      return;
    }
    peer.bitrateSet = true;
    try {
      const params = sender.getParameters();
      if (params.encodings?.length) {
        params.encodings[0].maxBitrate = VOICE_MAX_BITRATE + 8_000;
        await sender.setParameters(params);
      }
    } catch (e) {
      console.warn("[call] setParameters failed", e);
    }
  };

  const createPeer = (info: CallPeerInfo): MeshPeer => {
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
    });
    const now = Date.now();
    const peer: MeshPeer = {
      id: info.clientId,
      session: info.session,
      pc,
      polite: isPolite(selfId, info.clientId),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      queue: Promise.resolve(),
      recovery: new PeerRecovery(now),
      senders: new Map(),
      status: "connecting",
      bitrateSet: false,
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          signal(peer, {
            description: {
              type: pc.localDescription.type as "offer" | "answer",
              sdp: pc.localDescription.sdp,
            },
          });
        }
      } catch (e) {
        console.warn("[call] negotiation failed", e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        const c = candidate.toJSON();
        signal(peer, {
          candidate: {
            candidate: c.candidate ?? "",
            sdpMid: c.sdpMid ?? null,
            sdpMLineIndex: c.sdpMLineIndex ?? null,
            usernameFragment: c.usernameFragment ?? null,
          },
        });
      }
    };
    pc.ontrack = ({ track }) => events.onTrack(peer.id, track);
    pc.onconnectionstatechange = () => {
      peer.recovery.update(pc.connectionState, Date.now());
      if (pc.connectionState === "connected") {
        limitBitrate(peer);
      }
      setStatus(peer);
    };
    peers.set(peer.id, peer);
    for (const kind of localTracks.keys()) {
      addTrack(peer, kind);
    }
    events.onPeerStatus(peer.id, peer.status);
    return peer;
  };

  const closePeer = (peer: MeshPeer) => {
    peers.delete(peer.id);
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    events.onPeerClosed(peer.id);
  };

  const handle = async (peer: MeshPeer, msg: CallSignalEvent) => {
    const { pc } = peer;
    if (msg.description) {
      const { type } = msg.description;
      if (type === "rollback") {
        return;
      }
      const decision = offerDecision({
        type,
        polite: peer.polite,
        makingOffer: peer.makingOffer,
        signalingState: pc.signalingState,
        settingRemoteAnswer: peer.settingRemoteAnswer,
      });
      peer.ignoreOffer = decision.ignore;
      if (decision.ignore) {
        return;
      }
      if (decision.rollback) {
        // Older browsers don't roll back implicitly in setRemoteDescription
        await pc.setLocalDescription({ type: "rollback" });
      }
      peer.settingRemoteAnswer = type === "answer";
      try {
        await pc.setRemoteDescription({
          type,
          sdp: tuneVoiceSdp(stripExtmapAllowMixed(msg.description.sdp)),
        });
      } finally {
        peer.settingRemoteAnswer = false;
      }
      if (type === "offer") {
        await pc.setLocalDescription();
        if (pc.localDescription) {
          signal(peer, {
            description: {
              type: pc.localDescription.type as "offer" | "answer",
              sdp: pc.localDescription.sdp,
            },
          });
        }
      }
    } else if (msg.candidate) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        if (!peer.ignoreOffer) {
          console.warn("[call] addIceCandidate failed", e);
        }
      }
    }
  };

  // Recovery: restart ICE (with backoff) when a connection stays disconnected or fails, relay-only after a few tries
  const recoveryTimer = window.setInterval(() => {
    const now = Date.now();
    for (const peer of peers.values()) {
      const due = peer.recovery.due(now, canRelay);
      if (!due) {
        continue;
      }
      peer.recovery.restarted(now, due.relay);
      peer.queue = peer.queue.then(async () => {
        if (peers.get(peer.id) !== peer) {
          return;
        }
        const { pc } = peer;
        try {
          if (
            due.relay &&
            pc.getConfiguration().iceTransportPolicy !== "relay"
          ) {
            pc.setConfiguration({
              ...pc.getConfiguration(),
              iceTransportPolicy: "relay",
            });
          }
          if (pc.signalingState === "have-local-offer") {
            // Our offer was never answered (the relay dropped it while they reconnected): start over
            await pc.setLocalDescription({ type: "rollback" });
          }
          pc.restartIce();
        } catch (e) {
          console.warn("[call] ICE restart failed", e);
        }
      });
      setStatus(peer);
    }
  }, 1000);

  return {
    setLocalTrack(kind, track) {
      localTracks.set(kind, track);
      for (const t of localStream.getTracks()) {
        if (t.kind === kind) {
          localStream.removeTrack(t);
        }
      }
      if (track) {
        localStream.addTrack(track);
      }
      for (const peer of peers.values()) {
        addTrack(peer, kind);
      }
    },
    setPeers(list) {
      if (closed) {
        return;
      }
      const wanted = new Map(
        list.filter((p) => p.clientId !== selfId).map((p) => [p.clientId, p]),
      );
      for (const peer of [...peers.values()]) {
        const info = wanted.get(peer.id);
        if (!info || info.session !== peer.session) {
          closePeer(peer);
        }
      }
      for (const info of wanted.values()) {
        if (!peers.has(info.clientId) && !info.reconnecting) {
          createPeer(info);
        }
      }
    },
    handleSignal(msg) {
      if (closed || msg.toSession !== session) {
        return;
      }
      const peer = peers.get(msg.from);
      if (!peer || peer.session !== msg.session) {
        return;
      }
      peer.queue = peer.queue
        .then(() =>
          peers.get(peer.id) === peer ? handle(peer, msg) : undefined,
        )
        .catch((e) => console.warn("[call] signal failed", e));
    },
    close() {
      closed = true;
      window.clearInterval(recoveryTimer);
      for (const peer of [...peers.values()]) {
        closePeer(peer);
      }
    },
  };
}
