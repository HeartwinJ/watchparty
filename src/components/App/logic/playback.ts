/**
 * Per-viewer playback decision for direct links (PLAN 6c "auto-convert"). Each browser probes the real tracks of the
 * room's video (clientTranscode.ts probeMedia) and decides for itself: play it directly, convert it in the browser
 * (copy what plays, re-encode what doesn't), or give up and tell the room. Pure functions, unit tested.
 */

/** Support for one track, as measured in this browser */
export interface TrackSupport {
  /** Plays natively from the source container (<video src>) */
  native: boolean;
  /** Can be copied as-is into fragmented MP4 for MediaSource (a cheap remux) */
  copy: boolean;
  /** Can be decoded with WebCodecs, so it can be re-encoded */
  decode: boolean;
}

export interface ProbedVideoTrack extends TrackSupport {
  id: number;
  /** mediabunny codec name, e.g. "avc", "hevc", "vp9", "av1" */
  codec: string | null;
  height: number;
}

export interface ProbedAudioTrack extends TrackSupport {
  id: number;
  /** mediabunny codec name, e.g. "aac", "opus", "ac3", "eac3", "dts", "flac" */
  codec: string | null;
  /** ISO 639-2 code from the file, "und" when unknown */
  language: string;
  name: string | null;
  channels: number;
  /** Disposition flags from the file */
  default: boolean;
  original: boolean;
  commentary: boolean;
}

export interface ProbeResult {
  /** e.g. "mp4", "matroska", "webm" */
  container: string;
  /** The browser claims it can play the whole file (container + codecs) directly */
  containerNative: boolean;
  video: ProbedVideoTrack | null;
  audio: ProbedAudioTrack[];
  /** WebCodecs + MediaSource are available */
  transcodeSupported: boolean;
  /** Some browser-playable video codec can be encoded here (at the needed size) */
  encodeVideo: boolean;
  /** Some browser-playable audio codec can be encoded here */
  encodeAudio: boolean;
}

export type PlaybackDecision =
  | {
      mode: "direct";
      audioTrackId: number | undefined;
      /** Why we're playing directly although it may not work (e.g. auto-convert is off) */
      note?: string;
    }
  | {
      mode: "convert";
      audioTrackId: number | undefined;
      /** The video is re-encoded (not just remuxed / audio re-encoded) */
      heavy: boolean;
      reason: string;
    }
  | { mode: "fail"; reason: string };

const VIDEO_NAMES: Record<string, string> = {
  avc: "H.264",
  hevc: "HEVC",
  vp8: "VP8",
  vp9: "VP9",
  av1: "AV1",
};
const AUDIO_NAMES: Record<string, string> = {
  aac: "AAC",
  opus: "Opus",
  mp3: "MP3",
  vorbis: "Vorbis",
  flac: "FLAC",
  ac3: "AC-3",
  eac3: "E-AC-3",
  dts: "DTS",
};

export const videoCodecName = (codec: string | null) =>
  codec ? (VIDEO_NAMES[codec] ?? codec.toUpperCase()) : "this video codec";
export const audioCodecName = (codec: string | null) =>
  codec
    ? (AUDIO_NAMES[codec] ??
      (codec.startsWith("pcm") ? "PCM" : codec.toUpperCase()))
    : "this audio codec";

/** Lower is better: common web codecs, then Dolby (decodable via the AC-3 WASM decoder), then the rest */
export function audioCodecRank(codec: string | null): number {
  switch (codec) {
    case "aac":
    case "opus":
      return 0;
    case "mp3":
    case "ac3":
    case "eac3":
      return 1;
    case "flac":
    case "vorbis":
      return 2;
    case "dts":
    case "truehd":
      return 4;
    default:
      // PCM and anything unknown
      return 3;
  }
}

/** The language a viewer would expect by default: the track flagged original, else default, else the first one */
export function originalLanguage(tracks: ProbedAudioTrack[]): string {
  const pick =
    tracks.find((t) => t.original && !t.commentary) ??
    tracks.find((t) => t.default && !t.commentary) ??
    tracks.find((t) => !t.commentary) ??
    tracks[0];
  return pick?.language ?? "und";
}

