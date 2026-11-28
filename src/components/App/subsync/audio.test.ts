// readActivityWindows: reading the planned audio windows through a fake mediabunny (synthetic samples).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { URL_READ_RETRIES, urlRetryDelay } from "./audio";

vi.mock(
  "mediabunny",
  async () => (await import("../../../test/fakeMediabunny")).mediabunnyModule,
);
vi.mock(
  "@mediabunny/ac3",
  async () => (await import("../../../test/fakeMediabunny")).ac3Module,
);

const { mb, created, resetMediabunny, fakeAudioTrack, ac3Module } =
  await import("../../../test/fakeMediabunny");
const { readActivityWindows, AudioReadError } = await import("./audio");

const RATE = 8000;
/** `seconds` of a 1 kHz tone (speech band) on every channel, in 0.5 s chunks */
const tone = (start: number, seconds: number, channels = 2) => {
  const out = [];
  const chunk = RATE / 2;
  for (let t = 0; t < seconds; t += 0.5) {
    const planes = Array.from({ length: channels }, () => {
      const p = new Float32Array(chunk);
      for (let i = 0; i < chunk; i++)
        p[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / RATE);
      return p;
    });
    out.push({ timestamp: start + t, sampleRate: RATE, planes });
  }
  return out;
};

const cues = [
  { start: 10, end: 12 },
  { start: 500, end: 502 },
];
const base = {
  source: "https://cdn.example.com/movie.mkv",
  cues,
  windowCount: 3,
  windowSeconds: 2,
  stallTimeoutMs: 5000,
};

