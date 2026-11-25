// Pure playback-sync math. Times are in seconds.
import { calculateMedian } from "../../../utils/utils";

/**
 * The room's reference position: the median of everyone's reported time when there are more than two people
 * (so one person far ahead or behind doesn't drag the room), otherwise the furthest-ahead time.
 */
export function getLeaderTime(participantCount: number, tsMap: NumberDict) {
  const times = Object.values(tsMap);
  if (participantCount > 2) {
    return calculateMedian(times);
  }
  return Math.max(...times);
}

/** Tuning for the drift controller (PLAN 6d "smoother sync"). Drift is in seconds, positive = behind the leader. */
export const DRIFT = {
  /** Start nudging the playback rate once we're this far off */
  enter: 0.3,
  /** Stop nudging once we're back within this (hysteresis, so the rate doesn't flap around `enter`) */
  exit: 0.1,
  /** Beyond this, seek instead of nudging */
  hardSeek: 2,
  /** Beyond this, seek when the rate can't be nudged (YouTube without fine-grained rates) */
  hardSeekNoNudge: 1,
  /** Rate change per second of drift (proportional): 1 s behind → +5 % */
  gain: 0.05,
  /** Never nudge by more than ±5 % (0.95–1.05× the room speed) */
  maxNudge: 0.05,
  /** After a seek our own reported time is stale for a couple of tsMap ticks, so wait before acting again */
  seekCooldownMs: 3000,
};

export interface DriftState {
  /** Whether we're currently nudging (between `enter` and `exit`) */
  correcting: boolean;
  /** No corrections before this time (ms) after a seek */
  cooldownUntil: number;
}

export const initialDriftState = (): DriftState => ({
  correcting: false,
  cooldownUntil: 0,
});

export type DriftAction =
  /** Play at `rate` (the room rate when in sync, a nudged rate when catching up) */
  | { type: "rate"; rate: number }
  /** Seek to the leader, and play at `rate` (the room rate) */
  | { type: "seek"; rate: number };

/**
 * One step of the drift controller, run on every REC:tsMap (about once per second). Small drift is corrected by
 * nudging the playback rate proportionally to the drift (0.95–1.05× the room speed) without a visible jump, large drift
 * by seeking. `allowedRates` limits the rates a player supports (YouTube); when no supported rate is a usable nudge,
 * only seeks are used, with a lower threshold.
 */
export function nextDriftAction(
  state: DriftState,
  input: {
    /** Leader time minus our time, in seconds (positive = we're behind) */
    drift: number;
    /** The room's playback rate (1 unless someone changed the speed) */
    baseRate: number;
    now: number;
    allowedRates?: number[];
  },
): { state: DriftState; action: DriftAction } {
  const base = input.baseRate > 0 ? input.baseRate : 1;
  const { drift, now } = input;
  const steady = (st: DriftState) => ({
    state: st,
    action: { type: "rate" as const, rate: base },
  });
  if (!Number.isFinite(drift) || now < state.cooldownUntil) {
    return steady({ ...state, correcting: false });
  }
  const nudge = (rate: number) => pickNudgeRate(rate, base, input.allowedRates);
  // Whether a nudge in the right direction is possible at all
  const canNudge =
    nudge(base * (1 + Math.sign(drift || 1) * DRIFT.maxNudge)) !== base;
  const seekAt = canNudge ? DRIFT.hardSeek : DRIFT.hardSeekNoNudge;
  const abs = Math.abs(drift);
  if (abs >= seekAt) {
    return {
      state: { correcting: false, cooldownUntil: now + DRIFT.seekCooldownMs },
      action: { type: "seek", rate: base },
    };
  }
  const correcting = state.correcting ? abs > DRIFT.exit : abs > DRIFT.enter;
  if (!correcting || !canNudge) {
    return steady({ ...state, correcting: false });
  }
  const delta = Math.max(
    -DRIFT.maxNudge,
    Math.min(DRIFT.maxNudge, DRIFT.gain * drift),
  );
  return {
    state: { ...state, correcting: true },
    action: { type: "rate", rate: nudge(base * (1 + delta)) },
  };
}

/**
 * Rounds a wanted rate to 0.01, or (when the player only supports some rates) picks the supported rate closest to it
 * that stays within 0.95–1.05× the base and on the same side of it. Falls back to the base rate.
 */
