// Pure helpers for the next-episode card (PLAN 6d). The server decides everything room-wide
// (server/nextEpisodeController.ts); clients only report when they're near the end and render the card.
import type { RoomState } from "../roomState";

/** Seconds before the end at which the card shows (room setting, adjustable in the settings modal) */
export function nextEpisodeOffset(state: Pick<RoomState, "roomSettings">) {
  return state.roomSettings.nextEpisodeOffset;
}

/** How often a player inside the window repeats its offer (the server keeps the first one per video) */
export const OFFER_RESEND_MS = 5000;

const isEpisode = (meta: VideoMeta | null) =>
  Boolean(
    meta &&
    (meta.type === "series" || meta.type === "anime") &&
    meta.episode !== null,
  );

/**
 * Whether this player should tell the server it's near the end: an AIOStreams episode, no queue (an explicit queue
 * wins), not looping, no card yet, and within `offset` seconds of a known end.
 */
export function shouldOfferNextEpisode(opts: {
  videoMeta: VideoMeta | null;
  playlistLength: number;
  loop: boolean;
  nextState: NextEpisodeState["state"];
  currentTime: number;
  duration: number;
  offset: number;
}): boolean {
  const { currentTime, duration } = opts;
  return (
    isEpisode(opts.videoMeta) &&
    opts.playlistLength === 0 &&
    !opts.loop &&
    opts.nextState === "none" &&
    Number.isFinite(duration) &&
    duration > 0 &&
    Number.isFinite(currentTime) &&
    currentTime > 0 &&
    duration - currentTime <= opts.offset
  );
}

/** Whole seconds left on the card's countdown (startAt is the video's end, in video seconds) */
export function countdownSeconds(startAt: number, currentTime: number) {
  if (!Number.isFinite(currentTime)) {
    return 0;
  }
  return Math.max(0, Math.ceil(startAt - currentTime));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "S01E03", "E05" without a season */
export function episodeLabel(meta: Pick<VideoMeta, "season" | "episode">) {
  if (meta.episode === null) {
    return "";
  }
  return meta.season === null
    ? `E${pad2(meta.episode)}`
    : `S${pad2(meta.season)}E${pad2(meta.episode)}`;
}

/** The card's lines: "Up next · S01E03 · Title" plus the show name */
export function describeNext(next: NextEpisodeInfo) {
  const code = episodeLabel(next.meta);
  const heading = ["Up next", code, next.meta.episodeTitle]
    .filter(Boolean)
    .join(" · ");
  return {
    heading,
    show: next.meta.title,
    short: code ? `${next.meta.title} · ${code}` : next.meta.title,
    image: next.thumbnail ?? next.meta.poster,
  };
}

/** Toast/OSD text for a room-wide change, or null when there's nothing to say */
export function nextEpisodeNotice(
  s: NextEpisodeState,
  ctx: { clientId: string; nameMap: StringDict },
): string | null {
  const who = (by: PlaybackActor | null) =>
    by ? by.name || ctx.nameMap[by.id] || "Someone" : null;
  switch (s.state) {
    case "cancelled": {
      if (!s.by || s.by.id === ctx.clientId) {
        return "Next episode cancelled";
      }
      return `${who(s.by)} cancelled the next episode`;
    }
    case "starting": {
      const name = describeNext(s.next).short;
      if (s.by && s.by.id !== ctx.clientId) {
        return `${who(s.by)} started ${name}`;
      }
      return `Up next: ${name}`;
    }
    case "failed":
      return "Couldn't find the next episode";
    default:
      return null;
  }
}
