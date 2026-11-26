/**
 * Parses and classifies AIOStreams (Stremio) stream results.
 *
 * AIOStreams puts codec info only in free text: an emoji-rich multi-line
 * `description` and `behaviorHints.filename`. Everything here is a pure
 * function so it can be unit tested against synthetic fixtures.
 */

/** A raw Stremio stream object, as returned by `{base}/stream/{type}/{id}.json`. */
export type RawStream = {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  infoHash?: unknown;
  behaviorHints?: unknown;
};

export type Tier = "direct" | "convert-light" | "convert-heavy" | "unlikely";
export const TIERS: readonly Tier[] = [
  "direct",
  "convert-light",
  "convert-heavy",
  "unlikely",
];

export type VideoCodec =
  "h264" | "hevc" | "av1" | "vp9" | "vc1" | "mpeg2" | "mpeg4";
export type AudioCodec =
  | "aac"
  | "opus"
  | "mp3"
  | "flac"
  | "ac3"
  | "eac3"
  | "dts"
  | "dts-hd"
  | "truehd"
  | "atmos"
  | "pcm";

export type ParsedStream = {
  /** Addon label, e.g. "🚀 FHD" */
  name: string;
  /** The "🎬" title line, if any */
  title: string | null;
  filename: string | null;
  /** "2160p" | "1440p" | "1080p" | "720p" | "576p" | "480p" | null */
  resolution: string | null;
  sizeBytes: number | null;
  bitrateMbps: number | null;
  durationSec: number | null;
  /** e.g. "WEB-DL", "WEBRip", "BluRay", "HDTV", "DVDRip", "HDRip", "CAM" */
  source: string | null;
  remux: boolean;
  videoCodec: VideoCodec | null;
  /** 10 when the release is 10-bit, 8 when known 8-bit, null when unknown */
  bitDepth: 8 | 10 | null;
  /** "DV", "HDR10+", "HDR10", "HDR", "HLG" */
  hdr: string[];
  audio: AudioCodec[];
  /** Country codes from flag emoji, plus "multi" / "dubbed" markers */
  languages: string[];
  /** Lowercase file extension, e.g. "mkv", "mp4" */
  container: string | null;
  /** true = ready in the debrid cache, false = needs downloading, null = unknown */
  cached: boolean | null;
  /** Debrid service short code from "Ready (TB)", e.g. "TB", "RD" */
  service: string | null;
  /** The addon that found it, e.g. "Comet", "Torrentio" */
  addon: string | null;
  /** Indexers/trackers from the "📡" line */
  indexer: string | null;
  releaseGroup: string | null;
  bingeGroup: string | null;
};

export type Classification = { tier: Tier; reasons: string[] };

export type StreamDTO = ParsedStream &
  Classification & {
    /** AIOStreams playback URL (307s to the debrid CDN) */
    url: string;
    /** Sort score within the tier (higher is better), for debugging/UI */
    score: number;
  };

export type StreamList = {
  streams: StreamDTO[];
  counts: Record<Tier, number>;
  /** Playable streams before trimming */
  total: number;
};

// Tier thresholds (see classifyStream)
export const MAX_BITRATE_MBPS = 40;
export const MAX_SIZE_BYTES = 40 * 1000 ** 3;
export const DEFAULT_LIMIT = 60;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Emoji used as field markers in AIOStreams' default formatter. The variation
// selector (U+FE0F) is optional because formatters aren't consistent about it.
const VS = "\\uFE0F?";
const MARKERS = [
  "🎬",
  "🎥",
  `📺`,
  `🎞${VS}`,
  `⏱${VS}`,
  "🎧",
  "🔊",
  `🗣${VS}`,
  "📝",
  "📦",
  "📊",
  `🏷${VS}`,
  "📡",
  "⚡",
  "⏳",
  "📌",
  "🔍",
  "🍂",
  "❌",
];
const MARKER_RE = new RegExp(`(${MARKERS.join("|")})`, "u");

/** Splits the description into marker → values (a marker can appear more than once). */
export function descriptionFields(desc: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const line of desc.split(/\r?\n/)) {
    const parts = line.split(MARKER_RE);
    for (let i = 1; i < parts.length; i += 2) {
      const key = parts[i].replace(/️/g, "");
      const value = (parts[i + 1] ?? "").trim();
      const list = fields.get(key) ?? [];
      list.push(value);
      fields.set(key, list);
    }
  }
  return fields;
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

export function parseSize(text: string): number | null {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*([KMGT]i?B|B)\b/i);
  if (!m) {
    return null;
  }
  const unit = UNITS[m[2].toUpperCase()];
  return unit ? Math.round(parseFloat(m[1].replace(",", ".")) * unit) : null;
}

