// probeMedia (what this browser can do with each track) and the ClientTranscoder (copy or re-encode each track into
// fragmented MP4 for MediaSource) against a fake mediabunny and a fake MediaSource.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "mediabunny",
  async () => (await import("../test/fakeMediabunny")).mediabunnyModule,
);
vi.mock(
  "@mediabunny/ac3",
  async () => (await import("../test/fakeMediabunny")).ac3Module,
);

const {
  mb,
  created,
  resetMediabunny,
  fakeVideoTrack,
  fakeAudioTrack,
  ac3Module,
} = await import("../test/fakeMediabunny");
const {
  ClientTranscoder,
  describeAudioTracks,
  isClientTranscodeSupported,
  languageName,
  probeMedia,
} = await import("./clientTranscode");

// --- Fake MediaSource / SourceBuffer ---

/** Which MSE types are "supported"; tests replace it */
let mseSupported: (type: string) => boolean = () => true;

class FakeSourceBuffer extends EventTarget {
  mime: string;
  appended: Uint8Array[] = [];
  removed: [number, number][] = [];
  ranges: [number, number][] = [];
  timestampOffset = 0;
  /** Throw QuotaExceededError on the next append */
  quotaOnce = false;
  /** Fire "error" instead of "updateend" on the next operation */
  errorOnce = false;
  abort = vi.fn();
  changeType = vi.fn((mime: string) => {
    this.mime = mime;
  });
  constructor(mime: string) {
    super();
    this.mime = mime;
  }
  get buffered() {
    const r = this.ranges;
    return {
      length: r.length,
      start: (i: number) => r[i][0],
      end: (i: number) => r[i][1],
    };
  }
  private done() {
    queueMicrotask(() => {
      if (this.errorOnce) {
        this.errorOnce = false;
        this.dispatchEvent(new Event("error"));
      } else {
        this.dispatchEvent(new Event("updateend"));
      }
    });
  }
  appendBuffer(chunk: Uint8Array) {
    if (this.quotaOnce) {
      this.quotaOnce = false;
      throw new DOMException("full", "QuotaExceededError");
    }
    this.appended.push(chunk);
    this.done();
  }
  remove(start: number, end: number) {
    this.removed.push([start, end]);
    this.done();
  }
}

