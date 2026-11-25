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

/** A human-readable name for a media URL, used in the URL bar and chat. */
export function getMediaDisplayName(
  input: string | undefined,
  ctx: { roomMedia: string; participants: User[]; nameMap: StringDict },
): string {
  if (!input) {
    return "";
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