export function parseBitrate(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*([KMG])bps/i);
  if (!m) {
    return null;
  }
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return unit === "K" ? n / 1000 : unit === "G" ? n * 1000 : n;
}

export function parseDuration(text: string): number | null {
  // "2h:22m:37s", "58m:6s", "1h 30m"
  const h = text.match(/(\d+)\s*h/i);
  const m = text.match(/(\d+)\s*m(?!b)/i);
  const s = text.match(/(\d+)\s*s/i);
  if (!h && !m && !s) {
    return null;
  }
  return (
    (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0) || null
  );
}

function parseResolution(name: string, text: string): string | null {
  // AIOStreams' own label is the most reliable signal
  if (/4K|UHD/.test(name)) {
    return "2160p";
  }
  if (/\bQHD\b/.test(name)) {
    return "1440p";
  }
  if (/\bFHD\b/.test(name)) {
    return "1080p";
  }
  if (/\bHD\b/.test(name)) {
    return "720p";
  }
  if (/\bSD\b/.test(name)) {
    return "480p";
  }
  // "1080p", "2160P", "BDR1080p" (no word boundary before the digits)
  const m = text.match(/(?:\b|[a-z])(2160|1440|1080|720|576|480|360)[pi]\b/i);
  if (m) {
    return `${m[1]}p`;
  }
  if (/\b(?:4k|uhd)\b/i.test(text)) {
    return "2160p";
  }
  return null;
}

const SOURCES: [RegExp, string][] = [
  [/\b(?:HD-?)?CAM(?:Rip)?\b|\bTELESYNC\b|\bTSRip\b|\bHD-?TS\b/i, "CAM"],
  [/\bWEB[-. ]?DL\b|\bWEB\b(?![-. ]?Rip)/i, "WEB-DL"],
  [/\bWEB[-. ]?Rip\b/i, "WEBRip"],
  [
    /\bBlu[-. ]?Ray\b|\bBD[-. ]?Rip\b|\bBRRip\b|\bBDR\d*\b|\bUHD[-. ]?BD\b|\bBD[-. ]?Remux\b/i,
    "BluRay",
  ],
  [/\bHDTV\b/i, "HDTV"],
  [/\bDVD[-. ]?Rip\b|\bDVD\b/i, "DVDRip"],
  [/\bHD[-. ]?Rip\b/i, "HDRip"],
];

function parseSource(primary: string, fallback: string): string | null {
  for (const text of [primary, fallback]) {
    for (const [re, label] of SOURCES) {
      if (re.test(text)) {
        return label;
      }
    }
  }
  return null;
}

const VIDEO_CODECS: [RegExp, VideoCodec][] = [
  [/\b(?:HEVC|[xh][ .]?265|H\.?265)\b/i, "hevc"],
  [/\bAV1\b/i, "av1"],
  [/\bVP0?9\b/i, "vp9"],
  [/\b(?:AVC|[xh][ .]?264|H\.?264)\b/i, "h264"],
  [/\bVC-?1\b/i, "vc1"],
  [/\bMPEG-?2\b/i, "mpeg2"],
  [/\b(?:XviD|DivX|MPEG-?4 ?Part ?2)\b/i, "mpeg4"],
];

function parseVideoCodec(primary: string, fallback: string): VideoCodec | null {
  for (const text of [primary, fallback]) {
    for (const [re, codec] of VIDEO_CODECS) {
      if (re.test(text)) {
        return codec;
      }
    }
  }
  return null;
}

// Order matters: match the longer/more specific names first and blank them out
// so e.g. "DTS-HD MA" isn't also counted as plain "DTS", or "DD+" as "DD".
const AUDIO_CODECS: [RegExp, AudioCodec][] = [
  [/\bAtmos\b/gi, "atmos"],
  [/\bTrue-?HD\b/gi, "truehd"],
  [/\bDTS[-. ]?(?:HD|X)(?:[-. ]?(?:MA|HRA))?\b|\bDTS[-. ]?MA\b/gi, "dts-hd"],
  [/\bDTS\b/gi, "dts"],
  [/\bE-?AC-?3\b|\bDD\+|\bDDP(?:\d|\b)|\bDolby Digital Plus\b/gi, "eac3"],
  [/\bAC-?3\b|\bDD(?:\d|\b)|\bDolby Digital\b/gi, "ac3"],
  [/\bAAC(?:\d|\b)|\bHE-?AAC\b/gi, "aac"],
  [/\bOpus\b/gi, "opus"],
  [/\bFLAC\b/gi, "flac"],
  [/\bMP3\b/gi, "mp3"],
  [/\b(?:L?PCM)\b/gi, "pcm"],
];

