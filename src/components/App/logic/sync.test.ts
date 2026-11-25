import { describe, expect, it } from "vitest";
import {
  DRIFT,
  describePeerSync,
  getEffectiveDuration,
  getLeaderTime,
  getLocalSeekTarget,
  getSyncStatus,
  initialDriftState,
  isSameSyncStatus,
  nextDriftAction,
  pickNudgeRate,
  shouldAutoSyncRate,
  toRoomTime,
  type DriftState,
} from "./sync";

describe("getLeaderTime", () => {
  it("uses the furthest-ahead time with two or fewer people", () => {
    expect(getLeaderTime(2, { a: 10, b: 12 })).toBe(12);
    expect(getLeaderTime(1, { a: 5 })).toBe(5);
  });

  it("uses the median with more than two people", () => {
    expect(getLeaderTime(3, { a: 10, b: 100, c: 12 })).toBe(12);
    expect(getLeaderTime(4, { a: 10, b: 20, c: 12, d: 14 })).toBe(13);
  });

  it("is -Infinity with no timestamps (no valid seek target)", () => {
    expect(getLeaderTime(0, {})).toBe(-Infinity);
  });
});

describe("nextDriftAction (drift controller)", () => {
  const step = (state: DriftState, drift: number, extra = {}) =>
    nextDriftAction(state, { drift, baseRate: 1, now: 10_000, ...extra });

  it("plays at the room rate when in sync", () => {
    const r = step(initialDriftState(), 0.05);
    expect(r.action).toEqual({ type: "rate", rate: 1 });
    expect(r.state.correcting).toBe(false);
  });

  it("ignores drift below the enter threshold", () => {
    expect(step(initialDriftState(), DRIFT.enter).action).toEqual({
      type: "rate",
      rate: 1,
    });
    expect(step(initialDriftState(), -0.25).state.correcting).toBe(false);
  });

  it("speeds up proportionally when behind", () => {
    const r = step(initialDriftState(), 0.6);
    expect(r.state.correcting).toBe(true);
    expect(r.action).toEqual({ type: "rate", rate: 1.03 });
    expect(step(initialDriftState(), 0.8).action).toEqual({
      type: "rate",
      rate: 1.04,
    });
  });

  it("slows down proportionally when ahead", () => {
    expect(step(initialDriftState(), -0.6).action).toEqual({
      type: "rate",
      rate: 0.97,
    });
  });

  it("caps the nudge at 0.95–1.05x", () => {
    expect(step(initialDriftState(), 1.9).action).toEqual({
      type: "rate",
      rate: 1.05,
    });
    expect(step(initialDriftState(), -1.9).action).toEqual({
      type: "rate",
      rate: 0.95,
    });
  });

  it("nudges around the room speed when it isn't 1x", () => {
    const r = nextDriftAction(initialDriftState(), {
      drift: 1.5,
      baseRate: 2,
      now: 0,
    });
    expect(r.action).toEqual({ type: "rate", rate: 2.1 });
    // A missing/zero room rate counts as 1x
    expect(
      nextDriftAction(initialDriftState(), { drift: 0, baseRate: 0, now: 0 })
        .action,
    ).toEqual({ type: "rate", rate: 1 });
  });

  it("has hysteresis: keeps correcting until within the exit threshold", () => {
    let st = step(initialDriftState(), 0.5).state;
    // Between exit and enter: still correcting (a fresh controller wouldn't start)
    let r = step(st, 0.2);
    expect(r.state.correcting).toBe(true);
    expect(r.action.rate).toBeGreaterThan(1);
    expect(step(initialDriftState(), 0.2).state.correcting).toBe(false);
    st = r.state;
    r = step(st, 0.05);
    expect(r.state.correcting).toBe(false);
    expect(r.action).toEqual({ type: "rate", rate: 1 });
    // And doesn't restart until past enter again
    expect(step(r.state, 0.25).state.correcting).toBe(false);
  });

  it("hard-seeks beyond 2 s, then waits for the cooldown", () => {
    const r = step(initialDriftState(), 2.5);
    expect(r.action).toEqual({ type: "seek", rate: 1 });
    expect(r.state.cooldownUntil).toBe(10_000 + DRIFT.seekCooldownMs);
    expect(step(initialDriftState(), -3).action.type).toBe("seek");
    // During the cooldown the (stale) drift is ignored
    const during = nextDriftAction(r.state, {
      drift: 2.5,
      baseRate: 1,
      now: 11_000,
    });
    expect(during.action).toEqual({ type: "rate", rate: 1 });
    const after = nextDriftAction(r.state, {
      drift: 2.5,
      baseRate: 1,
      now: 10_000 + DRIFT.seekCooldownMs,
    });
    expect(after.action.type).toBe("seek");
  });

  it("resets on unknown drift", () => {
    const st = step(initialDriftState(), 1).state;
    const r = step(st, NaN);
    expect(r.state.correcting).toBe(false);
    expect(r.action).toEqual({ type: "rate", rate: 1 });
    expect(step(st, -Infinity).action).toEqual({ type: "rate", rate: 1 });
  });

  it("only uses supported rates (YouTube), never one outside 0.95–1.05x", () => {
    const yt = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    // No usable nudge: no rate changes, and a lower seek threshold instead
    expect(step(initialDriftState(), 0.8, { allowedRates: yt }).action).toEqual(
      { type: "rate", rate: 1 },
    );
    expect(step(initialDriftState(), 1.2, { allowedRates: yt }).action).toEqual(
      { type: "seek", rate: 1 },
    );
    expect(
      step(initialDriftState(), -1.2, { allowedRates: yt }).action.type,
    ).toBe("seek");
    // Finer-grained rates can be used
    const fine = [0.9, 0.95, 1, 1.05, 1.1];
    expect(
      step(initialDriftState(), 0.5, { allowedRates: fine }).action,
    ).toEqual({ type: "rate", rate: 1.05 });
    expect(
      step(initialDriftState(), -0.5, { allowedRates: fine }).action,
    ).toEqual({ type: "rate", rate: 0.95 });
    expect(
      step(initialDriftState(), 1.5, { allowedRates: fine }).action.type,
    ).toBe("rate");
  });

  it("converges in a simulated run", () => {
    // We start 1.5 s behind; each 1 s tick the gap closes by (rate - 1)
    let st = initialDriftState();
    let drift = 1.5;
    const rates: number[] = [];
    for (let t = 0; t < 120 && (drift > DRIFT.exit || st.correcting); t++) {
      const r = nextDriftAction(st, { drift, baseRate: 1, now: t * 1000 });
      expect(r.action.type).toBe("rate");
      rates.push(r.action.rate);
      drift -= r.action.rate - 1;
      st = r.state;
    }
    expect(st.correcting).toBe(false);
    expect(Math.abs(drift)).toBeLessThanOrEqual(DRIFT.exit + 0.01);
    expect(Math.max(...rates)).toBeLessThanOrEqual(1.05);
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(1);
  });
});

