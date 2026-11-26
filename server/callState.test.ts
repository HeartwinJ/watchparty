import { describe, expect, it } from "vitest";
import {
  CallMembership,
  createWindowLimiter,
  parseCallCommand,
  parseCallModeration,
  parseCallSignal,
} from "./callState.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SESSION = "sessA_123";

describe("parseCallCommand", () => {
  it("accepts join/leave/state and rejects the rest", () => {
    expect(
      parseCallCommand({ action: "join", session: SESSION, muted: true }),
    ).toEqual({
      action: "join",
      session: SESSION,
      muted: true,
      camera: false,
      wantsVideo: true,
    });
    expect(
      parseCallCommand({
        action: "join",
        session: SESSION,
        muted: false,
        camera: true,
      }),
    ).toEqual({
      action: "join",
      session: SESSION,
      muted: false,
      camera: true,
      wantsVideo: true,
    });
    expect(
      parseCallCommand({
        action: "join",
        session: SESSION,
        muted: false,
        wantsVideo: false,
      }),
    ).toMatchObject({ camera: false, wantsVideo: false });
    expect(parseCallCommand({ action: "state", wantsVideo: false })).toEqual({
      action: "state",
      wantsVideo: false,
    });
    expect(
      parseCallCommand({
        action: "state",
        muted: false,
        camera: true,
        wantsVideo: true,
      }),
    ).toEqual({
      action: "state",
      muted: false,
      camera: true,
      wantsVideo: true,
    });
    expect(parseCallCommand({ action: "leave", extra: 1 })).toEqual({
      action: "leave",
    });
    expect(parseCallCommand({ action: "state", muted: false })).toEqual({
      action: "state",
      muted: false,
    });
    expect(parseCallCommand({ action: "state", camera: true, x: 1 })).toEqual({
      action: "state",
      camera: true,
    });
    expect(
      parseCallCommand({ action: "state", muted: true, camera: false }),
    ).toEqual({ action: "state", muted: true, camera: false });
    for (const bad of [
      null,
      "join",
      { action: "join", session: SESSION },
      { action: "join", session: "short", muted: false },
      { action: "join", session: "has space in it", muted: false },
      { action: "join", session: "x".repeat(65), muted: false },
      { action: "join", session: SESSION, muted: false, camera: "on" },
      { action: "state", muted: "yes" },
      { action: "state" },
      { action: "state", camera: 1 },
      { action: "state", muted: true, camera: null },
      { action: "state", wantsVideo: "no" },
      { action: "state", wantsVideo: null },
      { action: "join", session: SESSION, muted: false, wantsVideo: 0 },
      { action: "camera", on: true },
    ]) {
      expect(parseCallCommand(bad)).toBeNull();
    }
  });
});

describe("parseCallModeration", () => {
  it("needs mute/camera/remove and a client id", () => {
    expect(parseCallModeration({ action: "mute", clientId: A })).toEqual({
      action: "mute",
      clientId: A,
    });
    expect(parseCallModeration({ action: "camera", clientId: A })).toEqual({
      action: "camera",
      clientId: A,
    });
    expect(parseCallModeration({ action: "unmute", clientId: A })).toBeNull();
    expect(
      parseCallModeration({ action: "remove", clientId: "__proto__" }),
    ).toBeNull();
  });
});

describe("parseCallSignal", () => {
  const base = { to: B, toSession: SESSION };
  it("keeps only the known fields of a description", () => {
    expect(
      parseCallSignal({
        ...base,
        description: { type: "offer", sdp: "v=0", evil: 1 },
        from: A,
        extra: "x",
      }),
    ).toEqual({ ...base, description: { type: "offer", sdp: "v=0" } });
  });

  it("accepts candidates, including the null end-of-candidates", () => {
    expect(
      parseCallSignal({
        ...base,
        candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host" },
      }),
    ).toEqual({
      ...base,
      candidate: {
        candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host",
        sdpMid: null,
        sdpMLineIndex: null,
        usernameFragment: null,
      },
    });
    expect(parseCallSignal({ ...base, candidate: null })).toEqual({
      ...base,
      candidate: null,
    });
  });

  it("rejects bad shapes and oversized messages", () => {
    for (const bad of [
      null,
      { ...base },
      { to: "nope", toSession: SESSION, candidate: null },
      { to: B, toSession: "x", candidate: null },
      { ...base, description: { type: "pranswer", sdp: "v=0" } },
      { ...base, description: { type: "offer", sdp: 5 } },
      { ...base, description: { type: "offer", sdp: "v=0" }, candidate: null },
      { ...base, candidate: { candidate: "c", sdpMLineIndex: -1 } },
      { ...base, candidate: { candidate: "c", sdpMid: 5 } },
    ]) {
      expect(parseCallSignal(bad)).toBeNull();
    }
    expect(
      parseCallSignal(
        { ...base, description: { type: "offer", sdp: "a".repeat(200) } },
        100,
      ),
    ).toBeNull();
  });
});

