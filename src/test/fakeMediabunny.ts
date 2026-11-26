// A small fake of the parts of `mediabunny` the client uses (Input, tracks, Conversion, Output, AudioSampleSink),
// driven by a mutable `mb` state the test sets up. Use it from a mock factory:
//
//   vi.mock("mediabunny", async () => (await import("../test/fakeMediabunny")).mediabunnyModule);
//   vi.mock("@mediabunny/ac3", async () => (await import("../test/fakeMediabunny")).ac3Module);
//   const { mb, resetMediabunny, fakeVideoTrack, fakeAudioTrack } = await import("../test/fakeMediabunny");
import { vi } from "vitest";

export interface FakeTrackOptions {
  id?: number;
  codec?: string | null;
  codecString?: string | null;
  canDecode?: boolean | "throw";
}

export interface FakeVideoTrack {
  type: "video";
  id: number;
  codec: string | null;
  displayWidth: number;
  displayHeight: number;
  getCodecParameterString: () => Promise<string | null>;
  canDecode: () => Promise<boolean>;
}

export interface FakeAudioTrack {
  type: "audio";
  id: number;
  codec: string | null;
  languageCode: string;
  name: string | null;
  numberOfChannels: number;
  sampleRate: number;
  disposition?: { default?: boolean; original?: boolean; commentary?: boolean };
  getCodecParameterString: () => Promise<string | null>;
  canDecode: () => Promise<boolean>;
}

const canDecodeFn = (v: FakeTrackOptions["canDecode"]) => () =>
  v === "throw"
    ? Promise.reject(new Error("no decoder"))
    : Promise.resolve(v ?? true);

export function fakeVideoTrack(
  o: FakeTrackOptions & { width?: number; height?: number } = {},
): FakeVideoTrack {
  return {
    type: "video",
    id: o.id ?? 1,
    codec: o.codec === undefined ? "avc" : o.codec,
    displayWidth: o.width ?? 1920,
    displayHeight: o.height ?? 1080,
    getCodecParameterString: async () =>
      o.codecString === undefined ? "avc1.640028" : o.codecString,
    canDecode: canDecodeFn(o.canDecode),
  };
}

export function fakeAudioTrack(
  o: FakeTrackOptions & {
    language?: string;
    name?: string | null;
    channels?: number;
    sampleRate?: number;
    disposition?: FakeAudioTrack["disposition"];
  } = {},
): FakeAudioTrack {
  return {
    type: "audio",
    id: o.id ?? 2,
    codec: o.codec === undefined ? "aac" : o.codec,
    languageCode: o.language ?? "eng",
    name: o.name ?? null,
    numberOfChannels: o.channels ?? 2,
    sampleRate: o.sampleRate ?? 48000,
    disposition: o.disposition,
    getCodecParameterString: async () =>
      o.codecString === undefined ? "mp4a.40.2" : o.codecString,
    canDecode: canDecodeFn(o.canDecode),
  };
}

/** One decoded audio chunk for AudioSampleSink */
export interface FakeSampleSpec {
  timestamp: number;
  sampleRate: number;
  /** One array per channel */
  planes: Float32Array[];
}

interface MbState {
  video: FakeVideoTrack | null;
  audio: FakeAudioTrack[];
  /** Defaults to the first audio track */
  primaryAudio?: FakeAudioTrack | null;
  duration: number;
  format: { name: string; mimeType: string };
  mimeType: string;
  size: number | null;
  /** Makes getAudioTracks() reject (unreadable source) */
  readError: Error | null;
  /** Never resolve reads (for timeouts) */
  hang: boolean;
  /** MP4 output's codecs */
  mp4Codecs: string[];
  /** Which encoders "exist" */
  canEncodeVideo: (codec: string, o: unknown) => boolean;
  canEncodeAudio: (codec: string, o: unknown) => boolean;
  /** What Output.getMimeType() resolves with */
  outputMime: string;
  /** Conversion.init result details */
  conversionValid: boolean;
  discarded: {
    track: { id: number; type: string; codec: string | null };
    reason: string;
  }[];
  /** Chunks each conversion writes when executed */
  chunks: Uint8Array[];
  /** How a conversion's execute() ends: resolve (default), reject with this error, or stay pending ("hold") */
  executeResult: "resolve" | "hold" | Error;
  /** AudioSampleSink samples, per call to samples(start, end) */
  samples: (start: number, end: number) => FakeSampleSpec[];
}

function initialState(): MbState {
  return {
    video: fakeVideoTrack(),
    audio: [fakeAudioTrack()],
    primaryAudio: undefined,
    duration: 600,
    format: { name: "MP4", mimeType: "video/mp4" },
    mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    size: 100e6,
    readError: null,
    hang: false,
    mp4Codecs: [
      "avc",
      "hevc",
      "vp9",
      "av1",
      "aac",
      "opus",
      "mp3",
      "flac",
      "ac3",
      "eac3",
    ],
    canEncodeVideo: () => true,
    canEncodeAudio: () => true,
    outputMime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    conversionValid: true,
    discarded: [],
    chunks: [new Uint8Array([1]), new Uint8Array([2])],
    executeResult: "resolve",
    samples: () => [],
  };
}

export const mb: MbState = initialState();

/** Everything created through the fake, for assertions */
export const created = {
  inputs: [] as FakeInput[],
  conversions: [] as FakeConversion[],
  urlSources: [] as { url: string; opts: any }[],
};

