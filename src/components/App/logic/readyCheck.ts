// Ready check (PLAN 6d), client side: is this device ready to play, has it stalled long enough to count as
// buffering, and what to tell people. The server decides when to pause/resume (server/readyCheck.ts).

/** Seconds buffered ahead of the playhead that count as ready */
export const READY_AHEAD_SEC = 6;
/** Once ready, stay ready until the buffer drops under this (hysteresis, so the report doesn't flap) */
export const STAY_READY_AHEAD_SEC = 2;
/** A stall shorter than this during playback doesn't count as buffering */
export const STALL_DEBOUNCE_MS = 1500;
/** HTMLMediaElement.HAVE_ENOUGH_DATA */
const HAVE_ENOUGH_DATA = 4;

/** Seconds buffered from `time` to the end of the range that contains it (0 when `time` isn't buffered) */
export function bufferedAhead(
  ranges: { start: number; end: number }[],
  time: number,
): number {
  // Small tolerance: right after a seek the playhead can sit just before the first buffered frame
  const range = ranges.find((r) => r.start - 0.25 <= time && time <= r.end);
  return range ? Math.max(0, range.end - time) : 0;
}

export interface ReadinessInput {
  /** Nothing this device could block on: no media, screen/file share, live stream, or it can't play the video */
  notBlocking: boolean;
  loading: boolean;
  currentTime: number;
  duration: number;
  ranges: { start: number; end: number }[];
  /** <video>.readyState (undefined for YouTube) */
  readyState?: number;
  /** YouTube reports BUFFERING */
  ytBuffering?: boolean;
  /** Played through the in-browser converter: readyState isn't trusted, only what's actually converted */
  converting?: boolean;
  /** The previous answer (hysteresis) */
  wasReady?: boolean;
}

/** Whether this device has enough of the room's video buffered to play smoothly */
export function isReadyToPlay(input: ReadinessInput): boolean {
  if (input.notBlocking) {
    return true;
  }
  if (input.loading || input.ytBuffering) {
    return false;
  }
  const ahead = bufferedAhead(input.ranges, input.currentTime);
  const { duration } = input;
  if (
    Number.isFinite(duration) &&
    duration > 0 &&
    input.currentTime + ahead >= duration - 0.5 &&
    ahead > 0
  ) {
    // Buffered to the end
    return true;
  }
  if (
    !input.converting &&
    input.readyState !== undefined &&
    input.readyState >= HAVE_ENOUGH_DATA
  ) {
    return true;
  }
  return ahead >= (input.wasReady ? STAY_READY_AHEAD_SEC : READY_AHEAD_SEC);
}

/** Turns "is stalled right now" into "has been stalled for longer than STALL_DEBOUNCE_MS" */
export class StallDebounce {
  private since: number | null = null;
  private delayMs: number;

  constructor(delayMs = STALL_DEBOUNCE_MS) {
    this.delayMs = delayMs;
  }

  update(stalled: boolean, now: number): boolean {
    if (!stalled) {
      this.since = null;
      return false;
    }
    if (this.since === null) {
      this.since = now;
    }
    return now - this.since >= this.delayMs;
  }
}

/** "Sam", "Sam and Alex", "Sam, Alex and 2 others"; you are "you" */
export function formatNames(
  ids: string[],
  nameMap: StringDict,
  clientId: string,
): string {
  const names = ids.map((id) =>
    id === clientId ? "you" : nameMap[id] || "someone",
  );
  if (names.length === 0) {
    return "";
  }
  if (names.length === 1) {
    return names[0];
  }
  if (names.length <= 3) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/** The pill on the player: "Waiting for Sam, Alex…" */
export function waitingLabel(
  state: ReadyCheckState | null,
  nameMap: StringDict,
  clientId: string,
): string {
  if (!state?.active) {
    return "";
  }
  if (state.waitingFor.length === 0) {
    return "Getting ready…";
  }
  return `Waiting for ${formatNames(state.waitingFor, nameMap, clientId)}…`;
}

/**
 * What to toast when REC:readyCheck changes from `prev` to `next`, or null for nothing.
 * Start: "Paused — waiting for Sam to buffer". End: timeout and "Resume now" by someone else; a normal resume
 * (everyone ready) and a cancel (someone paused/played, which has its own toast) stay quiet.
 */
export function describeReadyCheckChange(
  prev: ReadyCheckState | null,
  next: ReadyCheckState,
  nameMap: StringDict,
  clientId: string,
): { text: string; tone: "warning" | "neutral" } | null {
  if (next.active && !prev?.active) {
    const who = formatNames(
      next.trigger ? [next.trigger] : next.waitingFor,
      nameMap,
      clientId,
    );
    if (!who) {
      return null;
    }
    const why = next.reason === "join" ? "load the video" : "buffer";
    return { text: `Paused — waiting for ${who} to ${why}`, tone: "warning" };
  }
  if (!next.active && prev?.active) {
    if (next.outcome === "timeout") {
      const who = formatNames(prev.waitingFor, nameMap, clientId);
      return {
        text: who
          ? `Resumed without waiting longer for ${who}`
          : "Resumed without waiting longer",
        tone: "warning",
      };
    }
    if (next.outcome === "skipped" && next.actorId !== clientId) {
      const name = (next.actorId && nameMap[next.actorId]) || "Someone";
      return { text: `${name} resumed without waiting`, tone: "neutral" };
    }
  }
  return null;
}
