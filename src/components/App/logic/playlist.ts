// Pure decisions about what plays next. Playlist edits themselves happen on the server (CMD:playlist*).

/** For multi-file media (URLs ending in &fileIndex=N), the URL of the next file, or undefined. */
export function getNextFileIndexUrl(url: string): string | undefined {
  const re = /&fileIndex=(\d+)$/;
  const match = re.exec(url);
  if (!match) {
    return undefined;
  }
  const nextNum = Number(match[1]) + 1;
  return url.replace(re, `&fileIndex=${nextNum}`);
}

export type EndedAction =
  | { type: "ignore" }
  | { type: "loop" }
  | { type: "playlistNext"; url: string }
  | { type: "setMedia"; url: string }
  | { type: "stop" };

/**
 * What to do when the video ends: nothing while loading, restart when looping, otherwise advance the playlist (the
 * server checks `endedUrl` so several viewers ending at once only advance it once), then the next file index.
 */
export function decideOnVideoEnded(opts: {
  loading: boolean;
  loop: boolean;
  playlistLength: number;
  roomMedia: string;
  endedUrl: string;
}): EndedAction {
  if (opts.loading) {
    return { type: "ignore" };
  }
  if (opts.loop) {
    return { type: "loop" };
  }
  if (opts.playlistLength) {
    return { type: "playlistNext", url: opts.endedUrl };
  }
  const next = getNextFileIndexUrl(opts.roomMedia);
  if (next) {
    return { type: "setMedia", url: next };
  }
  return { type: "stop" };
}

/** Playlist items with a thumbnail come from YouTube search, so they're shown as YouTube cards. */
export function withDisplayType(item: PlaylistVideo): PlaylistVideo {
  return item.img ? { ...item, type: "youtube" } : item;
}