describe("CallMembership", () => {
  it("joins, mutes, leaves", () => {
    const c = new CallMembership();
    expect(c.join(A, "s1", { session: SESSION, muted: true }, 1000)).toBe(
      "joined",
    );
    expect(c.snapshot().members).toEqual([
      {
        clientId: A,
        session: SESSION,
        muted: true,
        camera: false,
        wantsVideo: true,
        joinedAt: 1000,
        reconnecting: false,
      },
    ]);
    // Only the member's own socket can change it
    expect(c.setState(A, "other", { muted: false })).toBe(false);
    expect(c.setState(A, "s1", { muted: false })).toBe(true);
    expect(c.setState(A, "s1", { muted: false })).toBe(false);
    expect(c.leave(A, "other")).toBe(false);
    expect(c.leave(A, "s1")).toBe(true);
    expect(c.size).toBe(0);
  });

  it("tracks the camera: off on join unless sent, changed by the member's own socket, kept on a rejoin", () => {
    const c = new CallMembership();
    c.join(A, "s1", { session: SESSION, muted: false }, 1);
    expect(c.snapshot().members[0].camera).toBe(false);
    expect(c.setState(A, "other", { camera: true })).toBe(false);
    expect(c.setState(A, "s1", { camera: true })).toBe(true);
    expect(c.setState(A, "s1", { camera: true })).toBe(false);
    expect(c.snapshot().members[0]).toMatchObject({
      muted: false,
      camera: true,
    });
    // Both at once; only what changed counts
    expect(c.setState(A, "s1", { muted: true, camera: true })).toBe(true);
    expect(c.snapshot().members[0]).toMatchObject({
      muted: true,
      camera: true,
    });
    // A rejoin carries the client's state (a socket reconnect keeps the camera on, a reload joins with it off)
    c.join(A, "s2", { session: SESSION, muted: true, camera: true }, 5);
    expect(c.snapshot().members[0].camera).toBe(true);
    c.join(A, "s3", { session: "sessA_789", muted: true, camera: false }, 6);
    expect(c.snapshot().members[0].camera).toBe(false);
    c.join(B, "sb", { session: SESSION, muted: false, camera: true }, 7);
    expect(c.snapshot().members[1].camera).toBe(true);
  });

  it("tracks wantsVideo: on unless sent, changed by the member's own socket, carried by a rejoin", () => {
    const c = new CallMembership();
    c.join(A, "s1", { session: SESSION, muted: false }, 1);
    expect(c.snapshot().members[0].wantsVideo).toBe(true);
    expect(c.setState(A, "other", { wantsVideo: false })).toBe(false);
    expect(c.setState(A, "s1", { wantsVideo: false })).toBe(true);
    expect(c.setState(A, "s1", { wantsVideo: false })).toBe(false);
    expect(c.snapshot().members[0]).toMatchObject({
      wantsVideo: false,
      camera: false,
      muted: false,
    });
    // A socket reconnect re-sends it; a client that doesn't say (older) gets video again
    c.join(A, "s2", { session: SESSION, muted: false, wantsVideo: false }, 2);
    expect(c.snapshot().members[0].wantsVideo).toBe(false);
    c.join(A, "s3", { session: SESSION, muted: false }, 3);
    expect(c.snapshot().members[0].wantsVideo).toBe(true);
    c.join(B, "sb", { session: SESSION, muted: false, wantsVideo: false }, 4);
    expect(c.snapshot().members[1].wantsVideo).toBe(false);
  });

  it("keeps a disconnected member for the grace period and lets them rejoin", () => {
    const c = new CallMembership({ graceMs: 5000 });
    c.join(A, "s1", { session: SESSION, muted: false }, 1000);
    expect(c.disconnect(A, "other-socket", 2000)).toBe(false);
    expect(c.disconnect(A, "s1", 2000)).toBe(true);
    expect(c.snapshot().members[0].reconnecting).toBe(true);
    expect(c.nextExpiry()).toBe(7000);
    expect(c.expire(6999)).toEqual([]);
    // A reload: new socket, new session, keeps the join time
    expect(c.join(A, "s2", { session: "sessA_456", muted: true }, 3000)).toBe(
      "rejoined",
    );
    expect(c.snapshot().members[0]).toMatchObject({
      session: "sessA_456",
      muted: true,
      joinedAt: 1000,
      reconnecting: false,
    });
    expect(c.nextExpiry()).toBeNull();
    c.disconnect(A, "s2", 10_000);
    expect(c.expire(15_000)).toEqual([A]);
    expect(c.has(A)).toBe(false);
  });

  it("only relays between connected members, from the member's own socket", () => {
    const c = new CallMembership();
    c.join(A, "sa", { session: SESSION, muted: false }, 1);
    expect(c.canRelay(A, "sa", B)).toBe(false);
    c.join(B, "sb", { session: SESSION, muted: false }, 2);
    expect(c.canRelay(A, "sa", B)).toBe(true);
    expect(c.canRelay(A, "not-sa", B)).toBe(false);
    expect(c.canRelay(A, "sa", A)).toBe(false);
    c.disconnect(B, "sb", 3);
    expect(c.canRelay(A, "sa", B)).toBe(false);
  });

  it("refuses joins past the member cap", () => {
    const c = new CallMembership({ maxMembers: 1 });
    c.join(A, "sa", { session: SESSION, muted: false }, 1);
    expect(c.join(B, "sb", { session: SESSION, muted: false }, 2)).toBe("full");
    // Rejoining isn't a new member
    expect(c.join(A, "sa2", { session: SESSION, muted: false }, 3)).toBe(
      "rejoined",
    );
  });
});

