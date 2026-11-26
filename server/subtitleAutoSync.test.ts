import { describe, expect, it } from "vitest";
import {
  parseSubtitleSyncCommand,
  SUBTITLE_SYNC_CLAIM_TTL_MS,
  SUBTITLE_SYNC_MAX_ATTEMPTS,
  SubtitleAutoSync,
} from "./subtitleAutoSync.ts";

const V = "https://cdn.example.com/movie.mkv";
const K = "room:https://subs.example.com/a.srt";
const on = (now = 0) => ({ enabled: true, video: V, now });

const fresh = (savedTiming = false) => {
  const s = new SubtitleAutoSync();
  s.reset(V, savedTiming);
  return s;
};

describe("parseSubtitleSyncCommand", () => {
  it("accepts the three actions", () => {
    expect(
      parseSubtitleSyncCommand({ action: "claim", video: V, key: K }),
    ).toEqual({ action: "claim", video: V, key: K });
    expect(
      parseSubtitleSyncCommand({ action: "failed", video: V, key: K }),
    ).toEqual({ action: "failed", video: V, key: K });
    expect(
      parseSubtitleSyncCommand({
        action: "result",
        video: V,
        key: K,
        offset: 2.35,
        confidence: 7,
      }),
    ).toEqual({
      action: "result",
      video: V,
      key: K,
      offset: 2.35,
      confidence: 1,
    });
    expect(
      parseSubtitleSyncCommand({
        action: "result",
        video: V,
        key: K,
        offset: null,
      }),
    ).toMatchObject({ offset: null });
  });

  it("accepts an optional time scale and rejects a bad one", () => {
    expect(
      parseSubtitleSyncCommand({
        action: "result",
        video: V,
        key: K,
        offset: 1,
        scale: 0.959041,
      }),
    ).toMatchObject({ scale: 0.959041 });
    expect(
      parseSubtitleSyncCommand({
        action: "result",
        video: V,
        key: K,
        offset: 1,
        scale: 1.5,
      }),
    ).toBeUndefined();
  });

  it("rejects junk", () => {
    for (const raw of [
      null,
      "claim",
      [],
      { action: "claim", video: V },
      { action: "claim", video: "", key: K },
      { action: "claim", video: V, key: "x".repeat(2001) },
      { action: "nope", video: V, key: K },
      { action: "result", video: V, key: K, offset: "2" },
      { action: "result", video: V, key: K, offset: NaN },
      { action: "result", video: V, key: K },
    ]) {
      expect(parseSubtitleSyncCommand(raw)).toBeUndefined();
    }
  });
});

