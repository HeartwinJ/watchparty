// Pure helpers for the source picker: link detection, stream grouping/badges, names, metadata and recents.
import type {
  ContentType,
  Episode,
  StreamDTO,
  StreamList,
  TitleRef,
} from "../../../api/addons";
import { classifyMedia, getAttachedDisplayName } from "../logic/media";

// ---- Link detection ----

export const isUrlInput = (text: string) =>
  /^https?:\/\/\S+$/i.test(text.trim());

export type LinkKind = "youtube" | "hls" | "dash" | "direct" | "unknown";

export interface DetectedLink {
  kind: LinkKind;
  /** Badge text, e.g. "YouTube video", "Direct video · MP4" */
  label: string;
  /** A caveat shown under the title, e.g. MKV depends on codecs */
  warning?: string;
  /** File name or host, as a title preview */
  title: string;
}

const VIDEO_EXTENSIONS = [
  "mp4",
  "m4v",
  "webm",
  "mov",
  "ogv",
  "ogg",
  "mkv",
  "avi",
  "ts",
  "m2ts",
];

function fileExtension(url: URL): string | undefined {
  const last = url.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : undefined;
}

function titleFromUrl(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  return last || url.hostname;
}

/** What a pasted link is, for the type badge. Returns null when the text isn't a URL. */
export function detectLink(text: string): DetectedLink | null {
  const input = text.trim();
  if (!isUrlInput(input)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const title = titleFromUrl(url);
  switch (classifyMedia(input)) {
    case "youtube":
      return {
        kind: "youtube",
        label: url.searchParams.has("list")
          ? "YouTube playlist"
          : "YouTube video",
        title: url.searchParams.has("list")
          ? "YouTube playlist"
          : "YouTube video",
      };
    case "hls":
      return { kind: "hls", label: "HLS stream", title };
    case "dash":
      return { kind: "dash", label: "DASH stream", title };
  }
  const ext = fileExtension(url);
  if (ext && VIDEO_EXTENSIONS.includes(ext)) {
    const label = `Direct video · ${ext.toUpperCase()}`;
    if (ext === "mkv") {
      return {
        kind: "direct",
        label,
        title,
        warning:
          "MKV depends on its codecs; it's converted in the browser if needed.",
      };
    }
    if (ext === "avi" || ext === "ts" || ext === "m2ts") {
      return {
        kind: "direct",
        label,
        title,
        warning: `${ext.toUpperCase()} files usually don't play in browsers.`,
      };
    }
    return { kind: "direct", label, title };
  }
  return {
    kind: "unknown",
    label: "Web page or unknown link",
    title: url.hostname,
    warning:
      "This doesn't look like a video file. It will be tried as a direct video link.",
  };
}

// ---- Streams ----

export interface StreamGroups {
  direct: StreamDTO[];
  convert: StreamDTO[];
  unlikely: StreamDTO[];
}

/** Splits the server's ranked list into the three picker groups, keeping the server's order within each */
export function groupStreams(list: Pick<StreamList, "streams">): StreamGroups {
  const groups: StreamGroups = { direct: [], convert: [], unlikely: [] };
  for (const s of list.streams) {
    if (s.tier === "direct") {
      groups.direct.push(s);
    } else if (s.tier === "unlikely") {
      groups.unlikely.push(s);
    } else {
      groups.convert.push(s);
    }
  }
  return groups;
}

export function formatSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const gb = bytes / 1000 ** 3;
  if (gb >= 1) {
    return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / 1000 ** 2))} MB`;
}

/** "2160p" → "4K" (shown in platinum), others unchanged */
export function resolutionLabel(resolution: string | null): string | null {
  if (!resolution) {
    return null;
  }
  return resolution === "2160p" ? "4K" : resolution;
}

export type BadgeTone = "neutral" | "problem" | "ok" | "accent";
export interface StreamBadge {
  label: string;
  tone: BadgeTone;
}

const VIDEO_LABELS: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  vc1: "VC-1",
  mpeg2: "MPEG-2",
  mpeg4: "XviD",
};
const PROBLEM_VIDEO = new Set(["hevc", "vc1", "mpeg2", "mpeg4"]);

const AUDIO_LABELS: Record<string, string> = {
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
// No browser decoder at all (AC3/EAC3/FLAC are converted cheaply, so they're not flagged)
const PROBLEM_AUDIO = new Set(["dts", "dts-hd", "truehd", "pcm"]);
const PROBLEM_CONTAINERS = new Set(["avi", "iso", "m2ts", "ts", "wmv", "vob"]);

/** Codec / audio / container / HDR / REMUX badges for a stream row. Problem codecs get the warning tone. */
export function streamBadges(s: StreamDTO): StreamBadge[] {
  const badges: StreamBadge[] = [];
  if (s.videoCodec) {
    const tenBitH264 = s.videoCodec === "h264" && s.bitDepth === 10;
    badges.push({
      label:
        (VIDEO_LABELS[s.videoCodec] ?? s.videoCodec) +
        (s.bitDepth === 10 ? " 10-bit" : ""),
      tone:
        PROBLEM_VIDEO.has(s.videoCodec) || tenBitH264 ? "problem" : "neutral",
    });
  }
  // Atmos rides on top of TrueHD/EAC3; show it but don't flag it on its own
  for (const a of s.audio) {
    badges.push({
      label: AUDIO_LABELS[a] ?? a.toUpperCase(),
      tone: PROBLEM_AUDIO.has(a) ? "problem" : "neutral",
    });
  }
  if (s.container) {
    const c = s.container.replace(/^other:/, "");
    badges.push({
      label: c.toUpperCase(),
      tone:
        PROBLEM_CONTAINERS.has(c) || s.container.startsWith("other:")
          ? "problem"
          : "neutral",
    });
  }
  for (const h of s.hdr) {
    badges.push({ label: h, tone: "neutral" });
  }
  if (s.remux) {
    badges.push({ label: "REMUX", tone: "problem" });
  }
  return badges;
}

/** What to show instead of the (secret-bearing) URL: the release file name, else the addon's label */
export function streamFileLabel(s: StreamDTO): string {
  return s.filename || s.title || s.name || "Unnamed stream";
}

// ---- Names and metadata ----

export const pad2 = (n: number) => String(n).padStart(2, "0");

export const episodeCode = (season: number | null, episode: number | null) =>
  episode === null
    ? ""
    : season === null
      ? `E${pad2(episode)}`
      : `S${pad2(season)}E${pad2(episode)}`;

/** The base (show/movie) id of an addon id: "tt1:2:3" → "tt1", "kitsu:11:5" → "kitsu:11" */
export function baseContentId(id: string): string {
  if (id.startsWith("kitsu:")) {
    return id.split(":").slice(0, 2).join(":");
  }
  return id.split(":")[0];
}

/** "Title · S02E04" (or just the title for a movie) */
export function streamDisplayName(
  title: string,
  episode?: Pick<Episode, "season" | "episode"> | null,
): string {
  if (!episode) {
    return title;
  }
  return `${title} · ${episodeCode(episode.season, episode.episode)}`;
}

export interface StreamContext {
  title: TitleRef;
  episode?: Episode | null;
  imdbId?: string | null;
}

export function buildVideoMeta(
  ctx: StreamContext,
  stream: Pick<StreamDTO, "bingeGroup">,
): VideoMeta {
  const { title, episode } = ctx;
  const imdbId =
    ctx.imdbId ?? (title.id.startsWith("tt") ? baseContentId(title.id) : null);
  return {
    source: "aiostreams",
    type: title.kind,
    id: episode?.id ?? title.id,
    imdbId,
    season: episode ? episode.season : null,
    episode: episode ? episode.episode : null,
    title: title.name.slice(0, 300),
    episodeTitle: episode?.title ? episode.title.slice(0, 300) : null,
    poster:
      title.poster && /^https?:\/\//i.test(title.poster) ? title.poster : null,
    bingeGroup: stream.bingeGroup ? stream.bingeGroup.slice(0, 300) : null,
  };
}

/** Rebuilds the picker location (title + episode) for a room's videoMeta, e.g. for "Pick another" */
export function contextFromVideoMeta(meta: VideoMeta): StreamContext {
  const kind: ContentType = meta.type;
  const title: TitleRef = {
    id: baseContentId(meta.id),
    type: meta.season !== null || meta.episode !== null ? "series" : "movie",
    kind,
    name: meta.title,
    year: null,
    poster: meta.poster,
  };
  const episode: Episode | null =
    meta.episode !== null
      ? {
          id: meta.id,
          season: meta.season ?? 1,
          episode: meta.episode,
          title: meta.episodeTitle,
          released: null,
          thumbnail: null,
        }
      : null;
  return { title, episode, imdbId: meta.imdbId };
}

/** Interleaves result groups so "All" shows the best movie, series and anime matches up front */
export function interleave<T>(...lists: T[][]): T[] {
  const out: T[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      if (i < l.length) {
        out.push(l[i]);
      }
    }
  }
  return out;
}

export function formatAirDate(released: string | null): string | null {
  if (!released) {
    return null;
  }
  const d = new Date(released);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export const isFuture = (released: string | null, now = Date.now()) => {
  if (!released) {
    return false;
  }
  const t = new Date(released).getTime();
  return Number.isFinite(t) && t > now;
};

// ---- Recent sources (per device, localStorage) ----

export type RecentSource =
  | { kind: "url"; url: string; name: string; img?: string; at: number }
  | { kind: "title"; context: StreamContext; at: number };

const RECENTS_KEY = "wp-recent-sources";
const RECENTS_MAX = 8;

export function loadRecents(): RecentSource[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(raw)
      ? (raw as RecentSource[]).filter(
          (r) => r && (r.kind === "url" || r.kind === "title"),
        )
      : [];
  } catch {
    return [];
  }
}

const recentKey = (r: RecentSource) =>
  r.kind === "url"
    ? `url:${r.url}`
    : `title:${r.context.episode?.id ?? r.context.title.id}`;

/**
 * Remembers a played source. AIOStreams streams are stored as their title/episode (never the playback URL, which
 * expires and carries a credential), so picking one reopens its stream list.
 */
export function saveRecent(entry: RecentSource) {
  if (entry.kind === "url" && getAttachedDisplayName(entry.url)) {
    return;
  }
  const key = recentKey(entry);
  const next = [
    entry,
    ...loadRecents().filter((r) => recentKey(r) !== key),
  ].slice(0, RECENTS_MAX);
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable
  }
}
