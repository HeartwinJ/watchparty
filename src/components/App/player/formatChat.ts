// Plain-text descriptions of chat system commands, for the chat overlay (and the sidebar chat if it wants them).
import { formatTimestamp } from "../../../utils/utils";
import { parseShareUrl } from "../logic/media";
import { formatTiming, normalizeScale } from "../logic/subtitles";

/** A subtitle timing chat msg: the offset ("2.35"), or JSON {offset, scale} with a time scale */
function parseTimingMsg(
  msg: string | undefined,
): { offset: number; scale: number } | undefined {
  const text = msg ?? "";
  if (text.startsWith("{")) {
    try {
      const d = JSON.parse(text) as { offset?: unknown; scale?: unknown };
      return typeof d.offset === "number" && Number.isFinite(d.offset)
        ? {
            offset: d.offset,
            scale: normalizeScale(typeof d.scale === "number" ? d.scale : 1),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }
  const n = text.trim() === "" ? NaN : Number(text);
  return Number.isFinite(n) ? { offset: n, scale: 1 } : undefined;
}

/**
 * Describes a chat message's `cmd` (play, pause, seek, host, subtitleOffset, ...) as "Alex <text>". Returns undefined
 * for commands it doesn't know. `subtitleOffset` is new with the player redesign: msg is the offset in seconds.
 */
export function describeChatCommand(
  cmd: string,
  msg: string | undefined,
  mediaName: (url?: string) => string = (u) => u ?? "",
): string | undefined {
  switch (cmd) {
    case "host": {
      const share = parseShareUrl(msg);
      if (share) {
        // The person who starts a share is always the sharer (the server sets the URL from their own id)
        return share.kind === "screen"
          ? "started sharing their screen"
          : "started sharing a file";
      }
      return msg
        ? `changed the video to ${mediaName(msg)}`
        : "stopped the video";
    }
    case "playlistAdd":
      return `added ${mediaName(msg)} to the queue`;
    case "seek":
      return `jumped to ${formatTimestamp(msg)}`;
    case "play":
      return `started the video at ${formatTimestamp(msg)}`;
    case "pause":
      return `paused the video at ${formatTimestamp(msg)}`;
    case "playbackRate":
      return `set the speed to ${msg === "0" ? "auto" : `${msg}×`}`;
    case "subtitleOffset": {
      const t = parseTimingMsg(msg);
      return t
        ? t.offset === 0 && t.scale === 1
          ? "reset the subtitle offset"
          : `set subtitles ${formatTiming(t.offset, t.scale)} for everyone`
        : undefined;
    }
    case "subtitleAutoSync": {
      // The room's auto-sync applied a timing computed on this person's device
      const t = parseTimingMsg(msg);
      return t
        ? t.offset === 0 && t.scale === 1
          ? "auto-synced the subtitles (already in sync)"
          : `auto-synced the subtitles: ${formatTiming(t.offset, t.scale)} for everyone`
        : undefined;
    }
    case "roomSettings":
      return describeRoomSettingsChange(msg);
    case "nowPlaying":
      return describeNowPlaying(msg, mediaName);
    case "roomPassword":
      // msg is what changed, never the password itself
      return msg === "changed"
        ? "changed the room password"
        : msg === "on"
          ? "turned on the room password"
          : msg === "off"
            ? "turned off the room password"
            : undefined;
    default:
      return undefined;
  }
}

/**
 * A line without a person (`id: ""`): the server posts these for things nobody chose, like the queue advancing or
 * the next episode starting (`nowPlaying`). The chat shows them without a name or avatar.
 */
export function isPersonlessLine(m: Pick<ChatMessageBase, "id">): boolean {
  return !m.id;
}

/**
 * `nowPlaying` lines: msg is JSON `{via: "queue"|"nextEpisode", title}` (the server's readable name, never an
 * AIOStreams URL) or `{via, url}` when it had none, named like a `host` line. → "Now playing Spring (from the queue)"
 */
function describeNowPlaying(
  msg: string | undefined,
  mediaName: (url?: string) => string,
) {
  let data: { via?: unknown; title?: unknown; url?: unknown };
  try {
    data = JSON.parse(msg ?? "");
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const name =
    typeof data.title === "string" && data.title
      ? data.title
      : typeof data.url === "string" && data.url
        ? mediaName(data.url)
        : "";
  const why =
    data.via === "queue"
      ? " (from the queue)"
      : data.via === "nextEpisode"
        ? " (next episode)"
        : "";
  return name
    ? `Now playing ${name}${why}`
    : `Now playing the next video${why}`;
}

/** `roomSettings` lines: msg is JSON with the one setting that changed, e.g. `{"readyCheck":true}` */
function describeRoomSettingsChange(msg: string | undefined) {
  let change: Partial<Record<keyof RoomSettings, unknown>>;
  try {
    change = JSON.parse(msg ?? "");
  } catch {
    return undefined;
  }
  if (!change || typeof change !== "object") {
    return undefined;
  }
  if (typeof change.title === "string") {
    return change.title
      ? `renamed the room to “${change.title}”`
      : "reset the room name";
  }
  if (typeof change.readyCheck === "boolean") {
    return `turned the ready check ${change.readyCheck ? "on" : "off"}`;
  }
  if (typeof change.autoSyncSubtitles === "boolean") {
    return `turned subtitle auto-sync ${change.autoSyncSubtitles ? "on" : "off"}`;
  }
  if (typeof change.nextEpisodeOffset === "number") {
    return `set the next-episode card to ${change.nextEpisodeOffset}s before the end`;
  }
  return undefined;
}
