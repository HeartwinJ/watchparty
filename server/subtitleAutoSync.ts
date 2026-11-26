/**
 * Room auto-sync of subtitles (RoomSettings.autoSyncSubtitles): which viewer computes it, and whether its result may
 * be applied. The alignment itself runs in a browser (src/components/App/subsync/); the server only arbitrates.
 *
 * Per (video, subtitle key):
 *   none ──claim (setting on, video current, offset not set by hand)──▶ running {by}   → REC:subtitleSync running
 *   running ──result from `by`──▶ done (offset applied room-wide unless someone set one by hand meanwhile)
 *   running ──failed from `by` / `by` left / 3 min without a result──▶ released (anyone may claim again; 3 tries)
 *     after the 3rd try it's done instead (offset null). The room announces every end of a running job to everyone
 *     (REC:subtitleSync released / done), so no viewer keeps showing "X is syncing…".
 *   any other claim ──▶ denied (to that viewer only)
 * A new video clears everything. The state is in memory only: after a restart a saved non-zero offset still counts
 * as set by hand, so nothing is redone over it.
 *
 * "Set by hand": any CMD:subtitleOffset for the current video, or a saved non-zero offset loaded with the video
 * (we can't tell how it was made). An offset applied by auto-sync doesn't block a later subtitle from re-syncing.
 */
import { normalizeSubtitleScale } from "./utils/subtitleOffset.ts";

export const SUBTITLE_SYNC_KEY_MAX = 2000;
/** A claim without a result after this long is given up (the worker has its own stall timeout well below this) */
export const SUBTITLE_SYNC_CLAIM_TTL_MS = 3 * 60_000;
export const SUBTITLE_SYNC_MAX_ATTEMPTS = 3;
/** Distinct subtitle keys tracked per video (bounds memory against a client making up keys) */
const MAX_KEYS = 50;

export type OffsetSource = "none" | "auto" | "manual";

type Entry =
  | { status: "running"; by: string; at: number; attempts: number }
  | { status: "released"; attempts: number }
  | { status: "done" };

export interface SubtitleSyncContext {
  enabled: boolean;
  video: string | null;
  now: number;
}