/**
 * Picks the audio track to play: one this browser can use, in the original language, not commentary, preferring
 * AAC/Opus, then AC-3/E-AC-3, over DTS/TrueHD; ties go to the file's default track, then file order.
 * Returns undefined when no track is usable.
 */
export function chooseAudioTrack(
  tracks: ProbedAudioTrack[],
  usable: (track: ProbedAudioTrack) => boolean,
): ProbedAudioTrack | undefined {
  const original = originalLanguage(tracks);
  const key = (t: ProbedAudioTrack, index: number) => [
    t.language === original ? 0 : 1,
    t.commentary ? 1 : 0,
    audioCodecRank(t.codec),
    t.default ? 0 : 1,
    index,
  ];
  return tracks
    .map((t, index) => ({ t, k: key(t, index) }))
    .filter(({ t }) => usable(t))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) {
        if (a.k[i] !== b.k[i]) {
          return a.k[i] - b.k[i];
        }
      }
      return 0;
    })[0]?.t;
}

/** The track a browser plays when given the file directly (the default one, else the first) */
const nativeDefaultTrack = (tracks: ProbedAudioTrack[]) =>
  tracks.find((t) => t.default) ?? tracks[0];

export function decidePlayback(
  probe: ProbeResult,
  opts: { autoConvert: boolean },
): PlaybackDecision {
  const { video, audio } = probe;
  if (!video && audio.length === 0) {
    return { mode: "fail", reason: "No playable video or audio in this file" };
  }

  const canConvert = probe.transcodeSupported;
  const videoConvertible =
    !video || video.copy || (video.decode && probe.encodeVideo);
  const audioConvertible = (t: ProbedAudioTrack) =>
    t.copy || (t.decode && probe.encodeAudio);

  // Best track overall (direct or via conversion), and the one a plain <video> would play
  const best = chooseAudioTrack(
    audio,
    (t) => t.native || (canConvert && audioConvertible(t)),
  );
  const nativeDefault = nativeDefaultTrack(audio);

  const directOk =
    probe.containerNative &&
    (!video || video.native) &&
    (audio.length === 0 ||
      (nativeDefault.native &&
        // Converting just to switch language is only worth it when the default track isn't the original language
        (!best || best.language === nativeDefault.language)));
  if (directOk) {
    return { mode: "direct", audioTrackId: nativeDefault?.id };
  }

  // Why direct play doesn't work, for the user
  const videoProblem =
    video && !video.native
      ? `${videoCodecName(video.codec)} video isn't supported in this browser`
      : undefined;
  const audioProblem =
    audio.length > 0 && !audio.some((t) => t.native)
      ? `${audioCodecName((best ?? nativeDefault).codec)} audio isn't supported in this browser`
      : undefined;
  const why =
    videoProblem ??
    audioProblem ??
    (probe.containerNative
      ? "The default audio track isn't the original language"
      : `This browser can't open ${probe.container.toUpperCase()} files directly`);

  const convertAudio = chooseAudioTrack(audio, audioConvertible);
  const convertOk =
    canConvert && videoConvertible && (audio.length === 0 || !!convertAudio);

  if (!opts.autoConvert) {
    // Respect the setting and try the file as-is (canPlayType is conservative: Chromium plays many MKVs anyway)
    return {
      mode: "direct",
      audioTrackId: nativeDefault?.id,
      note: `${why}; auto-convert is off`,
    };
  }

  if (convertOk) {
    return {
      mode: "convert",
      audioTrackId: convertAudio?.id,
      heavy: Boolean(video && !video.copy),
      reason: why,
    };
  }

  // Can't convert either: explain the most specific blocker
  if (!canConvert) {
    return {
      mode: "fail",
      reason: `${why}, and this browser can't convert video`,
    };
  }
  if (!videoConvertible && video) {
    return {
      mode: "fail",
      reason: `${videoCodecName(video.codec)} video isn't supported in this browser`,
    };
  }
  const audioName = audioCodecName(
    (audio.find((t) => t.language === originalLanguage(audio)) ?? audio[0])
      ?.codec ?? null,
  );
  return {
    mode: "fail",
    reason: `${audioName} audio isn't supported in this browser`,
  };
}
