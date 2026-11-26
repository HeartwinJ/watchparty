import { formatEpisodeCode, getAttachedDisplayName } from "./utils/history.ts";

/** Why the room's video changed without anyone choosing it */
export type NowPlayingVia = "queue" | "nextEpisode";

const TITLE_MAX = 200;

/**
 * A readable name for an automatically started video: the AIOStreams title + episode ("Example Show · S01E03"),
 * the picker's `#wp-name=` display name, or the queue item's name (YouTube title etc.). Undefined when there's
 * nothing better than the URL itself.
 */
export function nowPlayingTitle(
  url: string,
  meta: VideoMeta | null,
  name?: string | null,
): string | undefined {
  if (meta?.title) {
    const code = formatEpisodeCode(meta);
    return (code ? `${meta.title} · ${code}` : meta.title).slice(0, TITLE_MAX);
  }
  const attached = getAttachedDisplayName(url);
  if (attached) {
    return attached;
  }
  const trimmed = name?.trim();
  if (trimmed && trimmed !== url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed.slice(0, TITLE_MAX);
  }
  return undefined;
}

/**
 * The `nowPlaying` chat line for a video that started on its own (queue advanced, next episode). It has no person
 * (`id: ""`). `msg` is JSON `{via, title}`, or `{via, url}` when there's no readable title, in which case the client
 * names it like a `host` line (getMediaDisplayName). AIOStreams items always have a title, so their URL isn't sent.
 */
export function nowPlayingChatLine(
  via: NowPlayingVia,
  url: string,
  meta: VideoMeta | null,
  name?: string | null,
): ChatMessageBase {
  const title = nowPlayingTitle(url, meta, name);
  return {
    id: "",
    cmd: "nowPlaying",
    msg: JSON.stringify(title ? { via, title } : { via, url }),
  };
}
