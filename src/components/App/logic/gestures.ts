// Click/tap gestures on the video.

/** Single taps wait this long to tell them apart from a double-tap */
export const DOUBLE_TAP_MS = 260;

export type TapZone = "left" | "center" | "right";

/** Left 40 % / centre 20 % / right 40 % of the player width */
export function getTapZone(x: number, width: number): TapZone {
  if (!(width > 0)) {
    return "center";
  }
  const f = x / width;
  if (f < 0.4) {
    return "left";
  }
  if (f > 0.6) {
    return "right";
  }
  return "center";
}

/** Seconds to seek for a double-tap in a zone (centre toggles fullscreen instead) */
export function seekForZone(zone: TapZone): number {
  return zone === "left" ? -10 : zone === "right" ? 10 : 0;
}

/**
 * Tells single taps/clicks from double ones: `tap()` either fires onDouble immediately (second tap within the window)
 * or schedules onSingle after the window. Further taps after a double start a new sequence.
 */
export class TapDetector<T> {
  private pending: { timer: ReturnType<typeof setTimeout>; at: number } | null =
    null;
  private readonly onSingle: (info: T) => void;
  private readonly onDouble: (info: T) => void;
  private readonly windowMs: number;

  constructor(
    onSingle: (info: T) => void,
    onDouble: (info: T) => void,
    windowMs = DOUBLE_TAP_MS,
  ) {
    this.onSingle = onSingle;
    this.onDouble = onDouble;
    this.windowMs = windowMs;
  }

  tap(info: T, now = Date.now()) {
    if (this.pending && now - this.pending.at <= this.windowMs) {
      clearTimeout(this.pending.timer);
      this.pending = null;
      this.onDouble(info);
      return;
    }
    if (this.pending) {
      clearTimeout(this.pending.timer);
    }
    const timer = setTimeout(() => {
      this.pending = null;
      this.onSingle(info);
    }, this.windowMs);
    this.pending = { timer, at: now };
  }

  cancel() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
  }
}