describe("pickNudgeRate", () => {
  it("rounds and clamps without a rate list", () => {
    expect(pickNudgeRate(1.0234, 1)).toBe(1.02);
    expect(pickNudgeRate(1.3, 1)).toBe(1.05);
    expect(pickNudgeRate(0.5, 1)).toBe(0.95);
  });
  it("picks the closest supported rate on the same side", () => {
    expect(pickNudgeRate(1.03, 1, [1, 1.02, 1.05])).toBe(1.02);
    expect(pickNudgeRate(0.97, 1, [1, 1.05])).toBe(1);
    expect(pickNudgeRate(1, 1, [0.95, 1, 1.05])).toBe(1);
  });
});

describe("getSyncStatus", () => {
  it("prefers reconnecting, then buffering, then drift", () => {
    const base = { connected: true, buffering: false, correcting: false };
    expect(getSyncStatus({ ...base, drift: 0 })).toEqual({ kind: "in-sync" });
    expect(getSyncStatus({ ...base, correcting: true, drift: 1.26 })).toEqual({
      kind: "catching-up",
      behind: 1.3,
    });
    expect(
      getSyncStatus({ ...base, buffering: true, correcting: true, drift: 1 }),
    ).toEqual({ kind: "buffering" });
    expect(
      getSyncStatus({ ...base, connected: false, buffering: true, drift: 1 }),
    ).toEqual({ kind: "reconnecting" });
  });
  it("compares statuses", () => {
    expect(
      isSameSyncStatus(
        { kind: "catching-up", behind: 1 },
        { kind: "catching-up", behind: 1 },
      ),
    ).toBe(true);
    expect(
      isSameSyncStatus(
        { kind: "catching-up", behind: 1 },
        { kind: "catching-up", behind: 1.1 },
      ),
    ).toBe(false);
    expect(isSameSyncStatus({ kind: "in-sync" }, { kind: "buffering" })).toBe(
      false,
    );
  });
});

