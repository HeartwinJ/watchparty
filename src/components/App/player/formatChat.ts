// Plain-text descriptions of chat system commands, for the chat overlay (and the sidebar chat if it wants them).
import { formatTimestamp } from "../../../utils/utils";
import { formatOffset } from "../logic/subtitles";

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
    case "host":
      return msg
        ? `changed the video to ${mediaName(msg)}`
        : "stopped the video";
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
      const n = Number(msg);
      return Number.isFinite(n)
        ? n === 0
          ? "reset the subtitle offset"
          : `set subtitles ${formatOffset(n)} for everyone`
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
  if (typeof change.nextEpisodeOffset === "number") {
    return `set the next-episode card to ${change.nextEpisodeOffset}s before the end`;
  }
  return undefined;
}
