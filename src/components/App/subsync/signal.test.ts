import { describe, expect, it } from "vitest";
import {
  FRAME_SEC,
  SpeechActivityMeter,
  alignWindows,
  crossCorrelate,
  cueSignal,
  detrend,
  downmix,
  DRIFT_SCALES,
  alignWithDrift,
  fft,
  isClearMatch,
  pickScale,
  planWindows,
  windowSecondsForBitrate,
  roundOffset,
  speechActivity,
  type ActivityWindow,
  type Cue,
} from "./signal";

const RATE = 16000;

/** Deterministic pseudo-random numbers in [-1, 1) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/** Dialogue-like cues: bursts of 0.8–3 s with 0.3–4 s gaps, from `from` to `to` seconds */
function makeCues(seed: number, from: number, to: number): Cue[] {
  const r = rng(seed);
  const cues: Cue[] = [];
  let t = from;
  while (t < to) {
    const len = 0.8 + (r() + 1) * 1.1;
    cues.push({ start: t, end: Math.min(to, t + len) });
    t += len + 0.3 + (r() + 1) * 1.85;
  }
  return cues;
}

/**
 * Synthetic soundtrack for [start, start + length): "speech" (a syllable-modulated 300–3000 Hz harmonic tone) inside
 * the cues, over quiet broadband noise and a loud 60 Hz hum (outside the speech band, must be ignored).
 */
function synthAudio(
  cues: readonly Cue[],
  start: number,
  length: number,
  opts: { speech?: number; noise?: number; seed?: number } = {},
) {
  const r = rng(opts.seed ?? 7);
  const speech = opts.speech ?? 0.3;
  const noise = opts.noise ?? 0.01;
  const out = new Float32Array(Math.round(length * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = start + i / RATE;
    let x = 0.5 * Math.sin(2 * Math.PI * 60 * t) + noise * r();
    if (cues.some((c) => t >= c.start && t < c.end)) {
      // ~4 syllables per second
      const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
      x +=
        speech *
        envelope *
        (Math.sin(2 * Math.PI * 220 * 2 * t) +
          0.6 * Math.sin(2 * Math.PI * 220 * 5 * t) +
          0.3 * Math.sin(2 * Math.PI * 220 * 9 * t));
    }
    out[i] = x;
  }
  return out;
}

function activityWindow(samples: Float32Array, start: number): ActivityWindow {
  const meter = new SpeechActivityMeter(RATE);
  // Odd chunk sizes: frames must carry over between pushes
  for (let i = 0; i < samples.length; i += 4999) {
    meter.push(samples.subarray(i, i + 4999));
  }
  return { start, activity: speechActivity(meter.frames()) };
}

describe("fft / crossCorrelate", () => {
  it("round-trips through the inverse FFT", () => {
    const r = rng(1);
    const re = Float64Array.from({ length: 64 }, r);
    const im = new Float64Array(64);
    const orig = re.slice();
    fft(re, im);
    fft(re, im, true);
    re.forEach((v, i) => expect(v).toBeCloseTo(orig[i], 9));
    im.forEach((v) => expect(v).toBeCloseTo(0, 9));
  });

  it("rejects sizes that aren't a power of two", () => {
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
  });

  it("matches a direct cross-correlation", () => {
    const r = rng(2);
    const a = Float32Array.from({ length: 37 }, r);
    const s = Float32Array.from({ length: 120 }, r);
    const c = crossCorrelate(a, s);
    expect(c.length).toBe(120 - 37 + 1);
    for (const k of [0, 5, 40, 83]) {
      let direct = 0;
      for (let i = 0; i < a.length; i++) {
        direct += a[i] * s[i + k];
      }
      expect(c[k]).toBeCloseTo(direct, 4);
    }
    expect(crossCorrelate(s, a).length).toBe(0);
  });
});

describe("speech activity (VAD)", () => {
  it("gives one energy value per 10 ms frame, across chunk boundaries", () => {
    const meter = new SpeechActivityMeter(RATE);
    meter.push(new Float32Array(RATE / 2 + 30));
    meter.push(new Float32Array(RATE / 2 - 30));
    expect(meter.frames().length).toBe(100);
  });

  it("measures the speech band and ignores hum below it", () => {
    const tone = (hz: number) => {
      const m = new SpeechActivityMeter(RATE);
      m.push(
        Float32Array.from({ length: RATE }, (_, i) =>
          Math.sin((2 * Math.PI * hz * i) / RATE),
        ),
      );
      const f = m.frames();
      return f[f.length - 1];
    };
    expect(tone(1000)).toBeGreaterThan(-6);
    expect(tone(50)).toBeLessThan(-40);
    expect(tone(7500)).toBeLessThan(-30);
  });

  it("is high inside speech and low in noise/hum/silence", () => {
    const cues: Cue[] = [
      { start: 2, end: 4 },
      { start: 7, end: 8.5 },
    ];
    const act = activityWindow(synthAudio(cues, 0, 10), 0).activity;
    const mean = (a: number, b: number) => {
      let s = 0;
      for (let i = a / FRAME_SEC; i < b / FRAME_SEC; i++) {
        s += act[i];
      }
      return s / ((b - a) / FRAME_SEC);
    };
    expect(mean(2.2, 3.8)).toBeGreaterThan(0.75);
    expect(mean(7.2, 8.3)).toBeGreaterThan(0.75);
    // (skips the filters' start-up transient from the loud hum)
    expect(mean(0.5, 1.8)).toBeLessThan(0.25);
    expect(mean(4.5, 6.5)).toBeLessThan(0.25);
    expect(mean(9, 10)).toBeLessThan(0.25);
  });

  it("treats digital silence as no speech", () => {
    const act = speechActivity(new Float32Array(200).fill(-120));
    expect(Math.max(...act)).toBe(0);
  });

  it("downmixes channels by averaging", () => {
    const out = downmix(
      [Float32Array.of(1, 0.5), Float32Array.of(0, -0.5)],
      new Float32Array(2),
    );
    expect(Array.from(out)).toEqual([0.5, 0]);
  });
});

describe("cueSignal", () => {
  it("is 1 inside cues and 0 outside, at the original times", () => {
    const s = cueSignal(
      [
        { start: 0.05, end: 0.1 },
        { start: -1, end: 0.02 },
        { start: 0.5, end: 0.4 },
      ],
      -0.03,
      20,
    );
    // frame i covers -0.03 + i * 0.01
    expect(Array.from(s.slice(0, 10))).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 1, 1]);
    expect(
      Array.from(s.slice(10, 20)).every((v, i) => v === (i < 3 ? 1 : 0)),
    ).toBe(true);
  });
});