beforeEach(() => {
  resetMediabunny();
  mb.duration = 600;
  mb.size = null;
  mb.samples = (start, end) => tone(start, end - start);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readActivityWindows", () => {
  it("reads every planned window and reports progress", async () => {
    const onProgress = vi.fn();
    const { windows, duration } = await readActivityWindows({
      ...base,
      onProgress,
    });
    expect(duration).toBe(600);
    expect(windows).toHaveLength(3);
    // Windows start where the first sample was, and carry 10 ms frames
    expect(windows[0].start).toBeGreaterThanOrEqual(0);
    expect(windows[0].activity.length).toBeGreaterThan(100);
    expect(onProgress).toHaveBeenCalled();
    expect(
      Math.max(...onProgress.mock.calls.map((c) => c[0])),
    ).toBeLessThanOrEqual(1);
    // URL sources read in parallel and give up retrying
    const { opts } = created.urlSources[0];
    expect(opts.parallelism).toBe(4);
    expect(opts.getRetryDelay(1)).toBe(2);
    expect(opts.getRetryDelay(3)).toBe(4);
    expect(opts.getRetryDelay(4)).toBeNull();
    expect(created.inputs[0].dispose).toHaveBeenCalled();
  });

  it("handles chunks whose size or channel count changes", async () => {
    mb.samples = (start) => [
      ...tone(start, 0.5, 1),
      ...tone(start + 0.5, 0.5, 2),
      {
        timestamp: start + 1,
        sampleRate: RATE,
        planes: [new Float32Array(100), new Float32Array(100)],
      },
    ];
    const { windows } = await readActivityWindows(base);
    expect(windows).toHaveLength(3);
  });

  it("reads the windows in rounds, all windows per round, and stops when onRound says so", async () => {
    const calls: [number, number][] = [];
    mb.samples = (start, end) => {
      calls.push([start, end]);
      return tone(start, end - start);
    };
    const onRound = vi.fn((_w: unknown[], round: number) => round === 2);
    const { windows } = await readActivityWindows({
      ...base,
      windowSeconds: 6,
      rounds: 3,
      onRound,
    });
    // Round 1 reads the first third of every window before round 2 extends them; round 3 never starts
    expect(calls).toHaveLength(6);
    const firsts = calls.slice(0, 3);
    for (const [a, b] of firsts) {
      expect(b - a).toBeCloseTo(2);
    }
    calls.slice(3).forEach(([a], i) => expect(a).toBeCloseTo(firsts[i][1]));
    expect(onRound.mock.calls.map((c) => c[1])).toEqual([1, 2]);
    // Each window is one contiguous stretch: 4 s of 10 ms frames
    expect(windows).toHaveLength(3);
    for (const w of windows) {
      expect(w.activity.length).toBe(400);
    }
  });

  it("joins the rounds exactly: overlap skipped, gaps filled with silence", async () => {
    // Calls 0–2 are round 1 (each window's first part). Window 0's second part (call 3) arrives 0.5 s late; every
    // other later part starts 0.5 s early, overlapping what was read already (whole 0.5 s chunks, so nothing runs past
    // the window's end)
    let call = 0;
    mb.samples = (start, end) => {
      const n = call++;
      if (n < 3) return tone(start, end - start);
      if (n === 3) return tone(start + 0.5, end - start - 0.5);
      return tone(start - 0.5, end - start + 0.5);
    };
    const onProgress = vi.fn();
    const { windows } = await readActivityWindows({
      ...base,
      windowSeconds: 6,
      rounds: 3,
      onProgress,
    });
    // 6 s of 10 ms frames each: without skipping the overlaps 650, without filling the gap 550
    expect(windows.map((w) => w.activity.length)).toEqual([600, 600, 600]);
    // Progress only grows and ends complete
    const fractions = onProgress.mock.calls.map((c) => c[0]);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBeCloseTo(1);
  });

  it("counts a part that ran out of samples as read", async () => {
    mb.samples = (start, end) =>
      start % 1 === 0 ? tone(start, (end - start) / 2) : [];
    const onProgress = vi.fn();
    await readActivityWindows({
      ...base,
      windowSeconds: 6,
      rounds: 3,
      onProgress,
    });
    expect(onProgress.mock.calls.at(-1)?.[0]).toBeGreaterThan(0.3);
  });

  it("skips windows without samples", async () => {
    mb.samples = () => [];
    const { windows } = await readActivityWindows(base);
    expect(windows).toEqual([]);
  });

  it("listens to the requested track, else the primary one", async () => {
    mb.audio = [fakeAudioTrack({ id: 2 }), fakeAudioTrack({ id: 5 })];
    const seen: unknown[] = [];
    const sink = (await import("mediabunny")).AudioSampleSink;
    const orig = sink.prototype.samples;
    sink.prototype.samples = function (
      this: { track: unknown },
      s: number,
      e: number,
    ) {
      seen.push(this.track);
      return orig.call(this, s, e);
    };
    try {
      await readActivityWindows({ ...base, trackId: 5, windowCount: 1 });
      await readActivityWindows({ ...base, trackId: 99, windowCount: 1 });
    } finally {
      sink.prototype.samples = orig;
    }
    expect(seen).toEqual([mb.audio[1], mb.audio[0]]);
  });

  it("reads a local file (file share)", async () => {
    const { windows } = await readActivityWindows({
      ...base,
      source: new File(["x"], "movie.mkv"),
      windowCount: 1,
    });
    expect(windows).toHaveLength(1);
    expect(created.urlSources).toHaveLength(0);
  });

  it("shortens windows for high-bitrate files", async () => {
    // 600 s at 20 GB: the budget allows far less than 3 × 120 s, so each window drops to the 80 s minimum share
    mb.size = 20e9;
    const spans: number[] = [];
    mb.samples = (start, end) => {
      spans.push(end - start);
      return [];
    };
    await readActivityWindows({ ...base, windowSeconds: 120 });
    expect(spans).toEqual([80, 80, 80]);
  });

  it("registers the AC-3 decoder for Dolby audio", async () => {
    mb.audio = [fakeAudioTrack({ codec: "eac3" })];
    ac3Module.registerAc3Decoder.mockImplementationOnce(() => {
      throw new Error("no wasm");
    });
    await readActivityWindows({ ...base, windowCount: 1 });
    expect(ac3Module.registerAc3Decoder).toHaveBeenCalled();
  });

  describe("errors", () => {
    it("can't read the video", async () => {
      mb.readError = new Error("CORS");
      const p = readActivityWindows(base);
      await expect(p).rejects.toBeInstanceOf(AudioReadError);
      await expect(readActivityWindows(base)).rejects.toThrow(
        "Couldn't read the video (the server may not allow it)",
      );
    });

    it("no audio track", async () => {
      mb.audio = [];
      await expect(readActivityWindows(base)).rejects.toThrow(
        "This video has no audio track",
      );
    });

    it("no decoder", async () => {
      mb.audio = [fakeAudioTrack({ codec: "dts", canDecode: false })];
      await expect(readActivityWindows(base)).rejects.toThrow(
        "This browser can't decode the video's audio",
      );
      mb.audio = [fakeAudioTrack({ codec: "ac3", canDecode: "throw" })];
      await expect(readActivityWindows(base)).rejects.toThrow("can't decode");
    });

    it("times out when nothing arrives", async () => {
      vi.useFakeTimers();
      mb.hang = true;
      const p = readActivityWindows({ ...base, stallTimeoutMs: 3000 });
      const assertion = expect(p).rejects.toThrow(
        "Timed out reading the video's audio",
      );
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(created.inputs[0].dispose).toHaveBeenCalled();
    });
  });
});

describe("urlRetryDelay", () => {
  it("retries a failed range request 3 times (mediabunny counts attempts from 1), then gives up", () => {
    expect(URL_READ_RETRIES).toBe(3);
    // Simulates mediabunny's retry loop: every failure calls getRetryDelay with the failures so far
    let retries = 0;
    for (let attempts = 1; urlRetryDelay(attempts) !== null; attempts++) {
      retries++;
    }
    expect(retries).toBe(3);
    expect([1, 2, 3, 4].map(urlRetryDelay)).toEqual([2, 3, 4, null]);
  });
});
