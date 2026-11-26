// Auto subtitle sync: the signal processing (ffsubsync-style). Pure and dependency-free so it runs in the worker,
// in unit tests and in Node scripts alike.
//
//   audio ──► SpeechActivityMeter (speech-band energy per 10 ms frame) ──► speechActivity() (0..1 per frame)
//   cues  ──► cueSignal() (1 inside a cue, 0 outside, same frames)
//   both  ──► alignWindows(): FFT cross-correlation per audio window, summed over windows, best lag + confidence
//
// Positive offsets mean "subtitles appear later" (the same sign as the subtitle offset in the menu).

/** 10 ms frames: fine enough for 0.05 s results, coarse enough for a fast FFT over ±10 min */
export const FRAME_SEC = 0.01;

/** Where the speech band starts/ends (Hz), roughly telephone bandwidth */
const SPEECH_LOW_HZ = 300;
const SPEECH_HIGH_HZ = 3400;

/** Below this (dBFS, speech band) a frame is silence however low the noise floor gets */
const SILENCE_DB = -65;

/** A second-order IIR section (RBJ cookbook), run sample by sample with its state kept between chunks */
class Biquad {
  private b0: number;
  private b1: number;
  private b2: number;
  private a1: number;
  private a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type: "lowpass" | "highpass", freq: number, sampleRate: number) {
    const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2); // Q = 1/√2 (Butterworth)
    const a0 = 1 + alpha;
    if (type === "lowpass") {
      this.b0 = (1 - cos) / 2 / a0;
      this.b1 = (1 - cos) / a0;
      this.b2 = this.b0;
    } else {
      this.b0 = (1 + cos) / 2 / a0;
      this.b1 = -(1 + cos) / a0;
      this.b2 = this.b0;
    }
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number) {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Streams mono audio in and gives the speech-band (300–3400 Hz) energy of every 10 ms frame, in dBFS. Filtering at
 * the source rate is cheaper than resampling first, and the band filter does the anti-aliasing job anyway.
 * Chunks can have any length; a partial frame is carried over to the next push().
 */
export class SpeechActivityMeter {
  readonly sampleRate: number;
  private readonly frameLen: number;
  private readonly hp: Biquad[];
  private readonly lp: Biquad[];
  private acc = 0;
  private count = 0;
  private energies: number[] = [];

  constructor(sampleRate: number, frameSec = FRAME_SEC) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.max(1, Math.round(sampleRate * frameSec));
    // Two sections each side: 24 dB/octave keeps rumble, explosions and hiss out of the band
    this.hp = [0, 1].map(
      () => new Biquad("highpass", SPEECH_LOW_HZ, sampleRate),
    );
    this.lp = [0, 1].map(
      () => new Biquad("lowpass", SPEECH_HIGH_HZ, sampleRate),
    );
  }

  /** Mono samples in [-1, 1] */
  push(samples: ArrayLike<number>) {
    const [hp1, hp2] = this.hp;
    const [lp1, lp2] = this.lp;
    for (let i = 0; i < samples.length; i++) {
      const y = lp2.process(lp1.process(hp2.process(hp1.process(samples[i]))));
      this.acc += y * y;
      if (++this.count === this.frameLen) {
        this.energies.push(10 * Math.log10(this.acc / this.count + 1e-12));
        this.acc = 0;
        this.count = 0;
      }
    }
  }

  /** Energy per complete frame so far, in dBFS (a full-scale sine in the band is about -3 dB) */
  frames(): Float32Array {
    return Float32Array.from(this.energies);
  }
}

/** Averages interleaved/planar channels into one (in place into `out`, which must be `frames` long) */
export function downmix(channels: Float32Array[], out: Float32Array) {
  const n = channels.length;
  out.fill(0);
  for (const ch of channels) {
    for (let i = 0; i < out.length; i++) {
      out[i] += ch[i] / n;
    }
  }
  return out;
}

export interface ActivityOptions {
  /** How far above the noise floor (dB) a frame has to be to count as speech (soft: half-way at this value) */
  thresholdDb?: number;
  /** dB over which the decision goes from 0 to 1 */
  softnessDb?: number;
  /** How fast the noise floor may rise (dB per second); it falls immediately */
  floorRiseDbPerSec?: number;
  /** Moving-average length in frames */
  smoothFrames?: number;
}