describe("detrend / roundOffset", () => {
  it("removes a constant and keeps bursts", () => {
    const x = new Float32Array(100).fill(0.5);
    x[50] = 1.5;
    const d = detrend(x, 21);
    expect(d[10]).toBeCloseTo(0, 6);
    expect(d[50]).toBeGreaterThan(0.9);
  });

  it("rounds to 0.05 s without -0", () => {
    expect(roundOffset(2.349)).toBe(2.35);
    expect(roundOffset(-0.01)).toBe(0);
    expect(Object.is(roundOffset(-0.01), -0)).toBe(false);
    expect(roundOffset(-4.126)).toBe(-4.15);
  });
});

describe("alignWindows", () => {
  // 6 minutes of dialogue; audio windows at 30 s, 150 s and 270 s (60 s each)
  const cues = makeCues(11, 5, 355);
  const windows = [30, 150, 270].map((start) =>
    activityWindow(synthAudio(cues, start, 60, { seed: start }), start),
  );

  it.each([0, 2.35, -4.1, 37.5, -95.25, 110])(
    "finds a known offset of %s s",
    (shift) => {
      // Subtitles that are `shift` seconds early need +shift
      const shifted = cues.map((c) => ({
        start: c.start - shift,
        end: c.end - shift,
      }));
      const r = alignWindows(windows, shifted, { maxOffset: 120 });
      expect(r.offset).not.toBeNull();
      expect(r.offset!).toBeCloseTo(shift, 1);
      expect(Math.abs(r.offset! - shift)).toBeLessThanOrEqual(0.05);
      expect(r.scale).toBe(1);
      expect(r.confidence).toBeGreaterThan(0.25);
      expect(r.peakZ).toBeGreaterThan(6);
    },
  );

  it("refuses noise (no confident match)", () => {
    const r1 = rng(5);
    const noiseWindows = [30, 150, 270].map((start) => {
      const samples = Float32Array.from(
        { length: 60 * RATE },
        () => 0.2 * r1(),
      );
      return activityWindow(samples, start);
    });
    const r = alignWindows(noiseWindows, cues, { maxOffset: 120 });
    expect(r.offset).toBeNull();
  });

  it("refuses subtitles that belong to something else", () => {
    const other = makeCues(99, 5, 355);
    const r = alignWindows(windows, other, { maxOffset: 120 });
    expect(r.offset).toBeNull();
    expect(r.candidate).not.toBeNull();
  });

  it("needs two windows (one alone can match the wrong dialogue)", () => {
    // A silent window carries no information and is skipped
    const silent = { start: 200, activity: new Float32Array(6000) };
    const r = alignWindows([windows[0], silent], cues, { maxOffset: 120 });
    expect(r.offset).toBeNull();
  });

  it("gives up without windows or cues", () => {
    expect(alignWindows([], cues).offset).toBeNull();
    expect(alignWindows(windows, [], { maxOffset: 60 }).offset).toBeNull();
  });
});