export function parseAudio(text: string): AudioCodec[] {
  const found: AudioCodec[] = [];
  let rest = text;
  for (const [re, codec] of AUDIO_CODECS) {
    if (re.test(rest)) {
      found.push(codec);
      rest = rest.replace(re, " ");
    }
    re.lastIndex = 0;
  }
  return found;
}

function parseHdr(text: string): string[] {
  const hdr: string[] = [];
  if (/\b(?:DV|DoVi|Dolby[ .]?Vision)\b/i.test(text)) {
    hdr.push("DV");
  }
  if (/\bHDR10(?:\+|Plus)/i.test(text)) {
    hdr.push("HDR10+");
  } else if (/\bHDR10\b/i.test(text)) {
    hdr.push("HDR10");
  } else if (/\bHDR\b/i.test(text)) {
    hdr.push("HDR");
  }
  if (/\bHLG\b/.test(text)) {
    hdr.push("HLG");
  }
  return hdr;
}

function parseLanguages(text: string): string[] {
  const langs: string[] = [];
  // Flag emoji are pairs of regional indicator symbols (U+1F1E6..U+1F1FF)
  for (const m of text.matchAll(
    /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu,
  )) {
    const code = String.fromCharCode(
      m[1].codePointAt(0)! - 0x1f1e6 + 65,
      m[2].codePointAt(0)! - 0x1f1e6 + 65,
    );
    if (!langs.includes(code)) {
      langs.push(code);
    }
  }
  if (/🌎|🌍|🌏|\bMulti\b/i.test(text)) {
    langs.push("multi");
  }
  if (/\bDubbed\b/i.test(text)) {
    langs.push("dubbed");
  }
  return langs;
}

const KNOWN_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "webm",
  "avi",
  "mov",
  "ts",
  "m2ts",
  "mts",
  "iso",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "vob",
]);

function parseContainer(filename: string): string | null {
  const m = filename.match(/\.([a-z0-9]{2,5})$/i);
  if (!m) {
    return null;
  }
  const ext = m[1].toLowerCase();
  return KNOWN_EXTENSIONS.has(ext) ? ext : `other:${ext}`;
}

/** Parses one raw stream. Returns null for streams without a playable http(s) URL. */
export function parseStream(
  raw: RawStream,
): (ParsedStream & { url: string }) | null {
  const url = str(raw.url);
  if (!/^https?:\/\//i.test(url)) {
    // Torrent-only results (infoHash, no url) are hidden: WebTorrent is gone
    return null;
  }
  const hints =
    raw.behaviorHints && typeof raw.behaviorHints === "object"
      ? (raw.behaviorHints as Record<string, unknown>)
      : {};
  const name = str(raw.name).trim();
  const desc = str(raw.description) || str(raw.title);
  const filename = str(hints.filename) || null;
  const f = descriptionFields(desc);
  const field = (k: string) => (f.get(k) ?? []).join(" | ");

  // Filename text for regex fallbacks. The description's structured fields win.
  const fileText = (filename ?? "").replace(/[._]/g, " ");

  // The 🎞️ marker is also used for episode numbers ("E01") in titles
  const codecField = (f.get("🎞") ?? [])
    .filter((v) => !/^E\d+/.test(v))
    .join(" ");
  const sourceField = field("🎥");
  const visualField = field("📺");

  const sizeFromHints =
    typeof hints.videoSize === "number" && hints.videoSize > 0
      ? hints.videoSize
      : null;
  const sizeBytes = sizeFromHints ?? parseSize(field("📦"));
  const durationSec = parseDuration(field("⏱"));
  let bitrateMbps = parseBitrate(field("📊"));
  if (bitrateMbps == null && sizeBytes && durationSec) {
    bitrateMbps = Math.round(((sizeBytes * 8) / durationSec / 1e6) * 10) / 10;
  }

  const audioField = field("🎧");
  let audio = parseAudio(audioField);
  if (!audio.length) {
    audio = parseAudio(fileText);
  }

  const bitDepthText = `${visualField} ${fileText}`;
  const bitDepth = /\b10[- ]?bit\b|\bHi10P?\b/i.test(bitDepthText)
    ? 10
    : /\b8[- ]?bit\b/i.test(bitDepthText)
      ? 8
      : null;

  const readyField = field("⚡");
  let cached: boolean | null = null;
  if (f.has("⚡") || /\[[A-Z]{2,3}\+\]/.test(name)) {
    cached = true;
  } else if (f.has("⏳") || /\[[A-Z]{2,3} download\]/i.test(name)) {
    cached = false;
  }
  const service =
    (readyField || field("⏳")).match(/\(([A-Z]{2,3})\)/)?.[1] ??
    name.match(/\[([A-Z]{2,3})[+ ]/)?.[1] ??
    null;

  const titleLine = (f.get("🎬") ?? [])[0];

  return {
    url,
    name,
    title: titleLine ? titleLine.trim() || null : null,
    filename,
    resolution: parseResolution(name, fileText),
    sizeBytes,
    bitrateMbps,
    durationSec,
    source: parseSource(sourceField, fileText),
    remux: /\bREMUX\b/i.test(`${sourceField} ${fileText}`),
    videoCodec: parseVideoCodec(codecField, fileText),
    bitDepth,
    hdr: parseHdr(`${visualField} ${fileText}`),
    audio,
    languages: parseLanguages(`${field("🗣")} ${fileText}`),
    container: filename ? parseContainer(filename) : null,
    cached,
    service,
    addon: field("🔍").split(/\s+/)[0] || null,
    indexer: field("📡") || null,
    releaseGroup: field("🏷") || null,
    bingeGroup: str(hints.bingeGroup) || null,
  };
}

const NATIVE_VIDEO: VideoCodec[] = ["h264", "av1", "vp9"];
const NATIVE_AUDIO: AudioCodec[] = ["aac", "opus", "mp3"];
/** Audio the in-browser converter can decode (WebCodecs + @mediabunny/ac3) */
const CONVERTIBLE_AUDIO: AudioCodec[] = ["ac3", "eac3", "flac", "atmos"];
const NATIVE_CONTAINERS = ["mp4", "m4v", "webm", "mov"];
/** Containers the converter (mediabunny) can demux */
const CONVERTIBLE_CONTAINERS = ["mkv", "ts", "mts"];

const VIDEO_LABEL: Record<VideoCodec, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  vc1: "VC-1",
  mpeg2: "MPEG-2",
  mpeg4: "MPEG-4 (XviD/DivX)",
};

