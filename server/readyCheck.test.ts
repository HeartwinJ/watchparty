import { describe, expect, it } from "vitest";
import { parseReadyReport, ReadyCheck } from "./readyCheck.ts";

const T = {
  timeoutMs: 30_000,
  graceMs: 5_000,
  cooldownMs: 5_000,
  giveUpCooldownMs: 60_000,
};
const members = ["a", "b", "c"];
const ctx = (now: number, eligible = true, m = members) => ({
  eligible,
  members: m,
  now,
});
const ready = { ready: true, buffering: false };
const notReady = { ready: false, buffering: false };
const stalled = (time?: number) => ({ ready: false, buffering: true, time });

function allReady(rc: ReadyCheck, now = 0) {
  for (const id of members) {
    rc.report(id, ready, ctx(now));
  }
}

describe("ReadyCheck", () => {
  it("starts when someone stalls, waits for them and anyone not ready, then resumes", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    rc.report("c", notReady, ctx(10));
    expect(rc.report("a", stalled(42.5), ctx(100))).toEqual({
      type: "start",
      reason: "buffering",
      trigger: "a",
      seekTo: 42.5,
    });
    expect(rc.getState()).toEqual({
      active: true,
      waitingFor: ["a", "c"],
      deadline: 30_100,
      reason: "buffering",
      trigger: "a",
    });
    expect(rc.report("a", ready, ctx(200))).toEqual({ type: "update" });
    expect(rc.getState().waitingFor).toEqual(["c"]);
    expect(rc.report("c", ready, ctx(300))).toEqual({
      type: "end",
      outcome: "ready",
      resume: true,
    });
    expect(rc.getState()).toEqual({
      active: false,
      waitingFor: [],
      outcome: "ready",
    });
  });

  it("doesn't start when not eligible (off, paused, share) or for a stall report that is ready", () => {
    const rc = new ReadyCheck(T);
    expect(rc.report("a", stalled(), ctx(0, false))).toBeNull();
    expect(rc.report("a", { ready: true, buffering: true }, ctx(0))).toBeNull();
    expect(rc.report("a", notReady, ctx(0))).toBeNull();
    expect(rc.isActive()).toBe(false);
  });

  it("resumes anyway after the timeout", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    rc.report("a", stalled(), ctx(0));
    expect(rc.tick(29_999, members)).toBeNull();
    expect(rc.tick(30_000, members)).toEqual({
      type: "end",
      outcome: "timeout",
      resume: true,
    });
  });

  it("skip resumes with the actor; cancel stops without resuming", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    expect(rc.skip("b", 0)).toBeNull();
    rc.report("a", stalled(), ctx(0));
    expect(rc.skip("b", 10)).toEqual({
      type: "end",
      outcome: "skipped",
      resume: true,
    });
    expect(rc.getState()).toMatchObject({ outcome: "skipped", actorId: "b" });

    rc.report("a", stalled(), ctx(70_000));
    expect(rc.cancel(70_010)).toEqual({
      type: "end",
      outcome: "cancelled",
      resume: false,
    });
    expect(rc.cancel(70_020)).toBeNull();
  });

  it("has a cooldown after a check so a slow viewer can't pause-loop the room", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    rc.report("a", stalled(), ctx(0));
    rc.report("a", ready, ctx(1000)); // ends at 1000
    expect(rc.report("a", stalled(), ctx(5_999))).toBeNull();
    expect(rc.report("a", stalled(), ctx(6_000))?.type).toBe("start");
    // After a timeout (or "Resume now") it waits a minute before pausing again
    rc.tick(36_000, members);
    expect(rc.report("a", stalled(), ctx(95_999))).toBeNull();
    expect(rc.report("a", stalled(), ctx(96_000))?.type).toBe("start");
  });

  it("a viewer leaving stops blocking", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    rc.report("b", notReady, ctx(0));
    rc.report("a", stalled(), ctx(0));
    expect(rc.leave("a", 10)).toEqual({ type: "update" });
    expect(rc.leave("b", 20)).toMatchObject({ type: "end", outcome: "ready" });
  });

  it("viewers who never report only block for the grace period", () => {
    const rc = new ReadyCheck(T);
    rc.report("a", ready, ctx(0));
    rc.report("b", ready, ctx(0));
    // c never reports
    rc.report("a", stalled(), ctx(100));
    expect(rc.getState().waitingFor).toEqual(["a", "c"]);
    rc.report("a", ready, ctx(200));
    expect(rc.tick(5_099, members)).toBeNull();
    expect(rc.tick(5_100, members)).toMatchObject({
      type: "end",
      outcome: "ready",
    });
  });

  it("joining mid-play waits for the joiner, but a quick reconnect doesn't", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    // Alone in the room: nothing to wait for
    expect(rc.join("z", ctx(0, true, ["z"]))).toBeNull();
    expect(rc.join("d", ctx(0, true, [...members, "d"]))).toEqual({
      type: "start",
      reason: "join",
      trigger: "d",
    });
    expect(rc.getState().waitingFor).toEqual(["d"]);
    rc.report("d", notReady, ctx(1000, true, [...members, "d"]));
    // Reported, so the grace period no longer applies
    expect(rc.tick(10_000, [...members, "d"])).toBeNull();
    expect(rc.report("d", ready, ctx(11_000))).toMatchObject({
      type: "end",
      outcome: "ready",
    });

    // b drops and comes back within 15 s while ready: no pause
    rc.leave("b", 20_000);
    expect(rc.join("b", ctx(25_000))).toBeNull();
    // ...but after a long absence it counts as joining
    rc.report("b", ready, ctx(25_100));
    rc.leave("b", 30_000);
    expect(rc.join("b", ctx(50_000))?.type).toBe("start");
  });

  it("a joiner during a check is added; one that never reports is dropped after the grace period", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    rc.report("a", stalled(), ctx(0));
    const m = [...members, "d"];
    expect(rc.join("d", ctx(1000, true, m))).toEqual({ type: "update" });
    expect(rc.getState().waitingFor).toEqual(["a", "d"]);
    rc.report("a", ready, ctx(2000, true, m));
    expect(rc.tick(6_000, m)).toMatchObject({ type: "end", outcome: "ready" });
  });

  it("someone who stops being ready during a check is added", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    rc.report("a", stalled(), ctx(0));
    expect(rc.report("b", notReady, ctx(10))).toEqual({ type: "update" });
    expect(rc.getState().waitingFor).toEqual(["a", "b"]);
    // Not a member (e.g. a stale socket): ignored
    expect(rc.report("x", notReady, ctx(20))).toBeNull();
  });

  it("disable ends an active check and resumes", () => {
    const rc = new ReadyCheck(T);
    expect(rc.disable(0)).toBeNull();
    allReady(rc);
    rc.report("a", stalled(), ctx(0));
    expect(rc.disable(10)).toEqual({
      type: "end",
      outcome: "cancelled",
      resume: true,
    });
  });

  it("reset (new video) cancels and forgets reports", () => {
    const rc = new ReadyCheck(T);
    allReady(rc);
    rc.report("a", stalled(), ctx(0));
    expect(rc.reset(10)).toMatchObject({ type: "end", outcome: "cancelled" });
    // No cooldown after a video change
    expect(rc.report("a", stalled(), ctx(20))?.type).toBe("start");
    // b and c haven't reported for this video yet: they wait for the grace period
    expect(rc.getState().waitingFor).toEqual(["a", "b", "c"]);
  });
});

describe("parseReadyReport", () => {
  it("accepts valid reports and drops junk", () => {
    expect(parseReadyReport({ ready: true })).toEqual({
      ready: true,
      buffering: false,
    });
    expect(
      parseReadyReport({ ready: false, buffering: true, time: 12.5 }),
    ).toEqual({ ready: false, buffering: true, time: 12.5 });
    expect(
      parseReadyReport({ ready: false, buffering: "yes", time: NaN }),
    ).toEqual({ ready: false, buffering: false });
    expect(parseReadyReport({ ready: "true" })).toBeNull();
    expect(parseReadyReport(null)).toBeNull();
    expect(parseReadyReport("ready")).toBeNull();
  });
});
