// Auto subtitle sync: reads a few windows of a video's audio with mediabunny and turns them into speech activity.
// Runs inside the worker (worker.ts), so decoding never blocks playback.
import type { InputAudioTrack } from "mediabunny";
import {
  SpeechActivityMeter,
  downmix,
  planWindows,
  speechActivity,
  windowSecondsForBitrate,
  type ActivityWindow,
  type Cue,
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
  /** Give up when nothing was read for this long (ms): slow servers, ones that ignore range requests */
  stallTimeoutMs: number;
  onProgress?: (fraction: number) => void;
  /** Called after each window with everything read so far; return true to stop reading (a clear match) */
  onWindow?: (windows: ActivityWindow[]) => boolean;
}

export class AudioReadError extends Error {}

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
            getRetryDelay: (attempts) => (attempts < 3 ? attempts + 1 : null),
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
  const totalSeconds = plan.reduce((s, w) => s + (w.end - w.start), 0);
  let doneSeconds = 0;
  const sink = new mb.AudioSampleSink(track);
  const windows: ActivityWindow[] = [];
  for (const w of plan) {
    let meter: SpeechActivityMeter | undefined;
    let start = w.start;
    let mono = new Float32Array(0);
    let planes: Float32Array[] = [];
    for await (const sample of sink.samples(w.start, w.end)) {
      try {
        if (!meter) {
          meter = new SpeechActivityMeter(sample.sampleRate);
          start = Math.max(0, sample.timestamp);
        }
        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
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
        meter.push(downmix(planes.slice(0, channels), mono));
        touch();
        opts.onProgress?.(
          Math.min(
            1,
            (doneSeconds + Math.max(0, sample.timestamp - w.start)) /
              totalSeconds,
          ),
        );
      } finally {
        sample.close();
      }
    }
    doneSeconds += w.end - w.start;
    if (meter) {
      windows.push({ start, activity: speechActivity(meter.frames()) });
      if (opts.onWindow?.(windows)) {
        break;
      }
    }
  }
  return { windows, duration };
}