const AUDIO_LABEL: Record<AudioCodec, string> = {
  aac: "AAC",
  opus: "Opus",
  mp3: "MP3",
  flac: "FLAC",
  ac3: "AC3",
  eac3: "EAC3",
  dts: "DTS",
  "dts-hd": "DTS-HD",
  truehd: "TrueHD",
  atmos: "Atmos",
  pcm: "PCM",
};

/**
 * Buckets a stream by how likely it is to play in a browser.
 * The client still probes the real tracks before playing; this is only a guess
 * for sorting and badges.
 */
export function classifyStream(s: ParsedStream): Classification {
  const unlikely: string[] = [];
  const heavy: string[] = [];
  const light: string[] = [];
  const notes: string[] = [];

  // Container
  const c = s.container;
  if (
    c &&
    !NATIVE_CONTAINERS.includes(c) &&
    !CONVERTIBLE_CONTAINERS.includes(c)
  ) {
    unlikely.push(`Unsupported container (${c.replace(/^other:/, "")})`);
  } else if (c === "mkv") {
    notes.push("MKV: plays in Chromium browsers, may need a remux elsewhere");
  } else if (c === "ts" || c === "mts") {
    light.push("MPEG-TS needs a remux");
  } else if (c == null) {
    notes.push("Container unknown");
  }

  // Size and bitrate
  if (s.remux) {
    unlikely.push("REMUX (very high bitrate)");
  }
  if (s.bitrateMbps != null && s.bitrateMbps > MAX_BITRATE_MBPS) {
    unlikely.push(`Bitrate too high to stream (${s.bitrateMbps} Mbps)`);
  }
  if (s.sizeBytes != null && s.sizeBytes > MAX_SIZE_BYTES) {
    unlikely.push(`Very large file (${(s.sizeBytes / 1e9).toFixed(1)} GB)`);
  }

  // Video
  const v = s.videoCodec;
  if (v === "vc1" || v === "mpeg2" || v === "mpeg4") {
    unlikely.push(`No browser decoder for ${VIDEO_LABEL[v]} video`);
  } else if (v === "hevc") {
    heavy.push(
      "HEVC video must be re-encoded (or needs hardware HEVC support)",
    );
  } else if (v === "h264" && s.bitDepth === 10) {
    heavy.push("10-bit H.264 isn't decodable by browsers, must be re-encoded");
  } else if (v == null) {
    light.push("Video codec unknown, will be probed");
  }
  if (s.hdr.includes("DV") && s.hdr.length === 1) {
    notes.push("Dolby Vision only: colors may look wrong");
  } else if (s.hdr.length) {
    notes.push(`${s.hdr.join("/")}: colors may look washed out on SDR screens`);
  }

  // Audio
  const a = s.audio;
  if (!a.length) {
    light.push("Audio codec unknown, will be probed");
  } else if (a.some((x) => NATIVE_AUDIO.includes(x))) {
    if (a.some((x) => !NATIVE_AUDIO.includes(x))) {
      notes.push(
        `Multiple audio tracks (${a.map((x) => AUDIO_LABEL[x]).join(", ")}): the default track may need conversion`,
      );
    }
  } else if (a.some((x) => CONVERTIBLE_AUDIO.includes(x))) {
    const conv = a.filter((x) => CONVERTIBLE_AUDIO.includes(x));
    light.push(
      `${conv.map((x) => AUDIO_LABEL[x]).join("/")} audio must be converted`,
    );
  } else {
    unlikely.push(
      `No browser-decodable audio (${a.map((x) => AUDIO_LABEL[x]).join(", ")})`,
    );
  }

  if (s.source === "CAM") {
    notes.push("CAM/telesync release (poor quality)");
  }

  let tier: Tier;
  let reasons: string[];
  if (unlikely.length) {
    tier = "unlikely";
    reasons = [...unlikely, ...heavy, ...light];
  } else if (heavy.length) {
    tier = "convert-heavy";
    reasons = [...heavy, ...light];
  } else if (light.length) {
    tier = "convert-light";
    reasons = light;
  } else {
    tier = "direct";
    reasons = [
      `Browser-friendly: ${VIDEO_LABEL[v!]} + ${a
        .filter((x) => NATIVE_AUDIO.includes(x))
        .map((x) => AUDIO_LABEL[x])
        .join("/")}`,
    ];
  }
  return { tier, reasons: [...reasons, ...notes] };
}

