// Space: a tap toggles play/pause, holding it plays the room at 2× until it's released (like YouTube).

/** How long Space must be held before it counts as a hold instead of a tap */
export const SPACE_HOLD_MS = 300;
/** The playback rate while Space is held */
export const SPACE_HOLD_RATE = 2;

export interface SpaceHoldOptions {
  /** Space was tapped (released before the hold delay) */
  onTap: () => void;
  /** Space has been held long enough; return false when a hold isn't possible right now (paused, live, ...): the release then counts as a tap */
  onHoldStart: () => boolean;
  /** A hold that started has ended (released, window blurred or disposed) */
  onHoldEnd: () => void;
  delayMs?: number;
}

/**
 * Tracks one Space press. Call `down()` on every Space keydown (auto-repeats are ignored), `up()` on keyup and
 * `cancel()` when the window loses focus (a keyup may never come).
 */
export class SpaceHold {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pressed = false;
  private holding = false;
  private readonly opts: SpaceHoldOptions;

  constructor(opts: SpaceHoldOptions) {
    this.opts = opts;
  }

  /** Whether a press is in progress (its keyup belongs to us) */
  get active() {
    return this.pressed;
  }

  down() {
    if (this.pressed) {
      return;
    }
    this.pressed = true;
    this.holding = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.holding = this.opts.onHoldStart();
    }, this.opts.delayMs ?? SPACE_HOLD_MS);
  }

  up() {
    if (!this.pressed) {
      return;
    }
    const wasHolding = this.holding;
    this.reset();
    if (wasHolding) {
      this.opts.onHoldEnd();
    } else {
      this.opts.onTap();
    }
  }

  /** Ends a press without a tap (window blur, unmount); a running hold is ended */
  cancel() {
    const wasHolding = this.holding;
    this.reset();
    if (wasHolding) {
      this.opts.onHoldEnd();
    }
  }

  private reset() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pressed = false;
    this.holding = false;
  }
}