describe("planWindows", () => {
  const cues: Cue[] = [
    { start: 100, end: 102 },
    { start: 2900, end: 2903 },
  ];

  it("spreads windows over the dialogue, inside the media", () => {
    const plan = planWindows(3600, cues, 4, 90);
    expect(plan).toHaveLength(4);
    for (const w of plan) {
      expect(w.start).toBeGreaterThanOrEqual(100 - 45);
      expect(w.end).toBeLessThanOrEqual(2903 + 45);
      expect(w.end - w.start).toBe(90);
    }
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].start).toBeGreaterThanOrEqual(plan[i - 1].end);
    }
  });

  it("reads all of a short video", () => {
    expect(planWindows(200, cues, 4, 90)).toEqual([{ start: 0, end: 200 }]);
  });

  it("widens a short dialogue span and stays inside the media", () => {
    const plan = planWindows(1000, [{ start: 990, end: 995 }], 3, 60);
    expect(plan).toHaveLength(3);
    expect(plan[2].end).toBeLessThanOrEqual(1000);
    expect(plan[0].start).toBeGreaterThanOrEqual(0);
  });

  it("is empty without a duration", () => {
    expect(planWindows(NaN, cues)).toEqual([]);
  });

  it("puts each window where its part has the most speech edges, not the most subtitles", () => {
    // Dialogue 0–1200 s: a steady line every 20 s, plus (in the first part, 0–600 s) 100 s of back-to-back cues
    // around 100 s and 100 s of short lines with pauses around 400 s
    const lines: Cue[] = [];
    for (let t = 0; t < 1200; t += 20) lines.push({ start: t, end: t + 2 });
    for (let t = 60; t < 160; t += 2) lines.push({ start: t, end: t + 2 });
    for (let t = 350; t < 450; t += 4) lines.push({ start: t, end: t + 1.5 });
    const plan = planWindows(3600, lines, 2, 90);
    expect(plan).toHaveLength(2);
    expect(plan[0].start).toBeGreaterThanOrEqual(330);
    expect(plan[0].end).toBeLessThanOrEqual(470);
    // The second part (591–1182 s) is uniform: the window stays near its middle (841.5 s)
    expect(Math.abs(plan[1].start - 841.5)).toBeLessThanOrEqual(20);
    expect(plan[1].start).toBeGreaterThanOrEqual(plan[0].end);
  });
});

