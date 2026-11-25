import { describe, expect, it } from "vitest";
import {
  chooseAudioTrack,
  decidePlayback,
  type ProbeResult,
  type ProbedAudioTrack,
  type ProbedVideoTrack,
} from "./playback";

const NONE = { native: false, copy: false, decode: false };
const ALL = { native: true, copy: true, decode: true };

const video = (
  codec: string,
  support: Partial<ProbedVideoTrack> = {},
): ProbedVideoTrack => ({ id: 1, codec, height: 1080, ...ALL, ...support });

let nextId = 10;
const audio = (
  codec: string,
  support: Partial<ProbedAudioTrack> = {},
): ProbedAudioTrack => ({
  id: nextId++,
  codec,
  language: "eng",
  name: null,
  channels: 6,
  default: false,
  original: false,
  commentary: false,
  ...ALL,
  ...support,
});

// Typical Chromium support matrix
const aac = (o: Partial<ProbedAudioTrack> = {}) => audio("aac", o);
const ac3 = (o: Partial<ProbedAudioTrack> = {}) =>
  audio("ac3", { native: false, copy: false, decode: true, ...o });
const dts = (o: Partial<ProbedAudioTrack> = {}) =>
  audio("dts", { ...NONE, ...o });
const truehd = (o: Partial<ProbedAudioTrack> = {}) =>
  audio("truehd", { ...NONE, ...o });

const probe = (p: Partial<ProbeResult>): ProbeResult => ({
  container: "mp4",
  containerNative: true,
  video: video("avc"),
  audio: [aac({ default: true })],
  transcodeSupported: true,
  encodeVideo: true,
  encodeAudio: true,
  ...p,
});

describe("chooseAudioTrack", () => {
  const any = () => true;

  it("prefers the original language over a default dub", () => {
    const dub = aac({ language: "ger", default: true });
    const orig = ac3({ language: "eng", original: true });
    expect(chooseAudioTrack([dub, orig], any)).toBe(orig);
  });

  it("prefers AAC, then AC-3/E-AC-3, over DTS and TrueHD in the same language", () => {
    const t = [truehd({ default: true }), dts(), audio("eac3"), aac()];
    expect(chooseAudioTrack(t, any)?.codec).toBe("aac");
    expect(chooseAudioTrack(t.slice(0, 3), any)?.codec).toBe("eac3");
  });

  it("skips commentary tracks", () => {
    const commentary = aac({ commentary: true, name: "Commentary" });
    const main = audio("ac3", { default: true });
    expect(chooseAudioTrack([commentary, main], any)).toBe(main);
  });

  it("never picks an unusable track, even in the original language", () => {
    const orig = dts({ language: "jpn", default: true, original: true });
    const dub = aac({ language: "eng" });
    expect(chooseAudioTrack([orig, dub], (t) => t.native || t.decode)).toBe(
      dub,
    );
    expect(chooseAudioTrack([orig], (t) => t.native || t.decode)).toBe(
      undefined,
    );
  });

  it("uses the default track's language as original when nothing is flagged", () => {
    const first = aac({ language: "fre" });
    const def = ac3({ language: "jpn", default: true });
    expect(chooseAudioTrack([first, def], any)).toBe(def);
  });
});

describe("decidePlayback", () => {
  const on = { autoConvert: true };

  it("plays MP4 H.264 + AAC directly", () => {
    const p = probe({});
    expect(decidePlayback(p, on)).toEqual({
      mode: "direct",
      audioTrackId: p.audio[0].id,
    });
  });

  it("remuxes MKV the browser won't open (cheap convert)", () => {
    const d = decidePlayback(
      probe({ container: "matroska", containerNative: false }),
      on,
    );
    expect(d).toMatchObject({ mode: "convert", heavy: false });
    expect(d.mode === "convert" && d.reason).toMatch(/MATROSKA/);
  });

  it("converts AC-3 audio with H.264 video (light)", () => {
    const track = ac3({ default: true });
    const d = decidePlayback(
      probe({ container: "matroska", containerNative: false, audio: [track] }),
      on,
    );
    expect(d).toEqual({
      mode: "convert",
      audioTrackId: track.id,
      heavy: false,
      reason: "AC-3 audio isn't supported in this browser",
    });
  });

  it("re-encodes HEVC when the browser can decode but not play it (heavy)", () => {
    const d = decidePlayback(
      probe({
        container: "matroska",
        containerNative: false,
        video: video("hevc", { native: false, copy: false, decode: true }),
      }),
      on,
    );
    expect(d).toMatchObject({
      mode: "convert",
      heavy: true,
      reason: "HEVC video isn't supported in this browser",
    });
  });

  it("copies HEVC when MediaSource supports it (hardware decode)", () => {
    const d = decidePlayback(
      probe({
        container: "matroska",
        containerNative: false,
        video: video("hevc", { native: false, copy: true, decode: true }),
      }),
      on,
    );
    expect(d).toMatchObject({ mode: "convert", heavy: false });
  });

  it("fails on HEVC the browser can't decode at all", () => {
    expect(
      decidePlayback(
        probe({ video: video("hevc", NONE), containerNative: false }),
        on,
      ),
    ).toEqual({
      mode: "fail",
      reason: "HEVC video isn't supported in this browser",
    });
  });

  it("fails when the only audio is DTS/TrueHD", () => {
    expect(
      decidePlayback(probe({ audio: [dts({ default: true }), truehd()] }), on),
    ).toEqual({
      mode: "fail",
      reason: "DTS audio isn't supported in this browser",
    });
  });

  it("picks a usable AC-3 track over a DTS default when converting", () => {
    const main = dts({ default: true });
    const alt = ac3();
    const d = decidePlayback(
      probe({
        containerNative: false,
        container: "matroska",
        audio: [main, alt],
      }),
      on,
    );
    expect(d).toMatchObject({ mode: "convert", audioTrackId: alt.id });
  });

  it("converts to switch to the original language when the default is a dub", () => {
    const dub = aac({ language: "ger", default: true });
    const orig = aac({ language: "eng", original: true });
    const d = decidePlayback(probe({ audio: [dub, orig] }), on);
    expect(d).toMatchObject({ mode: "convert", audioTrackId: orig.id });
  });

  it("fails with a clear reason when the browser can't convert", () => {
    const d = decidePlayback(
      probe({
        transcodeSupported: false,
        audio: [ac3({ default: true })],
      }),
      on,
    );
    expect(d).toEqual({
      mode: "fail",
      reason:
        "AC-3 audio isn't supported in this browser, and this browser can't convert video",
    });
  });

  it("tries direct play with a note when auto-convert is off", () => {
    const d = decidePlayback(
      probe({ container: "matroska", containerNative: false }),
      { autoConvert: false },
    );
    expect(d).toMatchObject({ mode: "direct" });
    expect(d.mode === "direct" && d.note).toMatch(/auto-convert is off/);
  });

  it("handles audio-only and empty files", () => {
    expect(decidePlayback(probe({ video: null }), on).mode).toBe("direct");
    expect(decidePlayback(probe({ video: null, audio: [] }), on)).toEqual({
      mode: "fail",
      reason: "No playable video or audio in this file",
    });
  });

  it("fails when video needs re-encoding but no encoder is available", () => {
    expect(
      decidePlayback(
        probe({
          video: video("hevc", { native: false, copy: false, decode: true }),
          encodeVideo: false,
        }),
        on,
      ),
    ).toEqual({
      mode: "fail",
      reason: "HEVC video isn't supported in this browser",
    });
  });
});
