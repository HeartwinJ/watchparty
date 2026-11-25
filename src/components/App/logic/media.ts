// Pure helpers about the room's media URL: what kind of source it is and how to show it.
import {
  isDash,
  isDirectVideoUrl,
  isFileShare,
  isHls,
  isHttp,
  isScreenShare,
  isYouTube,
} from "../../../utils/utils";

export type MediaKind =
  | "none"
  | "youtube"
  | "screenshare"
  | "fileshare"
  | "dash"
  | "hls"
  | "direct"
  | "other";

/**
 * Classifies a room media URL. The order matters: it matches how the player picks a playback path
 * (DASH before HLS, then a direct file that can be played or converted).
 */
export function classifyMedia(url: string | undefined): MediaKind {
  if (!url) {
    return "none";
  }
  if (isYouTube(url)) {
    return "youtube";
  }
  if (isScreenShare(url)) {
    return "screenshare";
  }
  if (isFileShare(url)) {
    return "fileshare";
  }
  if (isDash(url)) {
    return "dash";
  }
  if (isHls(url)) {
    return "hls";
  }
  if (isDirectVideoUrl(url)) {
    return "direct";
  }
  return "other";
}

/** The media plays in the YouTube iframe (everything else uses the <video> element). */
export const usesYouTube = (url: string) => isYouTube(url);

/** The media has a defined runtime (YouTube, links, etc., as opposed to WebRTC shares). */
export const hasDuration = (url: string) => isHttp(url);

/** The media is shared from someone's device over WebRTC. */
export const isWebRTCShare = (url: string) =>
  isScreenShare(url) || isFileShare(url);

export const findSharer = (participants: User[]) =>
  participants.find((p) => p.isScreenShare);

const DISPLAY_NAME_PARAM = "wp-name=";

/**
 * Attaches a readable name to a media URL as a fragment (`#wp-name=Title%20·%20S02E04`). Fragments aren't sent to
 * the server, so the link still plays; getMediaDisplayName shows the name instead of the URL (top bar, chat, queue).
 * Used for AIOStreams links, whose URLs carry a debrid credential and shouldn't be shown.
 */
export function withDisplayName(url: string, name: string): string {
  const encoded = DISPLAY_NAME_PARAM + encodeURIComponent(name);
  return url.includes("#") ? `${url}&${encoded}` : `${url}#${encoded}`;
}

/** The name attached by withDisplayName, if any */
export function getAttachedDisplayName(url: string): string | undefined {
  const hash = url.indexOf("#");
  if (hash < 0) {
    return undefined;
  }
  const match = url
    .slice(hash + 1)
    .split("&")
    .find((part) => part.startsWith(DISPLAY_NAME_PARAM));
  if (!match) {
    return undefined;
  }
  try {
    return (
      decodeURIComponent(match.slice(DISPLAY_NAME_PARAM.length)) || undefined
    );
  } catch {
    return undefined;
  }
}

/** A human-readable name for a media URL, used in the URL bar and chat. */
export function getMediaDisplayName(
  input: string | undefined,
  ctx: { roomMedia: string; participants: User[]; nameMap: StringDict },
): string {
  if (!input) {
    return "";
  }
  const attached = getAttachedDisplayName(input);
  if (attached) {
    return attached;
  }
  // Show the whole URL for youtube
  if (usesYouTube(ctx.roomMedia)) {
    return input;
  }
  if (input.startsWith("screenshare://")) {
    const sharer = findSharer(ctx.participants);
    return ctx.nameMap[sharer?.id ?? ""] + "'s screen";
  }
  if (input.startsWith("fileshare://")) {
    const sharer = findSharer(ctx.participants);
    return ctx.nameMap[sharer?.id ?? ""] + "'s file";
  }
  if (input.includes("/proxy")) {
    const urlParsed = new URLSearchParams(input);
    const displayName = urlParsed.get("displayName");
    if (displayName) {
      return displayName;
    }
  }
  return input;
}