describe("listening budget", () => {
  it("stops early only on a clear match with at least 3 windows that the previous round agreed on", () => {
    const r = {
      offset: 1,
      scale: 1,
      confidence: 0.5,
      peakZ: 10,
      candidate: 1,
    };
    const prev = { ...r, offset: 1.05 };
    expect(isClearMatch(r, 3, prev)).toBe(true);
    expect(isClearMatch(r, 2, prev)).toBe(false);
    expect(isClearMatch({ ...r, peakZ: 8 }, 4, prev)).toBe(true);
    expect(isClearMatch({ ...r, peakZ: 7.9 }, 4, prev)).toBe(false);
    expect(isClearMatch({ ...r, confidence: 0.45 }, 4, prev)).toBe(true);
    expect(isClearMatch({ ...r, confidence: 0.35 }, 4, prev)).toBe(false);
    expect(isClearMatch({ ...r, offset: null }, 4, prev)).toBe(false);
    // The timing has to have held still since the previous round
    expect(isClearMatch(r, 4, null)).toBe(false);
    expect(isClearMatch(r, 4, { ...prev, offset: null })).toBe(false);
    expect(isClearMatch(r, 4, { ...prev, offset: 1.1 })).toBe(false);
    expect(isClearMatch(r, 4, { ...prev, scale: 25 / 24 })).toBe(false);
  });

  it("shortens windows for high-bitrate files, down to 4 minutes in total", () => {
    const hour = 3600;
    // 2 Mbps: 4 × 90 s is about 90 MB, fine
    expect(windowSecondsForBitrate((2e6 / 8) * hour, hour, 4, 90)).toBe(90);
    // 10 Mbps: 300 MB buys 240 s
    expect(windowSecondsForBitrate((10e6 / 8) * hour, hour, 4, 90)).toBeCloseTo(
      60,
    );
    // 8 Mbps: 300 s
    expect(windowSecondsForBitrate(1e6 * hour, hour, 4, 90)).toBeCloseTo(75);
    // 60 Mbps remux: never below the floor
    expect(windowSecondsForBitrate((60e6 / 8) * hour, hour, 4, 90)).toBe(60);
    // Unknown size/duration
    expect(windowSecondsForBitrate(null, hour, 4, 90)).toBe(90);
    expect(windowSecondsForBitrate(1e9, NaN, 4, 90)).toBe(90);
  });
});

describe("drift (time scale)", () => {
  // 50 minutes of dialogue; 45 s windows spread over it, so a 4% drift moves later windows by up to ~2 min
  const cues = makeCues(21, 5, 3000);
  const windows = [60, 900, 1700, 2600].map((start) =>
    activityWindow(synthAudio(cues, start, 45, { seed: start }), start),
  );
  const FILM = 24000 / 1001;
  // Subtitles that need original × scale + offset to match the audio
  const drifted = (scale: number, offset: number) =>
    cues.map((c) => ({
      start: (c.start - offset) / scale,
      end: (c.end - offset) / scale,
    }));

  it.each([
    [FILM / 25, 3.1],
    [25 / FILM, -4.2],
    [24 / 25, -10],
    [25 / 24, 0.5],
  ])("recovers scale %s and offset %s", (scale, offset) => {
    const r = alignWithDrift(windows, drifted(scale, offset), {
      maxOffset: 300,
    });
    expect(r.scale).toBeCloseTo(scale, 6);
    expect(r.offset).not.toBeNull();
    expect(Math.abs(r.offset! - offset)).toBeLessThanOrEqual(0.1);
  });

  it("keeps scale 1 when there is no drift", () => {
    const r = alignWithDrift(windows, drifted(1, 2.35), { maxOffset: 300 });
    expect(r.scale).toBe(1);
    expect(r.offset).toBeCloseTo(2.35, 1);
  });

  it("plain alignment can't match drifted subtitles that drift corrects", () => {
    const plain = alignWithDrift(windows, drifted(FILM / 25, 0), {
      maxOffset: 300,
      scales: [1],
    });
    expect(plain.offset === null || Math.abs(plain.offset) > 1).toBe(true);
  });

  it("refuses noise at every scale", () => {
    const r1 = rng(9);
    const noise = [60, 900, 1700].map((start) =>
      activityWindow(
        Float32Array.from({ length: 45 * RATE }, () => 0.2 * r1()),
        start,
      ),
    );
    expect(alignWithDrift(noise, cues, { maxOffset: 300 }).offset).toBeNull();
  });

  it("prefers 1 unless another scale is clearly better", () => {
    const r = (scale: number, peakZ: number, ok = true) => ({
      offset: ok ? 0 : null,
      scale,
      confidence: 0.5,
      peakZ,
      candidate: 0,
    });
    expect(pickScale([r(1, 10), r(1000 / 1001, 10.5)])).toBe(1);
    expect(pickScale([r(1, 10), r(25 / 24, 11.5)])).toBe(25 / 24);
    expect(pickScale([r(1, 5, false), r(25 / 24, 7)])).toBe(25 / 24);
    expect(pickScale([r(1, 5, false), r(0.96, 5, false)])).toBeUndefined();
    expect(DRIFT_SCALES[0]).toBe(1);
  });
});
