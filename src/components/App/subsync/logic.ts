// Auto subtitle sync: pure decisions for the hook and the menu (what can be synced, how a subtitle is named, what to
// say about a result, how to apply it).
import { classifyMedia } from "../logic/media";
import { formatTiming } from "../logic/subtitles";
import type { SyncResult } from "./signal";

export type AutoSyncAvailability =
  { ok: true; source: string | File } | { ok: false; reason: string };

/**
 * Whether this device can auto-sync the room's current media, and what to read the audio from. The reasons are the
 * wand's tooltip. A file share can only be synced by the person sharing it (they have the File).
 */
export function autoSyncAvailability(input: {
  media: string;
  isLiveStream: boolean;
  /** The File this device is sharing, if any */
  sharedFile: File | undefined;
  /** This browser has a Worker and WebCodecs audio decoding */
  supported: boolean;
}): AutoSyncAvailability {
  const kind = classifyMedia(input.media);
  switch (kind) {
    case "none":
      return { ok: false, reason: "Nothing is playing" };
    case "youtube":
      return { ok: false, reason: "Not available for YouTube videos" };
    case "screenshare":
      return { ok: false, reason: "Not available for screen shares" };
    case "hls":
    case "dash":
      return { ok: false, reason: "Not available for streams (HLS/DASH)" };
    case "other":
      return { ok: false, reason: "Not available for this kind of link" };
    default:
      break;
  }
  if (input.isLiveStream) {
    return { ok: false, reason: "Not available for live streams" };
  }
  if (!input.supported) {
    return {
      ok: false,
      reason: "This browser can't decode audio for syncing",
    };
  }
  if (kind === "fileshare") {
    return input.sharedFile
      ? { ok: true, source: input.sharedFile }
      : {
          ok: false,
          reason: "Only the person sharing the file can auto-sync it",
        };
  }
  return { ok: true, source: input.media };
}

/**
 * Names the subtitle being synced, so the room computes each (video, subtitle) once: the room subtitle by its URL,
 * anything else (a track embedded in the file) by its position and label.
 */
export function subtitleSyncKey(
  track: { fromRoom: boolean; index: number; label: string; language: string },
  roomSubtitle: string,
): string {
  return track.fromRoom && roomSubtitle
    ? `room:${roomSubtitle}`
    : `track:${track.index}:${track.language}:${track.label}`;
}

/** The toast after a sync. `auto`: the room's auto-sync (the offset was applied for everyone). */
export function describeSyncOutcome(
  offset: number | null,
  opts: { auto?: boolean; by?: string; scale?: number } = {},
): string {
  if (offset === null) {
    return opts.auto
      ? "Auto-sync couldn't find a confident match, offset unchanged"
      : "Couldn't find a confident match, offset unchanged";
  }
  const scale = opts.scale ?? 1;
  const value =
    offset === 0 && scale === 1
      ? "already in sync"
      : formatTiming(offset, scale);
  if (opts.auto && opts.by) {
    return `Subtitles auto-synced by ${opts.by}: ${value}`;
  }
  return opts.auto
    ? `Subtitles auto-synced: ${value}`
    : `Subtitles synced: ${value}`;
}

/** "Listening… 40%" while reading audio; "Matching…" for the last step */
export function syncProgressLabel(progress: number) {
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return pct >= 100 ? "Matching…" : `Listening… ${pct}%`;
}

/** Turns a confident result into what the player applies: shown = original × scale + offset (null = keep as is) */
export function syncResultToTiming(
  result: SyncResult,
): { offset: number; scale: number } | null {
  return result.offset === null
    ? null
    : { offset: result.offset, scale: result.scale };
}
