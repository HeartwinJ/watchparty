// useConvert: direct / convert / fail per device from the probe, the decode-error fallbacks, conversion failures,
// stale probes after a media change, audio tracks and the per-device setting. The transcoder and probe are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const probeMedia = vi.fn(async (_url: string): Promise<unknown> => {
  throw new Error("not readable");
});
const transcoders: FakeTranscoder[] = [];
class FakeTranscoder {
  /** The next transcoder's start() rejects with this */
  static nextStartError: unknown = null;
  opts: any;
  start = vi.fn(async () => {});
  stop = vi.fn();
  selectAudioTrack = vi.fn(async (_id: number) => {});
  constructor(opts: any) {
    this.opts = opts;
    transcoders.push(this);
    const err = FakeTranscoder.nextStartError;
    if (err) {
      FakeTranscoder.nextStartError = null;
      this.start = vi.fn(async () => {
        throw err;
      });
    }
  }
}
vi.mock("../../../utils/clientTranscode", () => ({
  ClientTranscoder: FakeTranscoder,
  probeMedia: (url: string) => probeMedia(url),
}));

const { useConvert, getConvertStatus } = await import("./useConvert");
const { useStore } = await import("./useStore");
const { createInitialRoomState, AUTO_CONVERT_KEY } =
  await import("../roomState");

const SRC = "https://cdn.example.com/movie.mkv";
const ALL = { native: true, copy: true, decode: true };
const probe = (p: Record<string, unknown> = {}) => ({
  container: "mp4",
  containerNative: true,
  video: { id: 1, codec: "avc", height: 1080, ...ALL },
  audio: [
    {
      id: 2,
      codec: "aac",
      language: "eng",
      name: null,
      channels: 2,
      default: true,
      original: false,
      commentary: false,
      ...ALL,
    },
  ],
  transcodeSupported: true,
  encodeVideo: true,
  encodeAudio: true,
  ...p,
});
const ac3Only = () =>
  probe({
    containerNative: false,
    audio: [
      {
        id: 3,
        codec: "ac3",
        language: "eng",
        name: null,
        channels: 6,
        default: true,
        original: false,
        commentary: false,
        native: false,
        copy: false,
        decode: true,
      },
    ],
  });

let video: HTMLVideoElement;

function setup() {
  const setSrcAndTime = vi.fn(async (_s: string, _t: number) => {});
  const player = {
    html: () => ({ getVideoEl: () => video }),
    current: () => ({ setSrcAndTime }),
  };
  const showError = vi.fn();
  const reportIssue = vi.fn();
  const onConvertStart = vi.fn();
  const hook = renderHook(() => {
    const [state, store] = useStore(createInitialRoomState);
    const convert = useConvert({
      store,
      player: player as any,
      showError,
      reportIssue,
      onConvertStart,
    });
    return { state, store, convert };
  });
  const c = () => hook.result.current.convert;
  const get = () => hook.result.current.store.get();
  const decodeError = (code: number) => {
    Object.defineProperty(video, "error", {
      configurable: true,
      value: { code },
    });
    video.dispatchEvent(new Event("error"));
  };
  return {
    ...hook,
    c,
    get,
    setSrcAndTime,
    showError,
    reportIssue,
    onConvertStart,
    decodeError,
  };
}

