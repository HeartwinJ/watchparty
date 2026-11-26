// Pure decisions for the voice call's peer connections: perfect negotiation roles and collisions, and when to
// restart ICE (with backoff, then relay-only).
// See https://w3c.github.io/webrtc-pc/#perfect-negotiation-example

/** One side of every pair is "polite" (yields on an offer collision). Decided by comparing clientIds. */
export const isPolite = (selfId: string, otherId: string) => selfId < otherId;

/**
 * What to do with an incoming description. An offer collides when we're making one ourselves or aren't stable
 * (unless we're just applying the answer to ours). The impolite side ignores the colliding offer; the polite side
 * rolls its own offer back and answers.
 */
export function offerDecision(s: {
  type: RTCSdpType;
  polite: boolean;
  makingOffer: boolean;
  signalingState: RTCSignalingState;
  settingRemoteAnswer: boolean;
}): { ignore: boolean; rollback: boolean } {
  const readyForOffer =
    !s.makingOffer && (s.signalingState === "stable" || s.settingRemoteAnswer);
  const collision = s.type === "offer" && !readyForOffer;
  return {
    ignore: collision && !s.polite,
    rollback: collision && s.polite && s.signalingState !== "stable",
  };
}

export const RECOVERY = {
  /** A fresh connection gets this long to connect before we restart ICE */
  initialGraceMs: 10_000,
  /** `disconnected` often heals on its own; restart if it lasts this long */
  disconnectedGraceMs: 3_000,
  /** After this many restarts, go relay-only (TURN), when TURN servers are configured */
  relayAfterAttempts: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 16_000,
};

/** Backoff before the next ICE restart: 1, 2, 4, 8, 16, 16… s, ±20 % jitter */
export function restartDelayMs(attempt: number, random = Math.random) {
  const base = Math.min(
    RECOVERY.maxDelayMs,
    RECOVERY.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(base * (0.8 + 0.4 * random()));
}

export type PeerStatus = "connecting" | "connected" | "reconnecting";

/**
 * Tracks one peer connection's health and says when to restart ICE. Feed it every `connectionstatechange` and poll
 * `due(now)` about once a second.
 */
export class PeerRecovery {
  private state: RTCPeerConnectionState = "new";
  private connectedOnce = false;
  /** Since when the connection has been not-connected (null while connected) */
  private troubleSince: number | null;
  private graceMs = RECOVERY.initialGraceMs;
  private nextAllowedAt = 0;
  attempts = 0;
  /** Relay-only has been switched on for this connection */
  relay = false;

  private random: () => number;

  constructor(now: number, random: () => number = Math.random) {
    this.troubleSince = now;
    this.random = random;
  }

  update(state: RTCPeerConnectionState, now: number) {
    this.state = state;
    if (state === "connected") {
      this.connectedOnce = true;
      this.troubleSince = null;
      this.attempts = 0;
      this.nextAllowedAt = 0;
    } else if (state === "disconnected" || state === "failed") {
      if (this.troubleSince === null) {
        this.troubleSince = now;
        this.graceMs = RECOVERY.disconnectedGraceMs;
      }
    }
  }

  /** A restart to do now (relay = switch to relay-only first), or null */
  due(now: number, canRelay: boolean): { relay: boolean } | null {
    if (
      this.state === "closed" ||
      this.troubleSince === null ||
      now < this.nextAllowedAt
    ) {
      return null;
    }
    const troubled =
      this.state === "failed" || now - this.troubleSince >= this.graceMs;
    if (!troubled) {
      return null;
    }
    return {
      relay:
        canRelay &&
        (this.relay || this.attempts + 1 > RECOVERY.relayAfterAttempts),
    };
  }

  restarted(now: number, relay: boolean) {
    this.attempts++;
    this.relay = this.relay || relay;
    this.nextAllowedAt = now + restartDelayMs(this.attempts, this.random);
  }

  get status(): PeerStatus {
    if (this.state === "connected") {
      return "connected";
    }
    return this.connectedOnce || this.attempts > 0
      ? "reconnecting"
      : "connecting";
  }
}

/** Whether the ICE servers include TURN (relay-only makes no sense without it) */
export function hasTurn(servers: RTCIceServer[]): boolean {
  return servers.some((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) =>
      /^turns?:/i.test(u),
    ),
  );
}