/**
 * Voice activity from speech-band frame energies: an adaptive noise floor (follows quiet passages down at once,
 * creeps up slowly through loud ones), a soft threshold above it, then a short moving average. Returns 0..1 per
 * frame. Crude next to a trained VAD, but the alignment only needs it to correlate with dialogue on average.
 */
export function speechActivity(
  energiesDb: Float32Array,
  opts: ActivityOptions = {},
): Float32Array {
  const threshold = opts.thresholdDb ?? 12;
  const softness = opts.softnessDb ?? 6;
  const rise = (opts.floorRiseDbPerSec ?? 1.5) * FRAME_SEC;
  const smooth = Math.max(1, opts.smoothFrames ?? 7);
  const n = energiesDb.length;
  const raw = new Float32Array(n);
  // Start the floor at a low percentile, so the first second isn't all "speech"
  let floor = n ? percentile(energiesDb, 0.1) : SILENCE_DB;
  for (let i = 0; i < n; i++) {
    const e = energiesDb[i];
    floor = e < floor ? e : floor + rise;
    if (e < SILENCE_DB) {
      raw[i] = 0;
      continue;
    }
    const x = (e - floor - threshold) / softness;
    raw[i] = 1 / (1 + Math.exp(-x));
  }
  // Centered moving average
  const out = new Float32Array(n);
  const half = Math.floor(smooth / 2);
  let sum = 0;
  for (let i = 0; i < n + half; i++) {
    if (i < n) {
      sum += raw[i];
    }
    if (i - smooth >= 0) {
      sum -= raw[i - smooth];
    }
    const center = i - half;
    if (center >= 0 && center < n) {
      const lo = Math.max(0, i - smooth + 1);
      const hi = Math.min(n - 1, i);
      out[center] = sum / (hi - lo + 1);
    }
  }
  return out;
}

function percentile(values: Float32Array, p: number) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export interface Cue {
  /** Original cue times in seconds (before any offset) */
  start: number;
  end: number;
}

/**
 * The subtitle signal: 1 for frames inside a cue, 0 outside, for `frames` frames starting at `startSec` (which may be
 * negative: there are no cues before 0).
 */
export function cueSignal(
  cues: readonly Cue[],
  startSec: number,
  frames: number,
  frameSec = FRAME_SEC,
): Float32Array {
  const out = new Float32Array(frames);
  for (const cue of cues) {
    if (!(cue.end > cue.start)) {
      continue;
    }
    const a = Math.max(0, Math.round((cue.start - startSec) / frameSec));
    const b = Math.min(frames, Math.round((cue.end - startSec) / frameSec));
    for (let i = a; i < b; i++) {
      out[i] = 1;
    }
  }
  return out;
}

/** In-place iterative radix-2 FFT. `re`/`im` lengths must be the same power of two. `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error("fft size must be a power of two");
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half];
        const ai = im[i + k + half];
        const tr = ar * cr - ai * ci;
        const ti = ar * ci + ai * cr;
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * c[k] = Σᵢ a[i]·s[i + k] for k = 0 … s.length − a.length (a slides along the longer s), via FFT.
 */
export function crossCorrelate(a: Float32Array, s: Float32Array): Float64Array {
  const lags = s.length - a.length + 1;
  if (lags <= 0) {
    return new Float64Array(0);
  }
  let n = 1;
  while (n < s.length + a.length) {
    n <<= 1;
  }
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const sr = new Float64Array(n);
  const si = new Float64Array(n);
  ar.set(a);
  sr.set(s);
  fft(ar, ai);
  fft(sr, si);
  // conj(A)·S
  for (let i = 0; i < n; i++) {
    const r = ar[i] * sr[i] + ai[i] * si[i];
    const im = ar[i] * si[i] - ai[i] * sr[i];
    sr[i] = r;
    si[i] = im;
  }
  fft(sr, si, true);
  return sr.slice(0, lags);
}

/** One decoded stretch of audio: its start time in the media and the activity per frame from there */
export interface ActivityWindow {
  start: number;
  activity: Float32Array;
}

/**
 * What alignment found. `offset` is what to add to every cue (seconds, rounded to 0.05 s); `scale` corrects frame-rate
 * drift (shown time = original × scale + offset; 1 when there's none, see `alignWithDrift`). `confidence` is 0..1;
 * `offset` is null when the match wasn't confident enough to use.
 */
export interface SyncResult {
  offset: number | null;
  scale: number;
  confidence: number;
  /** How far the best match stands out from all the other offsets, in standard deviations */
  peakZ: number;
  /** The best offset found, even when it wasn't confident enough (for logs and tuning) */
  candidate: number | null;
}

