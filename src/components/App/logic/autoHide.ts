// Auto-hide for the player controls and cursor.

export const IDLE_HIDE_MS = 2500;
/** When the pointer leaves the player while playing, hide sooner */
export const LEAVE_HIDE_MS = 500;

/** Reasons the controls must stay visible */
export type HoldReason =
  "paused" | "hover-controls" | "menu" | "quick-chat" | "focus";

/**
 * Tracks activity and calls onChange(idle) when the controls should hide (idle = true) or show. Activity (`poke`)
 * shows them and restarts the timer; any active hold keeps them visible and stops the timer. Pure apart from
 * setTimeout, so it's testable with fake timers.
 */
export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private holds = new Set<HoldReason>();
  private idle = false;
  private readonly delay: number;
  private readonly onChange: (idle: boolean) => void;

  constructor(onChange: (idle: boolean) => void, delay = IDLE_HIDE_MS) {
    this.onChange = onChange;
    this.delay = delay;
  }

  isIdle() {
    return this.idle;
  }

  /** Mouse move, tap or key press */
  poke(delay = this.delay) {
    this.setIdle(false);
    this.schedule(delay);
  }

  /** Hide now (e.g. a tap on the video while the controls are showing) unless something holds them */
  hideNow() {
    this.clear();
    if (this.holds.size === 0) {
      this.setIdle(true);
    }
  }

  setHold(reason: HoldReason, held: boolean) {
    const had = this.holds.has(reason);
    if (held === had) {
      return;
    }
    if (held) {
      this.holds.add(reason);
      this.clear();
      this.setIdle(false);
    } else {
      this.holds.delete(reason);
      this.schedule(this.delay);
    }
  }

  dispose() {
    this.clear();
  }

  private schedule(delay: number) {
    this.clear();
    if (this.holds.size > 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.holds.size === 0) {
        this.setIdle(true);
      }
    }, delay);
  }

  private clear() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private setIdle(idle: boolean) {
    if (this.idle !== idle) {
      this.idle = idle;
      this.onChange(idle);
    }
  }
}
