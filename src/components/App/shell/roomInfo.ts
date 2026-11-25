// Pure helpers for what the shell shows about the room: a short now-playing title and each person's state.
import { formatTimestamp } from "../../../utils/utils";
import { classifyMedia, type MediaKind } from "../logic/media";

const KIND_LABEL: Record<MediaKind, string> = {
  none: "",
  youtube: "YouTube",
  screenshare: "Screen share",
  fileshare: "Shared file",
  dash: "DASH stream",
  hls: "HLS stream",
  direct: "Video",
  other: "Link",
};

export function mediaKindLabel(url: string | undefined): string {
  return KIND_LABEL[classifyMedia(url)];
}

/**
 * A short title for a media URL: the display name the room already computed (e.g. "Alex's screen", a
 * `displayName` from the proxy) unless it is the raw URL, in which case the file name or the YouTube id.
 * TODO: use real titles once the picker (agent C) stores metadata with the media.
 */
export function shortMediaTitle(
  url: string | undefined,
  displayName: string,
): string {
  if (!url) {
    return "";
  }
  if (displayName && displayName !== url) {
    return displayName;
  }
  try {
    const parsed = new URL(url);
    if (classifyMedia(url) === "youtube") {
      const id =
        parsed.searchParams.get("v") ??
        parsed.pathname.split("/").filter(Boolean).pop();
      return id ? `YouTube · ${id}` : "YouTube video";
    }
    const file = parsed.pathname.split("/").filter(Boolean).pop();
    if (file) {
      return decodeURIComponent(file);
    }
    return parsed.hostname;
  } catch {
    return displayName || url;
  }
}

export type PlaybackTone = "ok" | "warn" | "idle";

/** Under this much drift from the room (in seconds) someone counts as in sync. */
export const IN_SYNC_SEC = 1.5;

/**
 * One line about a person's playback for the People tab, from their reported timestamp and the room's
 * reference time (the median of everyone's).
 */
export function describePlayback(opts: {
  ts: number | undefined;
  referenceTs: number | undefined;
  hasMedia: boolean;
  hasDuration: boolean;
}): { label: string; tone: PlaybackTone } {
  const { ts, referenceTs, hasMedia, hasDuration } = opts;
  if (!hasMedia) {
    return { label: "Idle", tone: "idle" };
  }
  if (ts === undefined || !Number.isFinite(ts)) {
    return { label: "Joining…", tone: "idle" };
  }
  if (!hasDuration) {
    return { label: "Watching", tone: "ok" };
  }
  const at = formatTimestamp(ts);
  if (referenceTs === undefined || !Number.isFinite(referenceTs)) {
    return { label: `At ${at}`, tone: "ok" };
  }
  const drift = ts - referenceTs;
  if (Math.abs(drift) < IN_SYNC_SEC) {
    return { label: `In sync · ${at}`, tone: "ok" };
  }
  const sec = Math.abs(drift).toFixed(Math.abs(drift) < 10 ? 1 : 0);
  return {
    label: `${sec} s ${drift < 0 ? "behind" : "ahead"} · ${at}`,
    tone: "warn",
  };
}