describe("SubtitleAutoSync", () => {
  it("grants the first claim and denies the others", () => {
    const s = fresh();
    expect(s.claim("a", { video: V, key: K }, on())).toEqual({
      granted: true,
    });
    expect(s.claim("b", { video: V, key: K }, on())).toEqual({
      granted: false,
      reason: "busy",
    });
    expect(s.claim("a", { video: V, key: K }, on())).toEqual({
      granted: false,
      reason: "busy",
    });
    // Another subtitle is its own job
    expect(s.claim("b", { video: V, key: "room:other" }, on())).toEqual({
      granted: true,
    });
  });

  it("refuses when the setting is off or the video is stale", () => {
    const s = fresh();
    expect(
      s.claim("a", { video: V, key: K }, { ...on(), enabled: false }),
    ).toMatchObject({ reason: "off" });
    expect(
      s.claim("a", { video: "https://x.example.com/old.mp4", key: K }, on()),
    ).toMatchObject({ reason: "stale" });
  });

  it("applies the claimer's result once, then the job is done", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on());
    // Not the claimer: ignored
    expect(s.result("b", { video: V, key: K, offset: 1 }, on())).toBeNull();
    expect(s.result("a", { video: V, key: K, offset: 2.35 }, on())).toEqual({
      apply: true,
    });
    expect(s.getOffsetSource()).toBe("auto");
    expect(s.isDone(K)).toBe(true);
    expect(s.result("a", { video: V, key: K, offset: 2.35 }, on())).toBeNull();
    expect(s.claim("b", { video: V, key: K }, on())).toMatchObject({
      reason: "done",
    });
  });

  it("an unconfident result finishes the job without applying anything", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on());
    expect(s.result("a", { video: V, key: K, offset: null }, on())).toEqual({
      apply: false,
    });
    expect(s.getOffsetSource()).toBe("none");
  });

  it("never overrides an offset set by hand", () => {
    // Saved non-zero offset loaded with the video
    expect(fresh(true).claim("a", { video: V, key: K }, on())).toMatchObject({
      reason: "manual",
    });
    // Someone typed an offset before anyone claimed
    const s = fresh();
    s.manualOffset();
    expect(s.claim("a", { video: V, key: K }, on())).toMatchObject({
      reason: "manual",
    });
    // …or while it was computing
    const t = fresh();
    t.claim("a", { video: V, key: K }, on());
    t.manualOffset();
    expect(t.result("a", { video: V, key: K, offset: 3 }, on())).toEqual({
      apply: false,
    });
    // A saved offset restored when the metadata arrives counts too
    const u = fresh();
    u.offsetLoaded(false);
    expect(u.getOffsetSource()).toBe("none");
    u.offsetLoaded(true);
    expect(u.claim("a", { video: V, key: K }, on())).toMatchObject({
      reason: "manual",
    });
  });

  it("an offset from auto-sync doesn't block a new subtitle", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on());
    s.result("a", { video: V, key: K, offset: 4 }, on());
    expect(s.claim("b", { video: V, key: "room:new" }, on())).toEqual({
      granted: true,
    });
  });

  it("doesn't apply after the setting was turned off", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on());
    expect(
      s.result(
        "a",
        { video: V, key: K, offset: 1 },
        { ...on(), enabled: false },
      ),
    ).toEqual({ apply: false });
  });

  it("releases a failed or abandoned job for someone else, up to 3 tries", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on());
    expect(s.failed("b", { video: V, key: K })).toBe(false);
    expect(s.failed("a", { video: V, key: K })).toBe(true);
    expect(s.claim("b", { video: V, key: K }, on())).toEqual({
      granted: true,
    });
    expect(s.leave("b")).toEqual([{ key: K, status: "released" }]);
    expect(s.claim("c", { video: V, key: K }, on())).toEqual({
      granted: true,
    });
    expect(SUBTITLE_SYNC_MAX_ATTEMPTS).toBe(3);
    // Third failure: given up for this video
    expect(s.failed("c", { video: V, key: K })).toBe(false);
    expect(s.isDone(K)).toBe(true);
    expect(s.claim("d", { video: V, key: K }, on())).toMatchObject({
      reason: "done",
    });
  });

  it("a claim without a result expires (via expireStale)", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on(0));
    expect(s.claim("b", { video: V, key: K }, on(1000))).toMatchObject({
      reason: "busy",
    });
    expect(s.expireStale(SUBTITLE_SYNC_CLAIM_TTL_MS)).toEqual([]);
    // Still busy until the sweep ends it, so every end gets announced
    expect(
      s.claim("b", { video: V, key: K }, on(SUBTITLE_SYNC_CLAIM_TTL_MS + 1)),
    ).toMatchObject({ reason: "busy" });
    expect(s.expireStale(SUBTITLE_SYNC_CLAIM_TTL_MS + 1)).toEqual([
      { key: K, status: "released" },
    ]);
    expect(s.expireStale(SUBTITLE_SYNC_CLAIM_TTL_MS + 2)).toEqual([]);
    expect(
      s.claim("b", { video: V, key: K }, on(SUBTITLE_SYNC_CLAIM_TTL_MS + 1)),
    ).toEqual({ granted: true });
    // The late result from "a" no longer counts
    expect(s.result("a", { video: V, key: K, offset: 1 }, on())).toBeNull();
  });

  it("the last attempt ending without a result (left or expired) is reported as done", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on(0));
    s.failed("a", { video: V, key: K });
    s.claim("b", { video: V, key: K }, on(0));
    s.failed("b", { video: V, key: K });
    s.claim("c", { video: V, key: K }, on(0));
    expect(s.leave("c")).toEqual([{ key: K, status: "done" }]);
    expect(s.isDone(K)).toBe(true);

    const t = fresh();
    t.claim("a", { video: V, key: K }, on(0));
    t.leave("a");
    t.claim("b", { video: V, key: K }, on(0));
    t.leave("b");
    t.claim("c", { video: V, key: K }, on(0));
    expect(t.expireStale(SUBTITLE_SYNC_CLAIM_TTL_MS + 1)).toEqual([
      { key: K, status: "done" },
    ]);
    expect(t.claim("d", { video: V, key: K }, on(0))).toMatchObject({
      reason: "done",
    });
  });

  it("a new video forgets everything", () => {
    const s = fresh();
    s.claim("a", { video: V, key: K }, on());
    s.manualOffset();
    const W = "https://cdn.example.com/next.mkv";
    s.reset(W, false);
    expect(
      s.claim("a", { video: W, key: K }, { enabled: true, video: W, now: 0 }),
    ).toEqual({ granted: true });
    expect(s.failed("a", { video: V, key: K })).toBe(false);
  });
});