export function resetMediabunny() {
  Object.assign(mb, initialState());
  created.inputs.length = 0;
  created.conversions.length = 0;
  created.urlSources.length = 0;
  ac3Module.registerAc3Decoder.mockClear();
}

const never = () => new Promise<never>(() => {});
const read = <T>(fn: () => T): Promise<T> => {
  if (mb.hang) return never();
  if (mb.readError) return Promise.reject(mb.readError);
  return Promise.resolve(fn());
};

class UrlSource {
  url: string;
  opts: any;
  constructor(url: string, opts?: any) {
    this.url = url;
    this.opts = opts;
    created.urlSources.push({ url, opts });
  }
  getSizeOrNull = async () => mb.size;
}
class BlobSource {
  blob: Blob;
  constructor(blob: Blob) {
    this.blob = blob;
  }
  getSizeOrNull = async () => mb.size;
}

class FakeInput {
  source: UrlSource | BlobSource;
  disposed = false;
  constructor(o: { source: UrlSource | BlobSource }) {
    this.source = o.source;
    created.inputs.push(this);
  }
  getAudioTracks = () => read(() => mb.audio);
  getPrimaryVideoTrack = () => read(() => mb.video);
  getPrimaryAudioTrack = () =>
    read(() =>
      mb.primaryAudio === undefined ? (mb.audio[0] ?? null) : mb.primaryAudio,
    );
  computeDuration = () => read(() => mb.duration);
  getFormat = () => read(() => mb.format);
  getMimeType = () => read(() => mb.mimeType);
  dispose = vi.fn(() => {
    this.disposed = true;
  });
}

class Mp4OutputFormat {
  opts: unknown;
  constructor(opts?: unknown) {
    this.opts = opts;
  }
  getSupportedCodecs() {
    return mb.mp4Codecs;
  }
}

class AppendOnlyStreamTarget {
  writable: WritableStream<Uint8Array>;
  constructor(w: WritableStream<Uint8Array>) {
    this.writable = w;
  }
}

class Output {
  format: unknown;
  target: AppendOnlyStreamTarget;
  constructor(o: { format: unknown; target: AppendOnlyStreamTarget }) {
    this.format = o.format;
    this.target = o.target;
  }
  getMimeType = async () => mb.outputMime;
}

export class FakeConversion {
  opts: any;
  isValid = mb.conversionValid;
  discardedTracks = mb.discarded;
  onProgress: ((f: number) => void) | null = null;
  cancelled = false;
  /** The resolved per-track options the conversion asked for */
  videoOptions: Record<number, unknown> = {};
  audioOptions: Record<number, unknown> = {};
  cancel = vi.fn(async () => {
    this.cancelled = true;
    this.outcome ??= {};
    this.release?.();
  });
  private release?: () => void;
  private fail?: (e: Error) => void;
  /** Ends a conversion started with `executeResult: "hold"`: resolves, or rejects with `err` */
  finish(err?: Error) {
    this.outcome = { err };
    if (err) this.fail?.(err);
    else this.release?.();
  }
  private outcome?: { err?: Error };
  constructor(opts: any) {
    this.opts = opts;
  }
  /** Writes the configured chunks, reports progress, then ends per `mb.executeResult` */
  execute = vi.fn(async () => {
    const writer = this.opts.output.target.writable.getWriter();
    for (const c of mb.chunks) {
      if (this.cancelled) break;
      await writer.write(c);
    }
    this.onProgress?.(0.5);
    const result = mb.executeResult;
    if (result === "hold") {
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        this.fail = reject;
        // finish() may come before execute() got here
        if (this.outcome?.err) reject(this.outcome.err);
        else if (this.outcome) resolve();
      });
      return;
    }
    if (result instanceof Error) throw result;
    this.onProgress?.(1);
  });
}

const Conversion = {
  init: vi.fn(async (opts: any) => {
    const c = new FakeConversion(opts);
    if (mb.video && opts.video) {
      c.videoOptions[mb.video.id] = await opts.video(mb.video);
    }
    for (const t of mb.audio) {
      if (opts.audio) c.audioOptions[t.id] = await opts.audio(t);
    }
    created.conversions.push(c);
    return c;
  }),
};

class AudioSampleSink {
  track: unknown;
  constructor(track: unknown) {
    this.track = track;
  }
  async *samples(start: number, end: number) {
    for (const s of mb.samples(start, end)) {
      yield {
        timestamp: s.timestamp,
        sampleRate: s.sampleRate,
        numberOfFrames: s.planes[0]?.length ?? 0,
        numberOfChannels: s.planes.length,
        copyTo(dest: Float32Array, o: { planeIndex: number }) {
          dest.set(s.planes[o.planeIndex]);
        },
        close: vi.fn(),
      };
    }
  }
}

export const mediabunnyModule = {
  Input: FakeInput,
  UrlSource,
  BlobSource,
  ALL_FORMATS: ["all"],
  Mp4OutputFormat,
  Output,
  AppendOnlyStreamTarget,
  Conversion,
  AudioSampleSink,
  QUALITY_MEDIUM: "medium",
  canEncodeVideo: vi.fn(async (codec: string, o: unknown) =>
    mb.canEncodeVideo(codec, o),
  ),
  canEncodeAudio: vi.fn(async (codec: string, o: unknown) =>
    mb.canEncodeAudio(codec, o),
  ),
};

export const ac3Module = { registerAc3Decoder: vi.fn() };