export interface AlignOptions {
  /** Search ±this many seconds (default 600) */
  maxOffset?: number;
  /** Minimum peakZ to accept (default 6) */
  minPeakZ?: number;
  /** Minimum confidence to accept (default 0.3) */
  minConfidence?: number;
  /** Offsets within this many seconds of the best count as the same peak (default 1.5) */
  peakExclusion?: number;
  /** Remove trends slower than this from the activity (seconds, default 5): only speech bursts should match */
  detrendSec?: number;
  /** Added to every lag's cue variance (× frames, default 0.05) so stretches with one stray cue can't win */
  shrink?: number;
  /** Work on frames this many times coarser (default 1 = 10 ms): 5 is a fast first pass for the drift search */
  frameStep?: number;
}

/**
 * Finds the subtitle offset that best lines the cues up with the speech in the windows. For every window the activity
 * is detrended (slow changes like a music cue swelling would otherwise line up with dense stretches of dialogue) and
 * cross-correlated with the cue signal over ±maxOffset, normalized per lag like a Pearson correlation (with a little
 * shrinkage). The curves are summed over windows and the best lag is refined to sub-frame precision.
 *
 * Tuned on Tears of Steel (CC-BY, Blender Foundation; 76 cues in 12 min): 4 × 90 s finds known shifts from −250 s to
 * +480 s exactly (peakZ ≈ 10, confidence ≈ 0.58) while reversed cues score peakZ ≈ 5, confidence ≈ 0.14.
 *
 * Confidence: `peakZ` is (best − mean) / std over all lags, and `confidence` is 1 − (runner-up − mean) / (best − mean),
 * with the runner-up taken outside ±peakExclusion of the best (0 = a tie, 1 = nothing else comes close). Both have to
 * pass their minimum or `offset` is null. Correct matches scored confidence ≥ 0.32 in testing, wrong ones ≤ 0.23.
 */
export function alignWindows(
  windows: readonly ActivityWindow[],
  cues: readonly Cue[],
  opts: AlignOptions = {},
): SyncResult {
  const maxOffset = opts.maxOffset ?? 600;
  const minPeakZ = opts.minPeakZ ?? 6;
  const minConfidence = opts.minConfidence ?? 0.3;
  const step = Math.max(1, Math.round(opts.frameStep ?? 1));
  const frameSec = FRAME_SEC * step;
  const exclusion = Math.round((opts.peakExclusion ?? 1.5) / frameSec);
  const R = Math.round(maxOffset / frameSec);
  const detrendFrames = Math.round((opts.detrendSec ?? 5) / frameSec);
  const shrink = opts.shrink ?? 0.05;
  const lags = 2 * R + 1;
  const total = new Float64Array(lags);
  const fail: SyncResult = {
    offset: null,
    scale: 1,
    confidence: 0,
    peakZ: 0,
    candidate: null,
  };
  let used = 0;
  for (const w of windows) {
    const activity = step > 1 ? decimate(w.activity, step) : w.activity;
    const len = activity.length;
    if (len * step < 100) {
      continue;
    }
    const a = zeroMean(
      detrendFrames > 1 ? detrend(activity, detrendFrames) : activity,
    );
    let aNorm = 0;
    for (let i = 0; i < len; i++) {
      aNorm += a[i] * a[i];
    }
    aNorm = Math.sqrt(aNorm);
    if (!(aNorm > 0)) {
      continue;
    }
    // Subtitle timeline covering every lag: [start − R, start + len + R)
    const s = cueSignal(cues, w.start - maxOffset, len + 2 * R, frameSec);
    const c = crossCorrelate(a, s);
    // Pearson correlation per lag: the cue segment's own spread (s is 0/1, so Σs² = Σs) comes from a running sum,
    // so a dense stretch of dialogue doesn't win just for being dense. Segments without cues give 0.
    let segSum = 0;
    for (let i = 0; i < len; i++) {
      segSum += s[i];
    }
    for (let k = 0; k < c.length; k++) {
      if (k > 0) {
        segSum += s[k + len - 1] - s[k - 1];
      }
      const variance = segSum - (segSum * segSum) / len;
      // c[k] pairs speech at frame i with cue frame i + k − R … i.e. offset d = R − k
      if (variance > 1e-6) {
        total[R - k + R] += c[k] / (aNorm * Math.sqrt(variance + shrink * len));
      }
    }
    used++;
  }
  // One window alone can line up with the wrong stretch of dialogue (seen at peakZ 6.9), so ask for two unless
  // there is only one (a short video read whole)
  if (used < Math.min(2, windows.length)) {
    return fail;
  }
  // total[j] is offset (j − R) frames
  let best = 0;
  let mean = 0;
  for (let j = 0; j < lags; j++) {
    mean += total[j];
    if (total[j] > total[best]) {
      best = j;
    }
  }
  mean /= lags;
  let variance = 0;
  for (let j = 0; j < lags; j++) {
    variance += (total[j] - mean) ** 2;
  }
  const std = Math.sqrt(variance / lags);
  if (!(std > 0)) {
    return fail;
  }
  let second = -Infinity;
  for (let j = 0; j < lags; j++) {
    if (Math.abs(j - best) > exclusion && total[j] > second) {
      second = total[j];
    }
  }
  const peak = total[best] - mean;
  const peakZ = peak / std;
  const confidence =
    second === -Infinity
      ? 1
      : Math.max(0, Math.min(1, 1 - (second - mean) / peak));
  const candidate = roundOffset((best - R) * frameSec);
  if (!(peakZ >= minPeakZ) || !(confidence >= minConfidence)) {
    return { ...fail, confidence, peakZ, candidate };
  }
  // Parabolic interpolation around the peak for sub-frame precision
  let frac = 0;
  if (best > 0 && best < lags - 1) {
    const y0 = total[best - 1];
    const y1 = total[best];
    const y2 = total[best + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) {
      frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
    }
  }
  const offset = roundOffset((best - R + frac) * frameSec);
  return { offset, scale: 1, confidence, peakZ, candidate: offset };
}