const mediaSources: FakeMediaSource[] = [];
/** Lets a test configure each MediaSource / SourceBuffer as it's created (before anything is appended) */
let onMediaSource: (ms: FakeMediaSource) => void = () => {};
let onSourceBuffer: (sb: FakeSourceBuffer) => void = () => {};
class FakeMediaSource extends EventTarget {
  readyState = "closed";
  duration = NaN;
  buffers: FakeSourceBuffer[] = [];
  endOfStream = vi.fn(() => {
    this.readyState = "ended";
  });
  static isTypeSupported = vi.fn((type: string) => mseSupported(type));
  constructor() {
    super();
    mediaSources.push(this);
    onMediaSource(this);
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  addSourceBuffer(mime: string) {
    const sb = new FakeSourceBuffer(mime);
    this.buffers.push(sb);
    onSourceBuffer(sb);
    return sb;
  }
}

const transcodeGlobals = () => {
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("AudioDecoder", class {});
  vi.stubGlobal("AudioEncoder", class {});
};

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

let canPlay: (type: string) => string = () => "";

beforeEach(() => {
  resetMediabunny();
  mediaSources.length = 0;
  onMediaSource = () => {};
  onSourceBuffer = () => {};
  mseSupported = () => true;
  canPlay = () => "";
  vi.stubGlobal("MediaSource", FakeMediaSource);
  FakeMediaSource.isTypeSupported.mockClear();
  transcodeGlobals();
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation(
    (type: string) => canPlay(type) as CanPlayTypeResult,
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-media-source");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isClientTranscodeSupported", () => {
  it("needs WebCodecs (decode + encode) and MediaSource", () => {
    expect(isClientTranscodeSupported()).toBe(true);
    vi.stubGlobal("AudioEncoder", undefined);
    expect(isClientTranscodeSupported()).toBe(false);
  });
});

describe("languageName", () => {
  it("names ISO 639 codes and ignores unknown/undetermined ones", () => {
    expect(languageName("jpn")).toBe("Japanese");
    expect(languageName("und")).toBeUndefined();
    expect(languageName("")).toBeUndefined();
    // Invalid language tags throw inside Intl.DisplayNames
    expect(languageName("not a code!")).toBeUndefined();
  });
});

describe("describeAudioTracks", () => {
  const t = (
    id: number,
    languageCode: string,
    name: string | null,
    codec: string | null,
    numberOfChannels: number,
  ) => ({ id, languageCode, name, codec, numberOfChannels }) as any;

  it("builds language · title · format labels", () => {
    const [jp, en, odd] = describeAudioTracks([
      t(1, "jpn", "Commentary", "ac3", 6),
      t(2, "eng", "English", "aac", 2),
      t(3, "und", null, "pcm-s16", 3),
    ]);
    expect(jp.label).toBe("Japanese · Commentary · AC-3 5.1");
    // A title that only repeats the language is dropped
    expect(en.label).toBe("English · AAC Stereo");
    // Unknown codecs are upper-cased, odd channel counts are "Nch"
    expect(odd.label).toBe("PCM-S16 3ch");
    expect(jp).toMatchObject({
      id: 1,
      languageCode: "jpn",
      name: "Commentary",
      codec: "ac3",
      channels: 6,
    });
  });

  it("falls back to the code, then to Track N", () => {
    const [a, b, c] = describeAudioTracks([
      t(1, "qaa", null, null, 0),
      t(2, "und", "  ", null, 0),
      t(3, "fre", null, "opus", 1),
    ]);
    expect(a.label).toBe("QAA");
    expect(b.label).toBe("Track 2");
    expect(c.label).toBe("French · Opus Mono");
  });

  it("numbers identical labels so they can be told apart", () => {
    const infos = describeAudioTracks([
      t(1, "eng", null, "aac", 2),
      t(2, "eng", null, "aac", 2),
      t(3, "eng", null, "eac3", 8),
    ]);
    expect(infos.map((i) => i.label)).toEqual([
      "English · AAC Stereo (#1)",
      "English · AAC Stereo (#2)",
      "English · E-AC-3 7.1",
    ]);
  });
});

describe("probeMedia", () => {
  it("reports an H.264 + AAC MP4 as native and copyable, with no encoders probed", async () => {
    canPlay = () => "probably";
    const result = await probeMedia("https://cdn.example.com/movie.mp4");
    expect(result).toEqual({
      container: "mp4",
      containerNative: true,
      video: {
        id: 1,
        codec: "avc",
        height: 1080,
        native: true,
        copy: true,
        decode: true,
      },
      audio: [
        {
          id: 2,
          codec: "aac",
          language: "eng",
          name: null,
          channels: 2,
          default: false,
          original: false,
          commentary: false,
          native: true,
          copy: true,
          decode: true,
        },
      ],
      transcodeSupported: true,
      encodeVideo: false,
      encodeAudio: false,
    });
    expect(created.urlSources[0].url).toBe("https://cdn.example.com/movie.mp4");
    expect(created.inputs[0].dispose).toHaveBeenCalled();
    expect(mb.mp4Codecs).toContain("avc");
  });

  it("finds encoders for an HEVC MKV with Dolby and DTS audio", async () => {
    mb.format = { name: "Matroska", mimeType: "video/x-matroska" };
    mb.video = fakeVideoTrack({
      codec: "hevc",
      codecString: "hvc1.2.4.L153",
      width: 3840,
      height: 2160,
    });
    mb.audio = [
      fakeAudioTrack({
        id: 2,
        codec: "eac3",
        codecString: "ec-3",
        language: "",
        disposition: { default: true, original: true },
      }),
      fakeAudioTrack({
        id: 3,
        codec: "dts",
        codecString: null,
        name: "Commentary",
        disposition: { commentary: true },
        canDecode: "throw",
      }),
    ];
    // Neither HEVC nor E-AC-3 plays from MP4 here; H.264 and AAC do
    mseSupported = (type) => /avc1|mp4a/.test(type);
    const result = await probeMedia("https://cdn.example.com/movie.mkv");
    expect(result.container).toBe("matroska");
    expect(result.containerNative).toBe(false);
    expect(result.video).toMatchObject({
      codec: "hevc",
      copy: false,
      decode: true,
      height: 2160,
    });
    expect(result.audio[0]).toMatchObject({
      language: "und",
      default: true,
      original: true,
      copy: false,
      decode: true,
    });
    expect(result.audio[1]).toMatchObject({
      commentary: true,
      copy: false,
      decode: false,
      native: false,
    });
    expect(result.encodeVideo).toBe(true);
    expect(result.encodeAudio).toBe(true);
    // Downscaled to 1080p for the encoder probe
    expect((await import("mediabunny")).canEncodeVideo).toHaveBeenCalledWith(
      "avc",
      { width: 1920, height: 1080 },
    );
    expect(ac3Module.registerAc3Decoder).toHaveBeenCalled();
  });

  it("tries the next encoder candidate and reports none when nothing encodes", async () => {
    mb.video = fakeVideoTrack({ codec: "hevc", codecString: "hvc1" });
    mb.audio = [fakeAudioTrack({ codec: "flac", codecString: "fLaC" })];
    mseSupported = (type) => !/hvc1|fLaC/.test(type);
    mb.canEncodeVideo = (codec) => codec === "av1";
    mb.canEncodeAudio = () => false;
    const result = await probeMedia("https://cdn.example.com/a.mkv");
    expect(result.encodeVideo).toBe(true);
    expect(result.encodeAudio).toBe(false);

    mb.canEncodeVideo = () => false;
    expect(
      (await probeMedia("https://cdn.example.com/a.mkv")).encodeVideo,
    ).toBe(false);
  });

  it("without WebCodecs nothing decodes or encodes", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    mb.video = fakeVideoTrack({ codec: "hevc", codecString: "hvc1" });
    mseSupported = (type) => !type.includes("hvc1");
    const result = await probeMedia("https://cdn.example.com/a.mkv");
    expect(result.transcodeSupported).toBe(false);
    expect(result.video).toMatchObject({ copy: false, decode: false });
    expect(result.audio[0].decode).toBe(false);
    expect(result.encodeVideo).toBe(false);
  });

  it("without MediaSource nothing can be copied", async () => {
    vi.stubGlobal("MediaSource", undefined);
    mb.video = null;
    mb.audio = [fakeAudioTrack({ codec: null, codecString: null })];
    const result = await probeMedia("https://cdn.example.com/a.mp3");
    expect(result.video).toBeNull();
    expect(result.audio[0]).toMatchObject({ copy: false, native: false });
    expect(result.transcodeSupported).toBe(false);
  });

  it("rejects (and closes the input) when the URL can't be read", async () => {
    mb.readError = new Error("CORS");
    await expect(probeMedia("https://cdn.example.com/a.mp4")).rejects.toThrow(
      "CORS",
    );
    expect(created.inputs[0].dispose).toHaveBeenCalled();
  });

  it("gives up after 15 s", async () => {
    vi.useFakeTimers();
    mb.hang = true;
    const p = probeMedia("https://cdn.example.com/slow.mp4");
    const assertion = expect(p).rejects.toThrow("Timed out reading the video");
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(created.inputs[0].dispose).toHaveBeenCalled();
  });
});

// --- ClientTranscoder ---

function setup(
  opts: Partial<ConstructorParameters<typeof ClientTranscoder>[0]> = {},
) {
  const video = document.createElement("video");
  const onProgress = vi.fn();
  const onError = vi.fn();
  const onAudioTracks = vi.fn();
  const transcoder = new ClientTranscoder({
    source: "https://cdn.example.com/movie.mkv",
    video,
    onProgress,
    onError,
    onAudioTracks,
    ...opts,
  });
  return { transcoder, video, onProgress, onError, onAudioTracks };
}
const sb = () => mediaSources[0].buffers[0];
const lastConversion = () => created.conversions.at(-1)!;

describe("ClientTranscoder", () => {
  it("copies playable tracks, appends the output and ends the stream", async () => {
    mb.audio = [
      fakeAudioTrack({ id: 2, language: "eng" }),
      fakeAudioTrack({ id: 3, language: "jpn" }),
    ];
    const { transcoder, video, onProgress, onAudioTracks } = setup();
    await transcoder.start();

    expect(video.src).toContain("blob:fake-media-source");
    expect(mediaSources[0].duration).toBe(600);
    expect(onAudioTracks).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 2, label: "English · AAC Stereo" }),
        expect.objectContaining({ id: 3, label: "Japanese · AAC Stereo" }),
      ],
      2,
    );
    expect(transcoder.getAudioTracks()).toHaveLength(2);
    expect(transcoder.getSelectedAudioTrackId()).toBe(2);
    const conv = lastConversion();
    expect(conv.opts.trim).toBeUndefined();
    expect(conv.opts.tracks).toBe("all");
    // Copy as-is; the other audio track is discarded
    expect(conv.videoOptions[1]).toEqual({});
    expect(conv.audioOptions).toEqual({ 2: {}, 3: { discard: true } });
    expect(conv.opts.video(fakeVideoTrack({ id: 9 }))).toEqual({
      discard: true,
    });

    await waitFor(() => mediaSources[0].endOfStream.mock.calls.length > 0);
    expect(sb().mime).toBe(mb.outputMime);
    expect(sb().appended).toEqual(mb.chunks);
    expect(sb().timestampOffset).toBe(0);
    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it("re-encodes 4K HEVC to 1080p H.264 and DTS to stereo AAC", async () => {
    mb.video = fakeVideoTrack({
      codec: "hevc",
      codecString: "hvc1",
      width: 3840,
      height: 2160,
    });
    mb.audio = [fakeAudioTrack({ codec: "dts", codecString: "dtsc" })];
    mseSupported = (type) => !/hvc1|dtsc/.test(type);
    const { transcoder } = setup();
    await transcoder.start();
    const conv = lastConversion();
    expect(conv.videoOptions[1]).toEqual({
      codec: "avc",
      forceTranscode: true,
      height: 1080,
      quality: "medium",
      keyFrameInterval: 2,
    });
    expect(conv.audioOptions[2]).toEqual({
      codec: "aac",
      forceTranscode: true,
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    transcoder.stop();
  });

  it("falls back to VP9 / Opus when H.264 / AAC can't be played or encoded", async () => {
    mb.video = fakeVideoTrack({
      codec: "hevc",
      codecString: "hvc1",
      height: 720,
      width: 1280,
    });
    mb.audio = [fakeAudioTrack({ codec: "dts", codecString: "dtsc" })];
    mseSupported = (type) => !/hvc1|dtsc|avc1/.test(type);
    mb.canEncodeAudio = (codec) => codec === "opus";
    mb.outputMime = 'video/mp4; codecs="vp09.00.10.08, opus"';
    const { transcoder } = setup();
    await transcoder.start();
    const conv = lastConversion();
    // 720p isn't downscaled
    expect(conv.videoOptions[1]).toEqual({
      codec: "vp9",
      forceTranscode: true,
      quality: "medium",
      keyFrameInterval: 2,
    });
    expect(conv.audioOptions[2]).toMatchObject({ codec: "opus" });
    transcoder.stop();
  });

  it("fails when no playable video format can be encoded", async () => {
    mb.video = fakeVideoTrack({ codec: "hevc", codecString: "hvc1" });
    mseSupported = (type) => !type.includes("hvc1");
    mb.canEncodeVideo = () => false;
    await expect(setup().transcoder.start()).rejects.toThrow(
      "can't encode a video format it can play back",
    );
  });

  it("fails when no playable audio format can be encoded", async () => {
    mb.audio = [fakeAudioTrack({ codec: "dts", codecString: "dtsc" })];
    mseSupported = (type) => !type.includes("dtsc");
    mb.canEncodeAudio = () => false;
    await expect(setup().transcoder.start()).rejects.toThrow(
      "can't encode a compatible audio format",
    );
  });

  it("reports an unreadable file", async () => {
    mb.readError = new Error("403");
    await expect(setup().transcoder.start()).rejects.toThrow(
      "Couldn't read this file: 403",
    );
    mb.readError = "nope" as unknown as Error;
    await expect(setup().transcoder.start()).rejects.toThrow(
      /^Couldn't read this file$/,
    );
  });

  it("explains why an invalid conversion can't run, ignoring tracks skipped on purpose", async () => {
    mb.conversionValid = false;
    mb.discarded = [
      {
        track: { id: 1, type: "video", codec: "hevc" },
        reason: "undecodable_source_codec",
      },
      {
        track: { id: 4, type: "audio", codec: null },
        reason: "no_encodable_target_codec",
      },
      {
        track: { id: 5, type: "audio", codec: "aac" },
        reason: "discarded_by_user",
      },
    ];
    await expect(setup().transcoder.start()).rejects.toThrow(
      "This file can't be converted in your browser — video track (hevc): undecodable source codec; audio track (unknown codec): no encodable target codec",
    );
    mb.discarded = [];
    await expect(setup().transcoder.start()).rejects.toThrow(
      /^This file can't be converted in your browser$/,
    );
  });

  it("plays without sound when the default audio can't be converted, but not when it was chosen", async () => {
    mb.discarded = [
      {
        track: { id: 2, type: "audio", codec: "dts" },
        reason: "undecodable_source_codec",
      },
    ];
    const silent = setup();
    await silent.transcoder.start();
    expect(console.warn).toHaveBeenCalledWith(
      "[clientTranscode]",
      expect.stringContaining('Can\'t play audio track "English · AAC Stereo"'),
    );
    silent.transcoder.stop();

    const chosen = setup({ audioTrackId: 2 });
    await expect(chosen.transcoder.start()).rejects.toThrow(
      'Can\'t play audio track "English · AAC Stereo" in this browser (undecodable source codec)',
    );
    expect(lastConversion().cancel).toHaveBeenCalled();
  });

  it("fails when the converted output can't be played through MediaSource", async () => {
    mseSupported = (type) =>
      !type.startsWith('video/mp4; codecs="avc1.640028, mp4a');
    await expect(setup().transcoder.start()).rejects.toThrow(
      "This browser can't play the converted video",
    );
  });

  it("starts at startTime (clamped to the duration) with offset timestamps", async () => {
    const { transcoder, video } = setup({ startTime: 9999 });
    await transcoder.start();
    expect(lastConversion().opts.trim).toEqual({ start: 600 });
    expect(video.currentTime).toBe(600);
    expect(sb().timestampOffset).toBe(600);
    transcoder.stop();
  });

  it("starts at 0 for a negative start time and keeps an unknown duration", async () => {
    mb.duration = Infinity;
    const { transcoder } = setup({ startTime: -5 });
    await transcoder.start();
    expect(lastConversion().opts.trim).toBeUndefined();
    expect(Number.isNaN(mediaSources[0].duration)).toBe(true);
    transcoder.stop();
  });

  describe("choosing the audio track", () => {
    it("skips an unplayable primary track (DTS) for a playable one (AC-3)", async () => {
      mb.audio = [
        fakeAudioTrack({
          id: 2,
          codec: "dts",
          codecString: "dtsc",
          canDecode: false,
        }),
        fakeAudioTrack({
          id: 3,
          codec: "ac3",
          codecString: "ac-3",
          canDecode: true,
        }),
      ];
      mseSupported = (type) => !/dtsc|ac-3/.test(type);
      const { transcoder } = setup();
      await transcoder.start();
      expect(transcoder.getSelectedAudioTrackId()).toBe(3);
      transcoder.stop();
    });

    it("keeps the primary track when nothing is playable, and handles files without audio", async () => {
      mb.audio = [
        fakeAudioTrack({
          id: 2,
          codec: "dts",
          codecString: null,
          canDecode: false,
        }),
        fakeAudioTrack({
          id: 3,
          codec: "truehd",
          codecString: null,
          canDecode: false,
        }),
      ];
      const a = setup();
      await a.transcoder.start();
      expect(a.transcoder.getSelectedAudioTrackId()).toBe(2);
      a.transcoder.stop();

      mb.audio = [];
      const b = setup();
      await b.transcoder.start();
      expect(b.transcoder.getSelectedAudioTrackId()).toBeUndefined();
      b.transcoder.stop();
    });

    it("starts with the requested track", async () => {
      mb.audio = [
        fakeAudioTrack({ id: 2 }),
        fakeAudioTrack({ id: 3, codec: "eac3", codecString: "ec-3" }),
      ];
      const { transcoder } = setup({ audioTrackId: 3 });
      await transcoder.start();
      expect(transcoder.getSelectedAudioTrackId()).toBe(3);
      transcoder.stop();
    });
  });

  describe("selectAudioTrack", () => {
    it("restarts at the playhead with the new track and drops what's buffered ahead", async () => {
      mb.audio = [
        fakeAudioTrack({ id: 2 }),
        fakeAudioTrack({ id: 3, language: "jpn" }),
      ];
      mb.executeResult = "hold";
      const { transcoder, video, onAudioTracks } = setup();
      await transcoder.start();
      const first = lastConversion();
      video.currentTime = 42;
      await transcoder.selectAudioTrack(3);
      expect(first.cancel).toHaveBeenCalled();
      expect(transcoder.getSelectedAudioTrackId()).toBe(3);
      expect(onAudioTracks).toHaveBeenLastCalledWith(expect.any(Array), 3);
      expect(sb().removed).toContainEqual([42, Infinity]);
      expect(sb().abort).toHaveBeenCalled();
      expect(sb().timestampOffset).toBe(42);
      const second = lastConversion();
      expect(second.opts.trim).toEqual({ start: 42 });
      expect(second.audioOptions).toEqual({ 2: { discard: true }, 3: {} });
      // Same track again: nothing to do
      await transcoder.selectAudioTrack(3);
      expect(created.conversions).toHaveLength(2);
      transcoder.stop();
    });

    it("rejects unknown tracks and does nothing before start or after stop", async () => {
      const { transcoder } = setup();
      await transcoder.selectAudioTrack(7); // not started
      await transcoder.start();
      await expect(transcoder.selectAudioTrack(7)).rejects.toThrow(
        "That audio track doesn't exist",
      );
      transcoder.stop();
      await transcoder.selectAudioTrack(2);
      expect(created.conversions).toHaveLength(1);
    });

    it("goes back to the previous track when the new one can't be played", async () => {
      mb.audio = [
        fakeAudioTrack({ id: 2 }),
        fakeAudioTrack({ id: 3, codec: "dts", codecString: "dtsc" }),
      ];
      mseSupported = (type) => !type.includes("dtsc");
      mb.canEncodeAudio = () => false;
      mb.executeResult = "hold";
      const { transcoder, onAudioTracks, onError } = setup();
      await transcoder.start();
      await expect(transcoder.selectAudioTrack(3)).rejects.toThrow(
        "can't encode a compatible audio format",
      );
      expect(transcoder.getSelectedAudioTrackId()).toBe(2);
      expect(onAudioTracks).toHaveBeenLastCalledWith(expect.any(Array), 2);
      // Playing the old track again
      expect(lastConversion().audioOptions[2]).toEqual({});
      expect(onError).not.toHaveBeenCalled();
      transcoder.stop();
    });

    it("reports an error when even the previous track can't restart", async () => {
      mb.audio = [fakeAudioTrack({ id: 2 }), fakeAudioTrack({ id: 3 })];
      mb.executeResult = "hold";
      const { transcoder, onError } = setup();
      await transcoder.start();
      // From now on every conversion is invalid
      mb.conversionValid = false;
      await expect(transcoder.selectAudioTrack(3)).rejects.toThrow(
        "can't be converted",
      );
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  it("stop() cancels the conversion, releases everything and is idempotent", async () => {
    mb.executeResult = "hold";
    const { transcoder } = setup();
    await transcoder.start();
    const conv = lastConversion();
    transcoder.stop();
    transcoder.stop();
    expect(conv.cancel).toHaveBeenCalledTimes(1);
    expect(created.inputs[0].dispose).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-media-source");
  });

  it("an error after start is reported through onError and stops the transcoder", async () => {
    mb.executeResult = "hold";
    const { transcoder, onError } = setup();
    await transcoder.start();
    lastConversion().finish(new Error("decoder crashed"));
    await waitFor(() => onError.mock.calls.length > 0);
    expect(onError.mock.calls[0][0].message).toBe("decoder crashed");
    expect(created.inputs[0].dispose).toHaveBeenCalled();
  });

  it("wraps non-Error failures", async () => {
    mb.executeResult = "hold";
    const { transcoder, onError } = setup();
    await transcoder.start();
    lastConversion().finish("weird" as unknown as Error);
    await waitFor(() => onError.mock.calls.length > 0);
    expect(onError.mock.calls[0][0]).toEqual(new Error("weird"));
  });

  it("a failure before start resolves doesn't call onError", async () => {
    mb.executeResult = new Error("early");
    mb.chunks = [];
    const { transcoder, onError } = setup();
    await transcoder.start();
    expect(onError).not.toHaveBeenCalled();
  });

  it("a SourceBuffer error stops the transcoder", async () => {
    mb.executeResult = "hold";
    mb.chunks = [new Uint8Array([1])];
    const { transcoder, onError } = setup();
    onSourceBuffer = (b) => (b.errorOnce = true);
    await transcoder.start();
    // Before start() resolved, so it isn't reported through onError
    expect(onError).not.toHaveBeenCalled();
    expect(created.inputs[0].dispose).toHaveBeenCalled();
    expect(lastConversion().cancel).toHaveBeenCalled();
  });

  it("retries an append after freeing space behind the playhead when the buffer is full", async () => {
    mb.executeResult = "hold";
    mb.chunks = [new Uint8Array([1])];
    const { transcoder, video } = setup({ startTime: 50 });
    onSourceBuffer = (b) => (b.quotaOnce = true);
    await transcoder.start();
    expect(sb().removed).toContainEqual([0, 48]);
    expect(sb().appended).toHaveLength(1);
    expect(video.currentTime).toBe(50);
    transcoder.stop();
  });

  it("evicts data more than 30 s behind the playhead", async () => {
    mb.executeResult = "hold";
    mb.chunks = [new Uint8Array([1])];
    const { transcoder, video } = setup({ startTime: 100 });
    onSourceBuffer = (b) => (b.ranges = [[0, 101]]);
    await transcoder.start();
    expect(video.currentTime).toBe(100);
    expect(sb().removed).toContainEqual([0, 70]);
    transcoder.stop();
  });

  it("waits while it's 30 s ahead of the playhead", async () => {
    mb.executeResult = "hold";
    mb.chunks = [new Uint8Array([1])];
    const { transcoder, video } = setup();
    onSourceBuffer = (b) => (b.ranges = [[0, 40]]);
    const started = transcoder.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(sb().appended).toHaveLength(0);
    video.currentTime = 20;
    await started;
    expect(sb().appended).toHaveLength(1);
    transcoder.stop();
  });

  describe("seeking", () => {
    it("restarts the conversion at a seek target outside the buffer (debounced)", async () => {
      mb.executeResult = "hold";
      const { transcoder, video } = setup();
      await transcoder.start();
      sb().ranges = [[0, 20]];
      vi.useFakeTimers();
      video.currentTime = 10;
      video.dispatchEvent(new Event("seeking"));
      await vi.advanceTimersByTimeAsync(300);
      // Inside the buffer: nothing to do
      expect(created.conversions).toHaveLength(1);

      video.currentTime = 300;
      video.dispatchEvent(new Event("seeking"));
      video.currentTime = 310;
      video.dispatchEvent(new Event("seeking"));
      await vi.advanceTimersByTimeAsync(199);
      expect(created.conversions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await waitFor(() => created.conversions.length === 2);
      expect(lastConversion().opts.trim).toEqual({ start: 310 });
      expect(created.conversions[0].cancel).toHaveBeenCalled();
      await waitFor(() => sb().timestampOffset === 310);
      transcoder.stop();
    });

    it("still restarts when cancelling the old conversion fails", async () => {
      mb.executeResult = "hold";
      const { transcoder, video } = setup();
      await transcoder.start();
      created.conversions[0].cancel.mockRejectedValueOnce(new Error("busy"));
      video.currentTime = 400;
      video.dispatchEvent(new Event("seeking"));
      await waitFor(() => created.conversions.length === 2);
      expect(console.warn).toHaveBeenCalledWith(
        "[clientTranscode] cancel failed",
        expect.any(Error),
      );
      transcoder.stop();
    });

    it("doesn't restart when the data arrived during the debounce", async () => {
      mb.executeResult = "hold";
      const { transcoder, video } = setup();
      await transcoder.start();
      vi.useFakeTimers();
      video.currentTime = 300;
      video.dispatchEvent(new Event("seeking"));
      sb().ranges = [[290, 330]];
      await vi.advanceTimersByTimeAsync(300);
      expect(created.conversions).toHaveLength(1);
      transcoder.stop();
    });

    it("restarts when playback stalls somewhere nothing is converting", async () => {
      const { transcoder, video } = setup();
      await transcoder.start();
      // The conversion finished; seeking back into evicted data stalls
      await waitFor(() => mediaSources[0].endOfStream.mock.calls.length > 0);
      video.currentTime = 5;
      video.dispatchEvent(new Event("waiting"));
      await waitFor(() => created.conversions.length === 2);
      expect(lastConversion().opts.trim).toEqual({ start: 5 });
      transcoder.stop();
      // Stopped: events are ignored
      video.dispatchEvent(new Event("waiting"));
      expect(created.conversions).toHaveLength(2);
    });

    it("a stall at the head of the running conversion is normal", async () => {
      mb.executeResult = "hold";
      const { transcoder, video } = setup();
      await transcoder.start();
      video.currentTime = 30;
      video.dispatchEvent(new Event("waiting"));
      await flush();
      expect(created.conversions).toHaveLength(1);
      transcoder.stop();
    });

    it("changes the SourceBuffer type when a restart produces a different codec", async () => {
      mb.executeResult = "hold";
      const { transcoder, video } = setup();
      await transcoder.start();
      mb.outputMime = 'video/mp4; codecs="vp09.00.10.08, opus"';
      video.currentTime = 200;
      video.dispatchEvent(new Event("seeking"));
      await waitFor(() => sb().changeType.mock.calls.length > 0);
      expect(sb().changeType).toHaveBeenCalledWith(mb.outputMime);
      transcoder.stop();
    });

    it("a failed restart is reported", async () => {
      const { transcoder, video, onError } = setup();
      await transcoder.start();
      await waitFor(() => mediaSources[0].endOfStream.mock.calls.length > 0);
      mb.conversionValid = false;
      video.currentTime = 100;
      video.dispatchEvent(new Event("waiting"));
      await waitFor(() => onError.mock.calls.length > 0);
      expect(onError.mock.calls[0][0].message).toMatch("can't be converted");
    });
  });

  it("keeps going when endOfStream throws (local file source)", async () => {
    mb.chunks = [new Uint8Array([1])];
    const { transcoder } = setup({ source: new File(["x"], "movie.mkv") });
    onMediaSource = (ms) =>
      ms.endOfStream.mockImplementation(() => {
        throw new Error("InvalidStateError");
      });
    await transcoder.start();
    await waitFor(() => mediaSources[0].endOfStream.mock.calls.length > 0);
    expect(console.warn).toHaveBeenCalledWith(
      "[clientTranscode] endOfStream failed",
      expect.any(Error),
    );
    expect(created.urlSources).toHaveLength(0);
    transcoder.stop();
  });
});
