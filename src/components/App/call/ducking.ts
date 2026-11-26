// Movie ducking: while someone else in the call is speaking, play the movie 40 % quieter. The level multiplies the
// viewer's own volume (Player.setDuck), so their chosen volume is never overwritten.

/** Movie volume factor while ducked (40 % lower) */
export const DUCK_FACTOR = 0.6;

export const DUCK_TIMING = {
  /** Fade down over this long (fast, so the first words are clear) */
  attackMs: 200,
  /** Fade back up over this long (slow, so it doesn't pump between sentences) */
  releaseMs: 1200,
  /** Stay ducked this long after the last speech before fading back */
  holdMs: 400,
};

/** Moves `current` toward `target` linearly: the full range takes attackMs going down, releaseMs going up */
export function stepDuck(current: number, target: number, dtMs: number) {
  const range = 1 - DUCK_FACTOR;
  if (current > target) {
    return Math.max(target, current - (range * dtMs) / DUCK_TIMING.attackMs);
  }
  if (current < target) {
    return Math.min(target, current + (range * dtMs) / DUCK_TIMING.releaseMs);
  }
  return current;
}

/** The ducking state machine: call `update` on every tick; it returns the factor to apply (1 = full volume). */
export class Ducker {
  level = 1;
  private lastAt: number | null = null;
  private heldUntil = 0;

  update(
    input: { enabled: boolean; remoteSpeaking: boolean },
    now: number,
  ): number {
    const dt = this.lastAt === null ? 0 : Math.max(0, now - this.lastAt);
    this.lastAt = now;
    if (input.enabled && input.remoteSpeaking) {
      this.heldUntil = now + DUCK_TIMING.holdMs;
    }
    const target = input.enabled && now < this.heldUntil ? DUCK_FACTOR : 1;
    this.level = stepDuck(this.level, target, dt);
    return this.level;
  }

  /** Back to full volume at once (left the call) */
  reset() {
    this.level = 1;
    this.lastAt = null;
    this.heldUntil = 0;
  }
}
