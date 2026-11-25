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

/**
 * The playback rate that lets a viewer catch up with the leader: 1 when in sync, plus 0.01 per 100ms behind once
 * more than 0.5s behind, capped at 1.1. Viewers ahead of the leader play at 1 and get caught up with.
 */
export function getCatchUpPlaybackRate(leaderTime: number, ownTime: number) {
  const delta = leaderTime - ownTime;
  let rate = 1;
  if (delta > 0.5) {
    rate += Number((delta / 10).toFixed(2));
    rate = Math.min(rate, 1.1);
  }
  return rate;
}

/**
 * Whether automatic catch-up applies. Not for sources where viewers legitimately differ (live streams, WebRTC
 * shares) or when the room has a fixed playback rate (0 means "auto").
 */
export function shouldAutoSyncRate(state: {
  roomPaused: boolean;
  isLiveStream: boolean;
  hasDuration: boolean;
  roomPlaybackRate: number;
}) {
  return (
    !state.roomPaused &&
    !state.isLiveStream &&
    state.hasDuration &&
    state.roomPlaybackRate === 0
  );
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