beforeEach(() => {
  transcoders.length = 0;
  probeMedia.mockReset();
  probeMedia.mockRejectedValue(new Error("not readable"));
  window.localStorage.clear();
  document.body.innerHTML = '<video id="leftVideo"></video>';
  video = document.getElementById("leftVideo") as HTMLVideoElement;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("getConvertStatus", () => {
  it("is null unless converting with progress", () => {
    expect(
      getConvertStatus({ playback: undefined, convertProgress: 0.5 }),
    ).toBeNull();
    expect(
      getConvertStatus({
        playback: { mode: "convert", heavy: true, reason: "r" },
        convertProgress: undefined,
      }),
    ).toBeNull();
  });
  it("rounds and clamps the progress", () => {
    expect(
      getConvertStatus({
        playback: { mode: "convert", heavy: true, reason: "HEVC" },
        convertProgress: 1.7,
      }),
    ).toEqual({
      label: "Converting · 100% buffered",
      progress: 1.7,
      heavy: true,
      reason: "HEVC",
    });
    expect(
      getConvertStatus({
        playback: { mode: "convert", heavy: false, reason: "" },
        convertProgress: 0.344,
      })?.label,
    ).toBe("Converting · 34% buffered");
  });
});

describe("useConvert.playUrl", () => {
  it("plays directly without probing when auto-convert is off", async () => {
    const { c, get, setSrcAndTime, reportIssue, decodeError } = setup();
    act(() => c().setConvertEnabled(false));
    expect(window.localStorage.getItem(AUTO_CONVERT_KEY)).toBe("0");
    await act(() => c().playUrl(SRC, 5));
    expect(probeMedia).not.toHaveBeenCalled();
    expect(setSrcAndTime).toHaveBeenCalledWith(SRC, 5);
    expect(get().playback).toEqual({ mode: "direct" });
    // A decode error is reported to the room
    act(() => decodeError(4));
    expect(get().playback).toEqual({
      mode: "fail",
      reason: "This browser can't play this video format",
    });
    expect(reportIssue).toHaveBeenCalledWith(
      "This browser can't play this video format",
    );
  });

  it("reports decode errors (code 3) and ignores other errors", async () => {
    const { c, get, reportIssue, decodeError } = setup();
    act(() => c().setConvertEnabled(false));
    await act(() => c().playUrl(SRC, 0));
    act(() => decodeError(2));
    expect(reportIssue).not.toHaveBeenCalled();
    await act(() => c().playUrl(SRC, 0));
    act(() => decodeError(3));
    expect(get().playback).toMatchObject({
      reason: "This browser couldn't decode the video",
    });
  });

  it("plays directly when the probe can't read the file", async () => {
    const { c, get, setSrcAndTime } = setup();
    await act(() => c().playUrl(SRC, 7));
    expect(probeMedia).toHaveBeenCalledWith(SRC);
    expect(get().playback).toEqual({ mode: "direct" });
    expect(setSrcAndTime).toHaveBeenCalledWith(SRC, 7);
  });

  it("plays directly when the probe says it plays, and converts if decoding then fails", async () => {
    probeMedia.mockResolvedValue(probe());
    const { c, get, setSrcAndTime, onConvertStart, decodeError } = setup();
    await act(() => c().playUrl(SRC, 3));
    expect(get().playback).toEqual({ mode: "direct", note: undefined });
    expect(setSrcAndTime).toHaveBeenCalledWith(SRC, 3);
    await act(async () => decodeError(3));
    expect(get().playback).toEqual({
      mode: "convert",
      heavy: false,
      reason: "This browser couldn't decode the video",
    });
    expect(onConvertStart).toHaveBeenCalledWith(
      "This browser couldn't decode the video",
      false,
    );
    expect(transcoders).toHaveLength(1);
  });

  it("doesn't fall back to converting where conversion isn't supported", async () => {
    probeMedia.mockResolvedValue(probe({ transcodeSupported: false }));
    const { c, get, reportIssue, decodeError } = setup();
    await act(() => c().playUrl(SRC, 0));
    act(() => decodeError(3));
    expect(get().playback?.mode).toBe("fail");
    expect(reportIssue).toHaveBeenCalled();
    expect(transcoders).toHaveLength(0);
  });

  it("converts when the probe says so, reporting progress and audio tracks", async () => {
    probeMedia.mockResolvedValue(ac3Only());
    const { c, get, onConvertStart, setSrcAndTime } = setup();
    await act(() => c().playUrl(SRC, 12));
    expect(get().playback).toMatchObject({ mode: "convert", heavy: false });
    expect(onConvertStart).toHaveBeenCalled();
    expect(setSrcAndTime).not.toHaveBeenCalled();
    const t = transcoders[0];
    expect(t.opts).toMatchObject({
      source: SRC,
      video,
      startTime: 12,
      audioTrackId: 3,
    });
    expect(get().convertProgress).toBe(0);
    act(() => t.opts.onProgress(0.4));
    expect(get().convertProgress).toBe(0.4);
    act(() => t.opts.onAudioTracks([{ id: 3 }], 3));
    expect(get().audioTracks).toEqual([{ id: 3 }]);
    expect(get().audioTrackId).toBe(3);

    // Switching tracks goes to the transcoder; failures show an error
    await act(() => c().setAudioTrack(4));
    expect(t.selectAudioTrack).toHaveBeenCalledWith(4);
  });

  it("ignores progress from a replaced transcoder", async () => {
    probeMedia.mockResolvedValue(ac3Only());
    const { c, get } = setup();
    await act(() => c().playUrl(SRC, 0));
    const old = transcoders[0];
    act(() => c().stopConvert());
    expect(old.stop).toHaveBeenCalled();
    expect(get().playback).toBeUndefined();
    act(() => old.opts.onProgress(0.9));
    act(() => old.opts.onAudioTracks([{ id: 1 }], 1));
    expect(get().convertProgress).toBeUndefined();
    expect(get().audioTracks).toBeUndefined();
  });

  it("shows audio track errors", async () => {
    probeMedia.mockResolvedValue(ac3Only());
    const { c, showError } = setup();
    await act(() => c().playUrl(SRC, 0));
    transcoders[0].selectAudioTrack.mockRejectedValueOnce(
      new Error("bad track"),
    );
    await act(() => c().setAudioTrack(9));
    expect(showError).toHaveBeenCalledWith("bad track");
    transcoders[0].selectAudioTrack.mockRejectedValueOnce("x");
    await act(() => c().setAudioTrack(9));
    expect(showError).toHaveBeenLastCalledWith("Unable to change audio track");
  });

  it("plays without conversion when the converter can't start", async () => {
    probeMedia.mockResolvedValue(ac3Only());
    FakeTranscoder.nextStartError = new Error("CORS blocked");
    const { c, get, setSrcAndTime, showError } = setup();
    await act(() => c().playUrl(SRC, 8));
    expect(showError).toHaveBeenCalledWith(
      "CORS blocked. Playing without conversion.",
    );
    expect(get().playback).toEqual({ mode: "direct" });
    expect(setSrcAndTime).toHaveBeenCalledWith(SRC, 8);
  });

  it("uses a generic message when the converter fails with a non-Error", async () => {
    probeMedia.mockResolvedValue(ac3Only());
    FakeTranscoder.nextStartError = "weird";
    const { c, showError } = setup();
    await act(() => c().playUrl(SRC, 0));
    expect(showError).toHaveBeenCalledWith(
      "Unable to convert this video. Playing without conversion.",
    );
  });

  it("carries on directly when conversion fails while playing", async () => {
    probeMedia.mockResolvedValue(ac3Only());
    const { c, get, setSrcAndTime, showError } = setup();
    await act(() => c().playUrl(SRC, 0));
    video.currentTime = 33;
    await act(async () =>
      transcoders[0].opts.onError(new Error("decoder died")),
    );
    expect(showError).toHaveBeenCalledWith(
      "Conversion failed: decoder died. Playing without conversion.",
    );
    expect(get().playback).toEqual({ mode: "direct" });
    expect(setSrcAndTime).toHaveBeenCalledWith(SRC, 33);
  });

  it("fails (and still tries) when the file can't be played or converted", async () => {
    probeMedia.mockResolvedValue(probe({ video: null, audio: [] }));
    const { c, get, reportIssue, setSrcAndTime } = setup();
    await act(() => c().playUrl(SRC, 1));
    expect(get().playback).toEqual({
      mode: "fail",
      reason: "No playable video or audio in this file",
    });
    expect(reportIssue).toHaveBeenCalledWith(
      "No playable video or audio in this file",
    );
    expect(setSrcAndTime).toHaveBeenCalledWith(SRC, 1);
  });

  it("drops a probe result when the media changed meanwhile", async () => {
    let resolve!: (v: unknown) => void;
    probeMedia.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { c, setSrcAndTime } = setup();
    const first = c().playUrl("https://cdn.example.com/old.mkv", 0);
    act(() => c().stopConvert());
    resolve(ac3Only());
    await act(() => first);
    expect(transcoders).toHaveLength(0);
    expect(setSrcAndTime).not.toHaveBeenCalled();
  });

  it("drops a failed probe when the media changed meanwhile", async () => {
    let reject!: (e: unknown) => void;
    probeMedia.mockImplementationOnce(
      () => new Promise((_r, j) => (reject = j)),
    );
    const { c, setSrcAndTime } = setup();
    const first = c().playUrl("https://cdn.example.com/old.mkv", 0);
    act(() => c().stopConvert());
    reject("nope");
    await act(() => first);
    expect(setSrcAndTime).not.toHaveBeenCalled();
  });

  it("ignores decode errors from a previous video", async () => {
    const { c, get, reportIssue, decodeError } = setup();
    act(() => c().setConvertEnabled(false));
    await act(() => c().playUrl(SRC, 0));
    act(() => c().stopConvert());
    act(() => decodeError(4));
    expect(reportIssue).not.toHaveBeenCalled();
    expect(get().playback).toBeUndefined();
  });

  it("keeps working when localStorage throws", () => {
    const { c, get } = setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    act(() => c().setConvertEnabled(true));
    expect(get().convertEnabled).toBe(true);
  });
});
