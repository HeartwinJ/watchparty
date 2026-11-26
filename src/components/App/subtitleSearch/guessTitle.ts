/**
 * Guessing what's playing for the subtitle search: a search query (title), year and season/episode from a release
 * file name ("The.Office.US.S02E04.1080p.WEB-DL.x264-GRP.mkv"), a `#wp-name=` display name or the room's
 * AIOStreams metadata. Pure, so it's easy to test.
 */
import { getAttachedDisplayName } from "../logic/media";

export type TitleGuess = {
  /** What to search for ("" when nothing useful was found) */
  query: string;
  year: number | null;
  season: number | null;
  episode: number | null;
};

/** Where the search starts: straight at a title/episode's subtitles (AIOStreams picks), or a search query */
export type SubtitleSearchStart =
  | {
      kind: "subtitles";
      type: "movie" | "series" | "anime";
      /** Addon id: "tt0111161", "tt0903747:2:4" or "kitsu:11:5" */
      id: string;
      label: string;
      guess: TitleGuess;
    }
  | { kind: "search"; guess: TitleGuess };

const EMPTY: TitleGuess = {
  query: "",
  year: null,
  season: null,
  episode: null,
};

const VIDEO_EXT =
  /\.(mkv|mp4|m4v|webm|avi|mov|wmv|flv|ts|m2ts|mpg|mpeg|ogv|3gp|m3u8|mpd|srt|vtt)$/i;

const tagPattern = (tags: string[], flags = "i") =>
  new RegExp(`\\b(${tags.join("|")})\\b`, flags);

// Release tags that never appear in titles: everything from the first one on is dropped
const STRONG_TAGS = [
  "\\d{3,4}p",
  "4k",
  "uhd",
  "[xh]\\.?26[45]",
  "hevc",
  "avc",
  "av1",
  "xvid",
  "divx",
  "web[- ]?dl",
  "web[- ]?rip",
  "blu[- ]?ray",
  "bdrip",
  "brrip",
  "bdremux",
  "remux",
  "hdtv",
  "hdrip",
  "dvdrip",
  "dvdscr",
  "hdcam",
  "hdr10\\+?",
  "hdr",
  "dovi",
  "10bit",
  "8bit",
  "aac[0-9.]*",
  "e?ac3",
  "ddp?[0-9][0-9.]*",
  "dts(?:[- ]?hd)?",
  "truehd",
  "atmos",
];
// Tags that can also be words in a title ("Uncut Gems"): only stripped from the end of the title when release tags
// follow them
const WEAK_TAGS = [
  "web",
  "proper",
  "repack",
  "rerip",
  "internal",
  "limited",
  "extended",
  "unrated",
  "uncut",
  "directors cut",
  "imax",
  "remastered",
  "multi",
  "dual[- ]?audio",
  "dubbed",
  "subbed",
  "complete",
  "amzn",
  "nf",
  "dsnp",
  "hmax",
  "atvp",
];
const STRONG_TAG = tagPattern(STRONG_TAGS);
const TRAILING_WEAK_TAG = new RegExp(`\\s+(${WEAK_TAGS.join("|")})$`, "i");

const SXXEYY = /\bS(\d{1,2})[ ._-]?E(\d{1,4})\b/i;
const NXNN = /\b(\d{1,2})x(\d{2,3})\b/i;
const SEASON_EPISODE_WORDS =
  /\bseason[ ._-]?(\d{1,2})[ ._-]+episode[ ._-]?(\d{1,4})\b/i;
// Anime style: "Frieren - 05", "Frieren - 05v2"
const DASH_EPISODE = /\s-\s(\d{1,4})(?:v\d)?(?=\s|$)/;
const YEAR = /\b(19\d{2}|20\d{2})\b/g;