export function pickNudgeRate(
  wanted: number,
  base: number,
  allowedRates?: number[],
) {
  const lo = base * (1 - DRIFT.maxNudge) - 1e-9;
  const hi = base * (1 + DRIFT.maxNudge) + 1e-9;
  if (!allowedRates) {
    return Math.round(Math.min(hi, Math.max(lo, wanted)) * 100) / 100;
  }
  const side = Math.sign(wanted - base);
  const candidates = allowedRates.filter(
    (r) => r >= lo && r <= hi && Math.sign(r - base) === side && side !== 0,
  );
  if (!candidates.length) {
    return base;
  }
  return candidates.reduce((best, r) =>
    Math.abs(r - wanted) < Math.abs(best - wanted) ? r : best,
  );
}

export type SyncStatus =
  | { kind: "in-sync" }
  /** `behind` is in seconds (negative when ahead of the room) */
  | { kind: "catching-up"; behind: number }
  | { kind: "buffering" }
  | { kind: "reconnecting" };

/** What the sync indicator shows: reconnecting beats buffering beats drift. */
export function getSyncStatus(opts: {
  connected: boolean;
  buffering: boolean;
  correcting: boolean;
  drift: number;
}): SyncStatus {
  if (!opts.connected) {
    return { kind: "reconnecting" };
  }
  if (opts.buffering) {
    return { kind: "buffering" };
  }
  if (opts.correcting && Number.isFinite(opts.drift)) {
    return { kind: "catching-up", behind: Math.round(opts.drift * 10) / 10 };
  }
  return { kind: "in-sync" };
}

export const isSameSyncStatus = (a: SyncStatus, b: SyncStatus) =>
  a.kind === b.kind &&
  (a.kind !== "catching-up" ||
    (b.kind === "catching-up" && a.behind === b.behind));

/**
 * Whether automatic drift correction applies. Not for sources where viewers legitimately differ (live streams, WebRTC
 * shares), or while paused.
 */
export function shouldAutoSyncRate(state: {
  roomPaused: boolean;
  isLiveStream: boolean;
  hasDuration: boolean;
}) {
  return !state.roomPaused && !state.isLiveStream && state.hasDuration;
}

/** One person's position relative to the room leader, for the sync popover */
export function describePeerSync(drift: number | undefined): {
  tone: "success" | "warning";
  label: string;
} {
  if (drift === undefined || !Number.isFinite(drift)) {
    return { tone: "warning", label: "Waiting for position…" };
  }
  const abs = Math.abs(drift);
  if (abs <= DRIFT.enter) {
    return { tone: "success", label: "In sync" };
  }
  const secs = abs.toFixed(1);
  return {
    tone: "warning",
    label: drift > 0 ? `${secs} s behind` : `${secs} s ahead`,
  };
}

/**
 * Converts a local player time to the timestamp sent to the room. For live streams clients have different durations,
 * so the room uses the (negative) offset from the live edge instead.
 */
export function toRoomTime(
  time: number,
  isLiveStream: boolean,
  duration: number,
) {
  return isLiveStream ? time - duration : time;
}

/**
 * Where to seek locally to follow the room: a given room time, or the leader's time when none is given. For live
 * streams the room time is an offset from the live edge. Returns undefined when there's no valid target.
 */
export function getLocalSeekTarget(opts: {
  roomTime?: number;
  leaderTime: number;
  isLiveStream: boolean;
  duration: number;
}): number | undefined {
  let target = opts.roomTime ?? opts.leaderTime;
  if (opts.isLiveStream) {
    target = opts.duration + (opts.roomTime ?? 0);
  }
  if (target >= 0 && target < Infinity) {
    return target;
  }
  return undefined;
}

/**
 * The duration to use for the controls and seeking. For a live stream this is the live edge on the same timeline as
 * the current time: hls.js reports it as the duration, dash.js leaves Infinity so use the end of the seekable range.
 */
export function getEffectiveDuration(
  duration: number,
  isLiveStream: boolean,
  seekable?: { length: number; end: (index: number) => number },
) {
  if (isLiveStream && duration === Infinity && seekable?.length) {
    return seekable.end(seekable.length - 1);
  }
  return duration;
}