const RESOLUTION_SCORE: Record<string, number> = {
  "1080p": 100,
  "1440p": 80,
  "720p": 70,
  "2160p": 60, // 4K is usually too heavy to stream/convert for a watch party
  "576p": 40,
  "480p": 35,
  "360p": 10,
};

/** Higher is better. Used to order streams within a tier. */
export function scoreStream(
  s: ParsedStream,
  opts: { bingeGroup?: string } = {},
): number {
  let score = s.resolution ? (RESOLUTION_SCORE[s.resolution] ?? 20) : 20;
  if (s.cached === true) {
    score += 50;
  } else if (s.cached === false) {
    score -= 50;
  }
  // Size/bitrate sanity: enough quality without choking the connection
  const br = s.bitrateMbps;
  if (br != null) {
    if (br >= 2 && br <= 20) {
      score += 20;
    } else if (br > 30) {
      score -= 20;
    } else if (br < 1) {
      score -= 15;
    }
  } else if (s.sizeBytes != null && s.sizeBytes > 25e9) {
    score -= 20;
  }
  if (s.source === "WEB-DL") {
    score += 10;
  } else if (s.source === "BluRay" || s.source === "WEBRip") {
    score += 5;
  } else if (s.source === "CAM") {
    score -= 100;
  }
  if (s.videoCodec == null && !s.audio.length) {
    score -= 10; // "Unknown" results with no metadata at all
  }
  if (opts.bingeGroup && s.bingeGroup === opts.bingeGroup) {
    score += 200; // keep the same release/quality across episodes
  }
  return score;
}

/**
 * Parses, classifies, sorts and trims a raw `streams` array for the client.
 * Order: tier, then score, then AIOStreams' original order.
 */
export function rankStreams(
  raw: unknown[],
  opts: { bingeGroup?: string; limit?: number } = {},
): StreamList {
  const counts: Record<Tier, number> = {
    direct: 0,
    "convert-light": 0,
    "convert-heavy": 0,
    unlikely: 0,
  };
  const items: (StreamDTO & { index: number })[] = [];
  raw.forEach((r, index) => {
    if (!r || typeof r !== "object") {
      return;
    }
    const parsed = parseStream(r as RawStream);
    if (!parsed) {
      return;
    }
    const cls = classifyStream(parsed);
    counts[cls.tier]++;
    items.push({
      ...parsed,
      ...cls,
      score: scoreStream(parsed, opts),
      index,
    });
  });
  items.sort(
    (a, b) =>
      TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
      b.score - a.score ||
      a.index - b.index,
  );
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return {
    streams: items.slice(0, limit).map(({ index: _index, ...s }) => s),
    counts,
    total: items.length,
  };
}