describe("describePeerSync", () => {
  it("labels each person's drift", () => {
    expect(describePeerSync(0.1)).toEqual({
      tone: "success",
      label: "In sync",
    });
    expect(describePeerSync(1.24)).toEqual({
      tone: "warning",
      label: "1.2 s behind",
    });
    expect(describePeerSync(-2)).toEqual({
      tone: "warning",
      label: "2.0 s ahead",
    });
    expect(describePeerSync(undefined).tone).toBe("warning");
  });
});

describe("shouldAutoSyncRate", () => {
  const base = {
    roomPaused: false,
    isLiveStream: false,
    hasDuration: true,
  };
  it("applies only to playing, non-live media with a duration", () => {
    expect(shouldAutoSyncRate(base)).toBe(true);
    expect(shouldAutoSyncRate({ ...base, roomPaused: true })).toBe(false);
    expect(shouldAutoSyncRate({ ...base, isLiveStream: true })).toBe(false);
    expect(shouldAutoSyncRate({ ...base, hasDuration: false })).toBe(false);
  });
});

describe("toRoomTime", () => {
  it("sends the plain time for VOD", () => {
    expect(toRoomTime(42, false, 100)).toBe(42);
  });
  it("sends the offset from the live edge for live streams", () => {
    expect(toRoomTime(90, true, 100)).toBe(-10);
  });
});

describe("getLocalSeekTarget", () => {
  it("seeks to the given room time, else the leader", () => {
    expect(
      getLocalSeekTarget({
        roomTime: 5,
        leaderTime: 50,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBe(5);
    expect(
      getLocalSeekTarget({
        leaderTime: 50,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBe(50);
  });

  it("maps live offsets onto our own live edge", () => {
    expect(
      getLocalSeekTarget({
        roomTime: -10,
        leaderTime: 0,
        isLiveStream: true,
        duration: 1000,
      }),
    ).toBe(990);
    expect(
      getLocalSeekTarget({ leaderTime: 0, isLiveStream: true, duration: 1000 }),
    ).toBe(1000);
  });

  it("returns undefined for invalid targets", () => {
    expect(
      getLocalSeekTarget({
        leaderTime: -Infinity,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBeUndefined();
    expect(
      getLocalSeekTarget({
        roomTime: -1,
        leaderTime: 0,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBeUndefined();
    expect(
      getLocalSeekTarget({
        leaderTime: 0,
        isLiveStream: true,
        duration: Infinity,
      }),
    ).toBeUndefined();
  });
});

describe("getEffectiveDuration", () => {
  const seekable = { length: 2, end: (i: number) => [50, 120][i] };
  it("uses the end of the seekable range for infinite live durations", () => {
    expect(getEffectiveDuration(Infinity, true, seekable)).toBe(120);
  });
  it("keeps the reported duration otherwise", () => {
    expect(getEffectiveDuration(300, false, seekable)).toBe(300);
    expect(getEffectiveDuration(Infinity, false, seekable)).toBe(Infinity);
    expect(
      getEffectiveDuration(Infinity, true, { length: 0, end: () => 0 }),
    ).toBe(Infinity);
    expect(getEffectiveDuration(80, true)).toBe(80);
  });
});