/** 23.976 fps exactly */
const FILM_NTSC = 24000 / 1001;

/**
 * Time scales tried for frame-rate drift: shown time = original × scale + offset, where scale = subtitle fps / video
 * fps (subtitles timed for 25 fps PAL on a 23.976 fps video run 4% slow → 25/23.976). The NTSC 1000/1001 pairs also
 * cover 29.97 vs 30. Scale 1 first: it's preferred.
 */
export const DRIFT_SCALES: readonly number[] = [
  1,
  1000 / 1001,
  1001 / 1000,
  24 / 25,
  25 / 24,
  FILM_NTSC / 25,
  25 / FILM_NTSC,
];

/** How much better (peakZ) another scale has to be than scale 1 to be used: max(1, 10 % of scale 1's peakZ) */
const DRIFT_MARGIN_Z = 1;
const DRIFT_MARGIN_REL = 0.1;

/** Coarse frames (50 ms) for the scale search: ~5× less work per scale */
const DRIFT_SEARCH_STEP = 5;

const stretch = (cues: readonly Cue[], scale: number) =>
  scale === 1
    ? cues
    : cues.map((c) => ({ start: c.start * scale, end: c.end * scale }));

/**
 * Picks a scale from coarse (50 ms) results: the best confident one, but scale 1 unless another scale's peakZ beats
 * it by a clear margin (a tiny ratio like 1000/1001 fits almost as well over a short stretch). Undefined when none is
 * confident.
 */
export function pickScale(
  results: readonly (SyncResult & { scale: number })[],
): number | undefined {
  const confident = results.filter((r) => r.offset !== null);
  if (!confident.length) {
    return undefined;
  }
  const best = confident.reduce((a, b) => (b.peakZ > a.peakZ ? b : a));
  const plain = confident.find((r) => r.scale === 1);
  if (plain && best.scale !== 1) {
    const margin = Math.max(DRIFT_MARGIN_Z, plain.peakZ * DRIFT_MARGIN_REL);
    if (best.peakZ < plain.peakZ + margin) {
      return 1;
    }
  }
  return best.scale;
}

/**
 * Like alignWindows, but also corrects frame-rate drift: every ratio in DRIFT_SCALES is tried on coarse frames (cues
 * stretched to original × scale), pickScale() chooses one, and that scale is aligned again at full resolution for the
 * offset. Falls back to plain scale-1 alignment when no scale is confident (or the chosen one isn't at full resolution).
 */
