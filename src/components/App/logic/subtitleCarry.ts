/**
 * Keeping a viewer's subtitles on (or off) across a video change, e.g. the next episode (pure; useSubtitles applies
 * it). Right before the room's video changes, `captureCarry` remembers what this device was showing; once the new
 * video's tracks are known, `pickCarry` finds the matching subtitle in the same language.
 */
import type { SubtitleTrackOption } from "../roomState";
import {
  guessLanguage,
  languageName,
  stripNumber,
} from "../player/subtitleChoices";

/** How long after the video change a carried choice may still be applied */
export const CARRY_MS = 60_000;

/** A text track on the <video> (HTML.getSubtitleTracks) */
export interface CarryTrack {
  index: number;
  label: string;
  language: string;
  fromRoom: boolean;
}

export type SubtitleCarry =
  | {
      on: true;
      /** Language name ("English"), null when unknown */
      lang: string | null;
      /** The room's subtitle (auto/search/upload, shared with everyone) or a track embedded in the file */
      kind: "room" | "embedded";
      prevMeta: VideoMeta | null;
      at: number;
    }
  | {
      /** The room had a subtitle but this device had it off: keep it off when the next one loads */
      on: false;
      prevMeta: VideoMeta | null;
      at: number;
    };

/** "en" / "eng" / "English 2" / "English [SDH]" → "English" */
export function trackLanguage(code: string | undefined, label = "") {
  return (
    languageName(code) ??
    (label ? guessLanguage(stripNumber(label)) || null : null)
  );
}

/** What this device shows right before the video changes; null when there's nothing to keep */
export function captureCarry(opts: {
  selected: number;
  tracks: readonly CarryTrack[];
  roomSubtitle: string;
  autoTracks: readonly SubtitleTrackOption[] | undefined;
  meta: VideoMeta | null;
  now: number;
}): SubtitleCarry | null {
  const { selected, tracks, roomSubtitle, autoTracks, meta, now } = opts;
  const track = selected >= 0 ? tracks.find((t) => t.index === selected) : null;
  if (!track) {
    return roomSubtitle ? { on: false, prevMeta: meta, at: now } : null;
  }
  if (track.fromRoom) {
    // The room track is always labelled "English"; its real language is the auto track it came from, if any
    const auto = autoTracks?.find((a) => a.url === roomSubtitle);
    return {
      on: true,
      kind: "room",
      lang: auto ? trackLanguage(auto.lang, auto.label) : null,
      prevMeta: meta,
      at: now,
    };
  }
  return {
    on: true,
    kind: "embedded",
    lang: trackLanguage(track.language, track.label),
    prevMeta: meta,
    at: now,
  };
}

/** The show an AIOStreams id belongs to: `tt123:1:2` → `tt123`, `kitsu:45:6` → `kitsu:45` */
export function showId(meta: VideoMeta | null): string | null {
  if (!meta) {
    return null;
  }
  const parts = meta.id.split(":");
  return parts[0] === "kitsu" ? parts.slice(0, 2).join(":") : parts[0];
}

/**
 * Whether the new video continues the old one: the same series (by id or IMDb id), or two plain links (no metadata,
 * so we can't tell; only this device's own embedded track can be carried then).
 */
export function sameShow(prev: VideoMeta | null, next: VideoMeta | null) {
  if (!prev && !next) {
    return true;
  }
  if (!prev || !next || prev.type === "movie" || next.type === "movie") {
    return false;
  }
  return (
    showId(prev) === showId(next) ||
    Boolean(prev.imdbId && prev.imdbId === next.imdbId)
  );
}

export type CarryPick =
  | { action: "room"; url: string }
  | { action: "track"; index: number }
  | { action: "off" };

/**
 * What to do for a carried choice with what's known about the new video so far; null = nothing (yet).
 * `autoTracks` is undefined while the new title's auto subtitles are loading. `mediaReady`: the new media has loaded,
 * so its embedded tracks are in.
 */
export function pickCarry(
  carry: SubtitleCarry,
  opts: {
    selected: number;
    tracks: readonly CarryTrack[];
    roomSubtitle: string;
    autoTracks: readonly SubtitleTrackOption[] | undefined;
    mediaReady: boolean;
  },
): CarryPick | null {
  const { selected, tracks, roomSubtitle, autoTracks, mediaReady } = opts;
  if (!carry.on) {
    const room = tracks.find((t) => t.fromRoom);
    return room && selected === room.index ? { action: "off" } : null;
  }
  const matches = (lang: string | null) =>
    carry.lang === null || lang === carry.lang;
  const embedded = () => {
    const t = tracks.find(
      (t) => !t.fromRoom && matches(trackLanguage(t.language, t.label)),
    );
    return t ? ({ action: "track", index: t.index } as const) : null;
  };
  const auto = () => {
    // Someone else already picked the room subtitle: it loads and shows on its own
    if (roomSubtitle) {
      return null;
    }
    // Auto subtitles come with the room's preferred languages first
    const a = autoTracks?.find((a) => matches(trackLanguage(a.lang, a.label)));
    return a ? ({ action: "room", url: a.url } as const) : null;
  };
  if (carry.kind === "room") {
    // Wait for the auto subtitles before falling back to a track in the file
    return autoTracks === undefined || roomSubtitle
      ? null
      : (auto() ?? embedded());
  }
  // The file's own tracks first, once the media has loaded
  return embedded() ?? (mediaReady ? auto() : null);
}
