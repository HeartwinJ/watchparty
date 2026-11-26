import { describe, expect, it } from "vitest";
import {
  hasTurn,
  isPolite,
  offerDecision,
  PeerRecovery,
  RECOVERY,
  restartDelayMs,
} from "./negotiation";

describe("isPolite", () => {
  it("makes exactly one side of a pair polite", () => {
    expect(isPolite("a", "b")).toBe(true);
    expect(isPolite("b", "a")).toBe(false);
  });
});

describe("offerDecision (perfect negotiation)", () => {
  const base = {
    makingOffer: false,
    signalingState: "stable" as RTCSignalingState,
    settingRemoteAnswer: false,
  };
  it("accepts an offer when stable", () => {
    expect(offerDecision({ ...base, type: "offer", polite: false })).toEqual({
      ignore: false,
      rollback: false,
    });
  });
  it("the impolite side ignores a colliding offer", () => {
    expect(
      offerDecision({
        ...base,
        type: "offer",
        polite: false,
        signalingState: "have-local-offer",
      }),
    ).toEqual({ ignore: true, rollback: false });
    expect(
      offerDecision({
        ...base,
        type: "offer",
        polite: false,
        makingOffer: true,
      }),
    ).toEqual({ ignore: true, rollback: false });
  });
  it("the polite side rolls its offer back and answers", () => {
    expect(
      offerDecision({
        ...base,
        type: "offer",
        polite: true,
        signalingState: "have-local-offer",
      }),
    ).toEqual({ ignore: false, rollback: true });
    // Still creating its offer (state stable): setRemoteDescription rolls back by itself
    expect(
      offerDecision({
        ...base,
        type: "offer",
        polite: true,
        makingOffer: true,
      }),
    ).toEqual({ ignore: false, rollback: false });
  });
  it("never ignores answers", () => {
    expect(
      offerDecision({
        ...base,
        type: "answer",
        polite: false,
        signalingState: "have-local-offer",
      }),
    ).toEqual({ ignore: false, rollback: false });
  });
});

describe("restartDelayMs", () => {
  it("backs off exponentially up to a cap, with jitter", () => {
    const mid = () => 0.5;
    expect(restartDelayMs(1, mid)).toBe(1000);
    expect(restartDelayMs(2, mid)).toBe(2000);
    expect(restartDelayMs(4, mid)).toBe(8000);
    expect(restartDelayMs(10, mid)).toBe(RECOVERY.maxDelayMs);
    expect(restartDelayMs(1, () => 0)).toBe(800);
    expect(restartDelayMs(1, () => 1)).toBe(1200);
  });
});

describe("PeerRecovery", () => {
  const mid = () => 0.5;
  it("gives a new connection time, then restarts if it never connects", () => {
    const r = new PeerRecovery(0, mid);
    r.update("connecting", 100);
    expect(r.status).toBe("connecting");
    expect(r.due(RECOVERY.initialGraceMs - 1, true)).toBeNull();
    expect(r.due(RECOVERY.initialGraceMs, true)).toEqual({ relay: false });
  });

  it("restarts after a few seconds disconnected, at once when failed, with backoff", () => {
    const r = new PeerRecovery(0, mid);
    r.update("connected", 1000);
    expect(r.status).toBe("connected");
    expect(r.due(5000, true)).toBeNull();
    r.update("disconnected", 10_000);
    expect(r.status).toBe("reconnecting");
    expect(r.due(12_000, true)).toBeNull();
    expect(r.due(13_000, true)).toEqual({ relay: false });
    r.restarted(13_000, false);
    // Backoff: nothing for 1 s
    r.update("failed", 13_100);
    expect(r.due(13_500, true)).toBeNull();
    expect(r.due(14_000, true)).toEqual({ relay: false });
    r.restarted(14_000, false);
    // Third attempt goes relay-only (when TURN is configured)
    expect(r.due(16_000, true)).toEqual({ relay: true });
    expect(r.due(16_000, false)).toEqual({ relay: false });
    r.restarted(16_000, true);
    expect(r.relay).toBe(true);
    // Connected again: back to normal, relay stays on for this connection
    r.update("connected", 17_000);
    expect(r.attempts).toBe(0);
    expect(r.status).toBe("connected");
    expect(r.due(60_000, true)).toBeNull();
  });

  it("does nothing once closed", () => {
    const r = new PeerRecovery(0, mid);
    r.update("closed", 1);
    expect(r.due(60_000, true)).toBeNull();
  });
});

describe("hasTurn", () => {
  it("looks for turn: or turns: URLs", () => {
    expect(hasTurn([{ urls: "stun:stun.example.com:3478" }])).toBe(false);
    expect(
      hasTurn([
        {
          urls: ["stun:x", "turns:turn.example.com:443?transport=tcp"],
          username: "u",
          credential: "c",
        },
      ]),
    ).toBe(true);
  });
});
