// Auto subtitle sync: reads a few windows of a video's audio with mediabunny and turns them into speech activity.
// Runs inside the worker (worker.ts), so decoding never blocks playback. The windows are read at the same time (the
// download is the slow part, and parallel range requests use more of the connection) and in rounds that each extend
// every window, so a clear match can stop after the first part of each window.
import type { InputAudioTrack } from "mediabunny";
import {
  SpeechActivityMeter,
  downmix,
  planWindows,
  speechActivity,
  windowSecondsForBitrate,
  type ActivityWindow,
  type Cue,
  type WindowPlan,
} from "./signal";

export interface AudioReadOptions {
  /** A direct media URL (CORS + range requests) or a local file (file share) */
  source: string | File;
  /** The audio track to listen to (mediabunny track id, e.g. the converter's); default: the primary track */
  trackId?: number;
  /** Cues at their original times: the windows are planned around the dialogue */
  cues: readonly Cue[];
  windowCount: number;
  /** Seconds per window; shortened for high-bitrate files (windowSecondsForBitrate) */
  windowSeconds: number;
  /** Read each window in this many equal parts, all windows in parallel per round (default 1) */
  rounds?: number;
  /** Give up when nothing was read for this long (ms): slow servers, ones that ignore range requests */
  stallTimeoutMs: number;
  onProgress?: (fraction: number) => void;
  /** Called after each round (the last one too) with everything read so far; return true to stop reading */
  onRound?: (windows: ActivityWindow[], round: number) => boolean;
}

export class AudioReadError extends Error {}

/** Failed range requests are retried this many times (then the read fails) */
export const URL_READ_RETRIES = 3;

/**
 * mediabunny's getRetryDelay: seconds before the next try, or null to give up. mediabunny counts `attempts` from 1
 * (the failed tries so far), so 1..URL_READ_RETRIES retry after 2, 3, 4 s.
 */
export const urlRetryDelay = (attempts: number): number | null =>
  attempts <= URL_READ_RETRIES ? attempts + 1 : null;

/** Reads the planned windows and returns their speech activity. Throws AudioReadError with a readable message. */
export async function readActivityWindows(
  opts: AudioReadOptions,
): Promise<{ windows: ActivityWindow[]; duration: number }> {
  const mb = await import("mediabunny");
  const input = new mb.Input({
    source:
      typeof opts.source === "string"
        ? new mb.UrlSource(opts.source, {
            parallelism: 4,
            // The default retries forever; a stalled read fails through the watchdog instead
            getRetryDelay: urlRetryDelay,
          })
        : new mb.BlobSource(opts.source),
    formats: mb.ALL_FORMATS,
  });
  let lastProgress = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (Date.now() - lastProgress > opts.stallTimeoutMs) {
        reject(new AudioReadError("Timed out reading the video's audio"));
      }
    }, 1000);
  });
  try {
    return await Promise.race([
      read(mb, input, opts, () => (lastProgress = Date.now())),
      stalled,
    ]);
  } finally {
    clearInterval(timer);
    input.dispose();
  }
}

