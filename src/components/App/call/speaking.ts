// Speaking detection for the voice call, done locally from audio levels (no server traffic).

/** RMS level of time-domain samples (-1..1) in dBFS; -100 for silence */
export function rmsDb(samples: ArrayLike<number>): number {
  if (!samples.length) {
    return -100;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/** 0..1 for a level meter: -60 dBFS (quiet room) → 0, -10 dBFS (loud) → 1 */
export const meterLevel = (db: number) =>
  Math.min(1, Math.max(0, (db + 60) / 50));

export interface SpeakingOptions {
  /** Start speaking above this level… */
  onDb: number;
  /** …held for this long */
  attackMs: number;
  /** Stop below this (lower) level… */
  offDb: number;
  /** …held for this long, so pauses between words don't flicker */
  releaseMs: number;
}

export const SPEAKING_DEFAULTS: SpeakingOptions = {
  onDb: -48,
  attackMs: 80,
  offDb: -56,
  releaseMs: 500,
};

/** Hysteresis on level and time: separate start/stop thresholds, each held for a while before it flips */
export class SpeakingDetector {
  speaking = false;
  private since: number | null = null;
  private opts: SpeakingOptions;

  constructor(opts: Partial<SpeakingOptions> = {}) {
    this.opts = { ...SPEAKING_DEFAULTS, ...opts };
  }

  update(db: number, now: number): boolean {
    const { onDb, offDb, attackMs, releaseMs } = this.opts;
    const crossing = this.speaking ? db < offDb : db >= onDb;
    if (!crossing) {
      this.since = null;
      return this.speaking;
    }
    this.since ??= now;
    if (now - this.since >= (this.speaking ? releaseMs : attackMs)) {
      this.speaking = !this.speaking;
      this.since = null;
    }
    return this.speaking;
  }

  reset() {
    this.speaking = false;
    this.since = null;
  }
}
