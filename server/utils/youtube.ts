import config from "../config.ts";
import {
  PT_HOURS_REGEX,
  PT_MINUTES_REGEX,
  PT_SECONDS_REGEX,
  YOUTUBE_VIDEO_ID_REGEX,
} from "./regex.ts";

/**
 * Minimal fetch-based client for the YouTube Data API v3 (search, videos, playlistItems).
 * Every call returns empty results when no YOUTUBE_API_KEY is configured.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3/";

interface YtSnippet {
  title?: string;
  channelTitle?: string;
  thumbnails?: { default?: { url?: string } };
  resourceId?: { videoId?: string };
}
interface YtSearchItem {
  id?: { videoId?: string };
  snippet?: YtSnippet;
}
interface YtVideo {
  id?: string;
  snippet?: YtSnippet;
  contentDetails?: { duration?: string };
}
interface YtPlaylistItem {
  snippet?: YtSnippet;
}

// Overridable for tests
let fetchFn: typeof fetch = (...args) => fetch(...args);
let apiKey = config.YOUTUBE_API_KEY;
export function setYoutubeClient(opts: {
  fetchFn?: typeof fetch;
  apiKey?: string;
}) {
  if (opts.fetchFn) {
    fetchFn = opts.fetchFn;
  }
  if (opts.apiKey !== undefined) {
    apiKey = opts.apiKey;
  }
}

async function ytGet<T>(
  resource: string,
  params: Record<string, string>,
): Promise<T[] | null> {
  if (!apiKey) {
    return null;
  }
  const url = new URL(resource, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("key", apiKey);
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) {
    // Don't include the URL, it contains the API key
    throw new Error(`YouTube API ${resource} failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { items?: T[] };
  return data.items ?? [];
}

export const mapYoutubeSearchResult = (video: YtSearchItem): PlaylistVideo => {
  return {
    channel: video.snippet?.channelTitle ?? "",
    url: "https://www.youtube.com/watch?v=" + video?.id?.videoId,
    name: video.snippet?.title ?? "",
    img: video.snippet?.thumbnails?.default?.url ?? "",
    duration: 0,
    type: "youtube",
  };
};

export const mapYoutubeListResult = (video: YtVideo): PlaylistVideo => {
  return {
    url: "https://www.youtube.com/watch?v=" + video.id,
    name: video.snippet?.title ?? "",
    img: video.snippet?.thumbnails?.default?.url ?? "",
    channel: video.snippet?.channelTitle ?? "",
    duration: getVideoDuration(video.contentDetails?.duration ?? ""),
    type: "youtube",
  };
};

export const mapYoutubePlaylistResult = (
  item: YtPlaylistItem,
): PlaylistVideo => {
  return {
    url: "https://www.youtube.com/watch?v=" + item.snippet?.resourceId?.videoId,
    name: item.snippet?.title ?? "",
    img: item.snippet?.thumbnails?.default?.url ?? "",
    channel: item.snippet?.channelTitle ?? "",
    duration: 0,
    type: "youtube",
  };
};

/** GET /youtube's `q`: a non-blank string of at most 500 characters, else undefined (400 invalid_params) */
export const parseYoutubeQuery = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.trim() && raw.length <= 500 ? raw : undefined;

export const searchYoutube = async (
  query: string,
): Promise<PlaylistVideo[]> => {
  const items = await ytGet<YtSearchItem>("search", {
    part: "snippet",
    type: "video",
    maxResults: "25",
    q: query,
  });
  return items?.map(mapYoutubeSearchResult) ?? [];
};

export const youtubePlaylist = async (
  playlistId: string,
): Promise<PlaylistVideo[]> => {
  const items = await ytGet<YtPlaylistItem>("playlistItems", {
    part: "snippet",
    playlistId,
    maxResults: "50", // API maximum
  });
  return items?.map(mapYoutubePlaylistResult) ?? [];
};

export const fetchYoutubeVideo = async (
  id: string,
): Promise<PlaylistVideo | null> => {
  const items = await ytGet<YtVideo>("videos", {
    part: "snippet,contentDetails",
    id,
  });
  const top = items?.[0];
  return top ? mapYoutubeListResult(top) : null;
};

export const getYoutubeVideoID = (url: string) => {
  const idParts = YOUTUBE_VIDEO_ID_REGEX.exec(url);
  if (!idParts) {
    return;
  }

  const id = idParts[1];
  if (!id) {
    return;
  }

  return id;
};

export const getVideoDuration = (string: string): number => {
  if (!string) {
    return 0;
  }
  const hoursParts = PT_HOURS_REGEX.exec(string);
  const minutesParts = PT_MINUTES_REGEX.exec(string);
  const secondsParts = PT_SECONDS_REGEX.exec(string);

  const hours = hoursParts ? parseInt(hoursParts[1]) : 0;
  const minutes = minutesParts ? parseInt(minutesParts[1]) : 0;
  const seconds = secondsParts ? parseInt(secondsParts[1]) : 0;

  const totalSeconds = seconds + minutes * 60 + hours * 60 * 60;
  return totalSeconds;
};

export const isYouTube = (input: string) => {
  return (
    input.startsWith("https://www.youtube.com/") ||
    input.startsWith("https://youtu.be/")
  );
};