export function alignWithDrift(
  windows: readonly ActivityWindow[],
  cues: readonly Cue[],
  opts: AlignOptions & { scales?: readonly number[] } = {},
): SyncResult {
  const scales = opts.scales ?? DRIFT_SCALES;
  const coarse = scales.map((scale) => ({
    ...alignWindows(windows, stretch(cues, scale), {
      ...opts,
      frameStep: DRIFT_SEARCH_STEP,
    }),
    scale,
  }));
  const scale = pickScale(coarse) ?? 1;
  const fine = {
    ...alignWindows(windows, stretch(cues, scale), opts),
    scale,
  };
  if (fine.offset !== null || scale === 1) {
    return fine;
  }
  return { ...alignWindows(windows, cues, opts), scale: 1 };
}

/** Rounds to 0.05 s without float noise or −0 */
export function roundOffset(seconds: number) {
  const r = Number((Math.round(seconds * 20) / 20).toFixed(2));
  return r === 0 ? 0 : r;
}

/** x minus its centered moving average over `n` frames (keeps the bursts, drops slow trends) */
export function detrend(x: Float32Array, n: number): Float32Array {
  const len = x.length;
  const prefix = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) {
    prefix[i + 1] = prefix[i] + x[i];
  }
  const half = Math.floor(n / 2);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(len, i + half + 1);
    out[i] = x[i] - (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/** Averages every `step` frames into one */
function decimate(x: Float32Array, step: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / step));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) {
      sum += x[i * step + j];
    }
    out[i] = sum / step;
  }
  return out;
}

function zeroMean(x: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
  }
  const mean = x.length ? sum / x.length : 0;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] - mean;
  }
  return out;
}

/**
 * Whether a result after `windowsRead` windows is clear enough to stop reading audio early: at least 3 windows and
 * well above the normal bar (Tears of Steel: 3 of 4 windows already give peakZ 10.7, confidence 0.52).
 */
export function isClearMatch(result: SyncResult, windowsRead: number) {
  return (
    result.offset !== null &&
    windowsRead >= 3 &&
    result.peakZ >= 9 &&
    result.confidence >= 0.45
  );
}

/** Roughly how many bytes auto-sync may download; interleaved files cost about their bitrate × seconds listened */
export const LISTEN_BYTES_BUDGET = 300e6;
/** Never listen to less than this in total: 4 × 60 s still aligns (peakZ 7.3), less starts to fail */
export const MIN_LISTEN_SECONDS = 240;

/**
 * Seconds per window: `preferred` unless the file's average bitrate would make `count` windows cost more than
 * LISTEN_BYTES_BUDGET, but never below MIN_LISTEN_SECONDS in total. Unknown size/duration keeps `preferred`.
 */
export function windowSecondsForBitrate(
  sizeBytes: number | null,
  duration: number,
  count: number,
  preferred: number,
) {
  if (!sizeBytes || !(duration > 0) || count < 1) {
    return preferred;
  }
  const bytesPerSecond = sizeBytes / duration;
  const affordable = LISTEN_BYTES_BUDGET / bytesPerSecond;
  const total = Math.max(
    MIN_LISTEN_SECONDS,
    Math.min(preferred * count, affordable),
  );
  return Math.min(preferred, total / count);
}

export interface WindowPlan {
  start: number;
  end: number;
}

/**
 * Where to listen: `count` windows of `length` seconds, spread evenly over the part of the media that has dialogue
 * (first to last cue, clamped to the media), so credits and long intros don't waste the budget. Windows never overlap
 * and stay inside [0, duration]; short media gets one window over all of it.
 */
export function planWindows(
  duration: number,
  cues: readonly Cue[],
  count = 4,
  length = 90,
): WindowPlan[] {
  if (!(duration > 0)) {
    return [];
  }
  if (duration <= length * count) {
    // Not much more than we'd read anyway: take everything (up to the budget)
    return [{ start: 0, end: Math.min(duration, length * count) }];
  }
  let from = 0;
  let to = duration;
  if (cues.length) {
    from = Math.max(0, Math.min(...cues.map((c) => c.start)));
    to = Math.min(duration, Math.max(...cues.map((c) => c.end)));
  }
  if (to - from < length * count) {
    // Dialogue is concentrated (or the cues don't fit the media): widen the span around it
    const mid = (from + to) / 2;
    from = Math.max(
      0,
      Math.min(duration - length * count, mid - (length * count) / 2),
    );
    to = from + length * count;
  }
  const span = to - from;
  const plan: WindowPlan[] = [];
  for (let i = 0; i < count; i++) {
    const center = from + (span * (i + 0.5)) / count;
    const start = Math.max(0, Math.min(duration - length, center - length / 2));
    plan.push({ start, end: start + length });
  }
  return plan;
}