describe("createWindowLimiter", () => {
  it("allows max events per window per key", () => {
    const l = createWindowLimiter(2, 1000);
    expect(l.allow("a", 0)).toBe(true);
    expect(l.allow("a", 10)).toBe(true);
    expect(l.allow("a", 20)).toBe(false);
    expect(l.allow("b", 20)).toBe(true);
    expect(l.allow("a", 1000)).toBe(true);
  });
});

describe("call state edge cases", () => {
  it("rejects non-object moderation and candidate payloads", () => {
    expect(parseCallModeration(null)).toBeNull();
    expect(parseCallModeration("mute")).toBeNull();
    const base = { to: B, toSession: SESSION };
    expect(parseCallSignal({ ...base, candidate: "candidate:1" })).toBeNull();
    expect(
      parseCallSignal({ ...base, candidate: { candidate: 5 } }),
    ).toBeNull();
  });

  it("forgets stale windows once it tracks many keys", () => {
    const limiter = createWindowLimiter(1, 1000);
    for (let i = 0; i < 1001; i++) {
      limiter.allow("k" + i, 0);
    }
    // A new window sweeps the old ones; an old key starts over
    expect(limiter.allow("fresh", 5000)).toBe(true);
    expect(limiter.allow("k1", 5000)).toBe(true);
    expect(limiter.allow("k1", 5000)).toBe(false);
  });

  it("reports the earliest grace period end", () => {
    const c = new CallMembership({ graceMs: 5000 });
    expect(c.nextExpiry()).toBeNull();
    c.join(A, "sa", { session: SESSION, muted: true }, 0);
    c.join(B, "sb", { session: SESSION, muted: true }, 0);
    c.disconnect(B, "sb", 100);
    c.disconnect(A, "sa", 200);
    expect(c.nextExpiry()).toBe(5100);
    expect(c.socketOf(A)).toBeNull();
    expect(c.sessionOf("nobody")).toBeNull();
  });
});