/** The last path segment of a URL (decoded, without query/fragment), or the input itself */
export function fileNameFromUrl(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  const last = path.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Guesses a title, year and season/episode from a file or display name.
 * "Breaking.Bad.S02E04.720p.HDTV.x264-CTU.mkv" → {query: "Breaking Bad", season: 2, episode: 4}.
 */
export function guessFromName(name: string): TitleGuess {
  let s = name.trim().replace(VIDEO_EXT, "");
  if (!s) {
    return { ...EMPTY };
  }
  // [Group], {tags}, and brackets/parens with no year in them
  s = s
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\(([^)]*)\)/g, (_m, inner: string) =>
      /^\s*(19|20)\d{2}\s*$/.test(inner) ? ` ${inner.trim()} ` : " ",
    );
  // Separators: dots/underscores between words, "·" from display names
  s = s
    .replace(/[._]+/g, " ")
    .replace(/[·|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let season: number | null = null;
  let episode: number | null = null;
  // Index where the title ends
  let cut = s.length;
  const take = (m: RegExpExecArray | RegExpMatchArray | null) => {
    if (m && m.index !== undefined && m.index < cut) {
      cut = m.index;
    }
  };

  const ep =
    SXXEYY.exec(s) ?? SEASON_EPISODE_WORDS.exec(s) ?? NXNN.exec(s) ?? null;
  if (ep) {
    season = Number(ep[1]);
    episode = Number(ep[2]);
    take(ep);
  } else {
    // "S02" alone (a season pack) still ends the title
    const seasonOnly = /\bS(\d{1,2})\b/i.exec(s);
    if (seasonOnly) {
      season = Number(seasonOnly[1]);
      take(seasonOnly);
    }
  }
  take(STRONG_TAG.exec(s));

  // A year counts when there's a title before it ("2001 A Space Odyssey 1968" → 1968; "1917 2019" → 2019)
  let year: number | null = null;
  for (const m of s.matchAll(YEAR)) {
    if (m.index === undefined || m.index === 0 || m.index > cut) {
      continue;
    }
    year = Number(m[1]);
    cut = m.index;
    break;
  }

  const anchored = cut < s.length;
  let title = s.slice(0, cut).trim();
  // "Movie EXTENDED 1080p": weak tags right before the release tags go too (a plain name like "Charlotte's Web"
  // has no release tags, so it's left alone)
  while (anchored && TRAILING_WEAK_TAG.test(title)) {
    title = title.replace(TRAILING_WEAK_TAG, "").trim();
  }
  if (episode === null) {
    const dash = DASH_EPISODE.exec(title);
    if (dash && dash.index > 0) {
      episode = Number(dash[1]);
      title = title.slice(0, dash.index);
    }
  }
  title = title
    .replace(/\s+-\s*$/, "")
    .replace(/[\s\-–—:,]+$/, "")
    .replace(/^[\s\-–—:,]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Nothing before the tags (e.g. "1080p.mkv"): fall back to the cleaned name
  if (!title && !ep) {
    title = s.replace(STRONG_TAG, "").trim();
  }
  return { query: title.slice(0, 100), year, season, episode };
}

/**
 * Where the subtitle search starts for the room's current video: AIOStreams metadata goes straight to that
 * title/episode's subtitles; otherwise the `#wp-name=` display name, else the file name in the URL.
 */
export function guessSubtitleSearch(
  mediaUrl: string | undefined,
  videoMeta: VideoMeta | null | undefined,
): SubtitleSearchStart {
  if (videoMeta?.id && videoMeta.type) {
    const season = videoMeta.season ?? null;
    const episode = videoMeta.episode ?? null;
    return {
      kind: "subtitles",
      type: videoMeta.type,
      id: videoMeta.id,
      label: subtitleTargetLabel(videoMeta.title, season, episode),
      guess: {
        query: videoMeta.title.slice(0, 100),
        year: null,
        season,
        episode,
      },
    };
  }
  const url = mediaUrl ?? "";
  const attached = url ? getAttachedDisplayName(url) : undefined;
  if (attached) {
    return { kind: "search", guess: guessFromName(attached) };
  }
  if (/^https?:\/\//i.test(url)) {
    return { kind: "search", guess: guessFromName(fileNameFromUrl(url)) };
  }
  return { kind: "search", guess: { ...EMPTY } };
}

export const episodeCode = (season: number, episode: number) =>
  `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

/** "Breaking Bad · S02E04", or the title alone */
export function subtitleTargetLabel(
  title: string,
  season: number | null,
  episode: number | null,
): string {
  return season !== null && episode !== null
    ? `${title} · ${episodeCode(season, episode)}`
    : title;
}

/**
 * The episode to pre-select in a series: the guessed season/episode, else (anime, absolute numbering) the first
 * episode with that number. Null when there's no guess or no match.
 */
export function findGuessedEpisode<
  E extends { season: number; episode: number },
>(
  seasons: { season: number; episodes: E[] }[],
  guess: Pick<TitleGuess, "season" | "episode">,
): E | null {
  if (guess.episode === null) {
    return null;
  }
  const all = seasons.flatMap((s) => s.episodes);
  if (guess.season !== null) {
    const exact = all.find(
      (e) => e.season === guess.season && e.episode === guess.episode,
    );
    if (exact) {
      return exact;
    }
  }
  return all.find((e) => e.season > 0 && e.episode === guess.episode) ?? null;
}

/** Groups subtitles by language, keeping the server's order (SUBTITLE_LANGS first) */
export function groupSubtitlesByLanguage<
  S extends { lang: string; label: string },
>(subs: S[]): { lang: string; language: string; items: S[] }[] {
  const groups: { lang: string; language: string; items: S[] }[] = [];
  const byLang = new Map<string, (typeof groups)[number]>();
  for (const s of subs) {
    const key = s.lang.toLowerCase();
    let g = byLang.get(key);
    if (!g) {
      g = { lang: s.lang, language: s.label.replace(/\s+\d+$/, ""), items: [] };
      byLang.set(key, g);
      groups.push(g);
    }
    g.items.push(s);
  }
  return groups;
}
