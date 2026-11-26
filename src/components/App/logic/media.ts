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

/** `screenshare://<clientId>` / `fileshare://<clientId>` (optionally `@...`) → the kind and the sharer's client id */
export function parseShareUrl(
  url: string | undefined,
): { kind: "screen" | "file"; sharerId: string } | undefined {
  const m = /^(screenshare|fileshare):\/\/([^@]*)/.exec(url ?? "");
  return m
    ? { kind: m[1] === "screenshare" ? "screen" : "file", sharerId: m[2] }
    : undefined;
}

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
  const share = parseShareUrl(input);
  if (share) {
    // The URL names the sharer; the roster flag can lag behind (or be gone for old chat lines)
    const name =
      ctx.nameMap[share.sharerId] ??
      ctx.nameMap[findSharer(ctx.participants)?.id ?? ""];
    const what = share.kind === "screen" ? "screen" : "file";
    return name ? `${name}'s ${what}` : `a shared ${what}`;
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