async function read(
  mb: typeof import("mediabunny"),
  input: import("mediabunny").Input,
  opts: AudioReadOptions,
  touch: () => void,
) {
  let track: InputAudioTrack | null;
  let duration: number;
  try {
    const tracks = await input.getAudioTracks();
    track =
      (opts.trackId !== undefined
        ? tracks.find((t) => t.id === opts.trackId)
        : undefined) ?? (await input.getPrimaryAudioTrack());
    duration = await input.computeDuration();
  } catch {
    throw new AudioReadError(
      "Couldn't read the video (the server may not allow it)",
    );
  }
  if (!track) {
    throw new AudioReadError("This video has no audio track");
  }
  if (track.codec === "ac3" || track.codec === "eac3") {
    try {
      const { registerAc3Decoder } = await import("@mediabunny/ac3");
      registerAc3Decoder();
    } catch {
      // canDecode() below says no
    }
  }
  if (!(await track.canDecode().catch(() => false))) {
    throw new AudioReadError("This browser can't decode the video's audio");
  }
  touch();
  // Audio and video are interleaved, so listening to a window downloads about that much of the whole file
  const size = await input.source.getSizeOrNull().catch(() => null);
  const plan = planWindows(
    duration,
    opts.cues,
    opts.windowCount,
    windowSecondsForBitrate(
      size,
      duration,
      opts.windowCount,
      opts.windowSeconds,
    ),
  );
  const rounds = Math.max(1, Math.round(opts.rounds ?? 1));
  const totalSeconds = plan.reduce((s, w) => s + (w.end - w.start), 0);
  const states: WindowState[] = plan.map((w) => ({
    plan: w,
    sink: new mb.AudioSampleSink(track),
    start: w.start,
    next: w.start,
    readTo: w.start,
  }));
  const report = () =>
    opts.onProgress?.(
      Math.min(
        1,
        states.reduce((s, w) => s + (w.readTo - w.plan.start), 0) /
          totalSeconds,
      ),
    );
  let windows: ActivityWindow[] = [];
  for (let round = 1; round <= rounds; round++) {
    await Promise.all(
      states.map((w) => {
        const len = w.plan.end - w.plan.start;
        return readPart(
          w,
          w.plan.start + (len * (round - 1)) / rounds,
          w.plan.start + (len * round) / rounds,
          () => {
            touch();
            report();
          },
        );
      }),
    );
    windows = states.flatMap((w) =>
      w.meter
        ? [{ start: w.start, activity: speechActivity(w.meter.frames()) }]
        : [],
    );
    if (opts.onRound?.(windows, round)) {
      break;
    }
  }
  return { windows, duration };
}

interface WindowState {
  plan: WindowPlan;
  sink: import("mediabunny").AudioSampleSink;
  /** Created on the first sample; kept across rounds so a window's frames stay one contiguous stretch */
  meter?: SpeechActivityMeter;
  /** Media time of the window's first frame */
  start: number;
  /** Media time the meter has been fed up to */
  next: number;
  /** For progress: how far into the window reading got */
  readTo: number;
}

/**
 * Feeds the samples in [from, to) to the window's meter, continuing exactly where the previous round stopped: the
 * first decoded chunk usually starts a little before `from`, so what was already read is skipped, and a gap (dropped
 * audio) is filled with silence, so every frame stays at its media time.
 */
async function readPart(
  w: WindowState,
  from: number,
  to: number,
  onSample: () => void,
) {
  let mono = new Float32Array(0);
  let planes: Float32Array[] = [];
  for await (const sample of w.sink.samples(from, to)) {
    try {
      const rate = sample.sampleRate;
      if (!w.meter) {
        w.meter = new SpeechActivityMeter(rate);
        w.start = Math.max(0, sample.timestamp);
        w.next = w.start;
      }
      const frames = sample.numberOfFrames;
      const channels = sample.numberOfChannels;
      const skip = Math.max(0, Math.round((w.next - sample.timestamp) * rate));
      if (skip < frames) {
        if (mono.length !== frames) {
          mono = new Float32Array(frames);
          planes = Array.from(
            { length: channels },
            () => new Float32Array(frames),
          );
        }
        while (planes.length < channels) {
          planes.push(new Float32Array(frames));
        }
        for (let ch = 0; ch < channels; ch++) {
          sample.copyTo(planes[ch], { planeIndex: ch, format: "f32-planar" });
        }
        downmix(planes.slice(0, channels), mono);
        const gap = Math.round((sample.timestamp - w.next) * rate);
        // (bounded: a timestamp jump far past the part isn't silence worth allocating)
        if (gap > 0 && gap <= rate * Math.max(1, to - w.next)) {
          w.meter.push(new Float32Array(gap));
        }
        w.meter.push(skip ? mono.subarray(skip) : mono);
        w.next = sample.timestamp + frames / rate;
      }
      w.readTo = Math.min(w.plan.end, Math.max(w.readTo, w.next));
      onSample();
    } finally {
      sample.close();
    }
  }
  // Ran out early (end of the media): count the part as read
  w.readTo = Math.max(w.readTo, Math.min(to, w.plan.end));
}