/** Validates an untrusted CMD:subtitleSync payload */
export function parseSubtitleSyncCommand(
  raw: unknown,
): SubtitleSyncCommand | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const d = raw as Record<string, unknown>;
  if (
    typeof d.video !== "string" ||
    !d.video ||
    d.video.length > 50000 ||
    typeof d.key !== "string" ||
    !d.key ||
    d.key.length > SUBTITLE_SYNC_KEY_MAX
  ) {
    return undefined;
  }
  const base = { video: d.video, key: d.key };
  switch (d.action) {
    case "claim":
      return { action: "claim", ...base };
    case "failed":
      return { action: "failed", ...base };
    case "result": {
      const offset =
        d.offset === null
          ? null
          : typeof d.offset === "number" && Number.isFinite(d.offset)
            ? d.offset
            : undefined;
      if (offset === undefined) {
        return undefined;
      }
      const confidence =
        typeof d.confidence === "number" && Number.isFinite(d.confidence)
          ? Math.max(0, Math.min(1, d.confidence))
          : undefined;
      // Optional time scale (frame-rate drift); an invalid one rejects the result
      let scale: number | undefined;
      if (d.scale !== undefined) {
        scale = normalizeSubtitleScale(d.scale);
        if (scale === undefined) {
          return undefined;
        }
      }
      return {
        action: "result",
        ...base,
        offset,
        confidence,
        ...(scale !== undefined ? { scale } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** How a running job ended without a result: free for another try, or given up (out of attempts) */
export interface SubtitleSyncEnd {
  key: string;
  status: "released" | "done";
}

export type ClaimOutcome =
  | { granted: true }
  | { granted: false; reason: NonNullable<SubtitleSyncEvent["reason"]> };

export class SubtitleAutoSync {
  private video: string | null = null;
  private entries = new Map<string, Entry>();
  /** How the room's current offset came about */
  private offsetSource: OffsetSource = "none";

  /** The room's video changed: forget everything. `savedTiming`: a non-default offset/scale was loaded with it. */
  reset(video: string | null, savedTiming: boolean) {
    this.video = video;
    this.entries.clear();
    this.offsetSource = savedTiming ? "manual" : "none";
  }

  /** A saved timing was restored for the same video (e.g. its metadata arrived) */
  offsetLoaded(savedTiming: boolean) {
    if (savedTiming) {
      this.offsetSource = "manual";
    }
  }

  /** Someone set the offset by hand (CMD:subtitleOffset, including the manual wand) */
  manualOffset() {
    this.offsetSource = "manual";
  }

  getOffsetSource() {
    return this.offsetSource;
  }

  claim(
    clientId: string,
    cmd: { video: string; key: string },
    ctx: SubtitleSyncContext,
  ): ClaimOutcome {
    if (!ctx.enabled) {
      return { granted: false, reason: "off" };
    }
    if (!ctx.video || cmd.video !== ctx.video || cmd.video !== this.video) {
      return { granted: false, reason: "stale" };
    }
    if (this.offsetSource === "manual") {
      return { granted: false, reason: "manual" };
    }
    // An expired claim stays "busy" until expireStale() (the room's 1 s timer) ends and announces it
    const entry = this.entries.get(cmd.key);
    if (entry?.status === "done") {
      return { granted: false, reason: "done" };
    }
    if (entry?.status === "running") {
      return { granted: false, reason: "busy" };
    }
    if (!entry && this.entries.size >= MAX_KEYS) {
      return { granted: false, reason: "busy" };
    }
    const attempts = (entry?.attempts ?? 0) + 1;
    this.entries.set(cmd.key, {
      status: "running",
      by: clientId,
      at: ctx.now,
      attempts,
    });
    return { granted: true };
  }

  /**
   * The claimer's result. Returns whether to apply `offset` room-wide (`apply`) and whether the job is now finished
   * (`done`: announce it); null when the result doesn't come from the current claimer (ignored).
   */
  result(
    clientId: string,
    cmd: { video: string; key: string; offset: number | null },
    ctx: SubtitleSyncContext,
  ): { apply: boolean } | null {
    const entry = this.entries.get(cmd.key);
    if (
      cmd.video !== this.video ||
      ctx.video !== this.video ||
      entry?.status !== "running" ||
      entry.by !== clientId
    ) {
      return null;
    }
    this.entries.set(cmd.key, { status: "done" });
    // Someone set the offset by hand while this was computing (or the setting was turned off): don't override it
    const apply =
      cmd.offset !== null && ctx.enabled && this.offsetSource !== "manual";
    if (apply) {
      this.offsetSource = "auto";
    }
    return { apply };
  }

  /** The claimer couldn't compute it. Returns true when the key was released for someone else. */
  failed(clientId: string, cmd: { video: string; key: string }): boolean {
    const entry = this.entries.get(cmd.key);
    if (
      cmd.video !== this.video ||
      entry?.status !== "running" ||
      entry.by !== clientId
    ) {
      return false;
    }
    return this.release(cmd.key, entry.attempts);
  }

  /** A viewer left: end whatever they were computing (released, or done when out of attempts) */
  leave(clientId: string): SubtitleSyncEnd[] {
    const ended: SubtitleSyncEnd[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.status === "running" && entry.by === clientId) {
        ended.push({
          key,
          status: this.release(key, entry.attempts) ? "released" : "done",
        });
      }
    }
    return ended;
  }

  /** Claims without a result for SUBTITLE_SYNC_CLAIM_TTL_MS: given up like a failure. Call regularly. */
  expireStale(now: number): SubtitleSyncEnd[] {
    const ended: SubtitleSyncEnd[] = [];
    for (const [key, entry] of this.entries) {
      if (
        entry.status === "running" &&
        now - entry.at > SUBTITLE_SYNC_CLAIM_TTL_MS
      ) {
        ended.push({
          key,
          status: this.release(key, entry.attempts) ? "released" : "done",
        });
      }
    }
    return ended;
  }

  getVideo() {
    return this.video;
  }

  /** Whether this subtitle is finished for the current video (synced, unconfident, or out of attempts) */
  isDone(key: string) {
    return this.entries.get(key)?.status === "done";
  }

  private release(key: string, attempts: number) {
    if (attempts >= SUBTITLE_SYNC_MAX_ATTEMPTS) {
      this.entries.set(key, { status: "done" });
      return false;
    }
    this.entries.set(key, { status: "released", attempts });
    return true;
  }
}
