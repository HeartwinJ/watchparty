import { apiFetch, serverPath } from "../../../utils/api";

/** Same limit as the server's text/plain body parser (POST /subtitle) */
export const MAX_SUBTITLE_BYTES = 1_000_000;

export class ShareSubtitleError extends Error {
  readonly code: "download" | "empty" | "too_large" | "upload";
  constructor(code: ShareSubtitleError["code"]) {
    super(
      {
        download: "Couldn't download the subtitle file",
        empty: "The subtitle file is empty",
        too_large: "The subtitle file is too large",
        upload: "Couldn't share the subtitles with the room",
      }[code],
    );
    this.name = "ShareSubtitleError";
    this.code = code;
  }
}

/**
 * Stores subtitle text on our server (POST /subtitle, the same flow as "Load a .srt / .vtt file") and returns its
 * URL. The player converts SRT to WebVTT when it loads it, so the room gets one stable URL for everyone.
 */
export async function uploadSubtitleText(text: string): Promise<string> {
  if (!text.trim()) {
    throw new ShareSubtitleError("empty");
  }
  if (new Blob([text]).size > MAX_SUBTITLE_BYTES) {
    throw new ShareSubtitleError("too_large");
  }
  let hash: unknown;
  try {
    const resp = await apiFetch("/subtitle", {
      method: "POST",
      body: text,
      headers: { "Content-Type": "text/plain" },
    });
    if (!resp.ok) {
      throw new Error();
    }
    hash = ((await resp.json()) as { hash?: unknown })?.hash;
  } catch {
    throw new ShareSubtitleError("upload");
  }
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new ShareSubtitleError("upload");
  }
  return `${serverPath}/subtitle/${hash}`;
}

/**
 * Downloads a subtitle from a public URL (the OpenSubtitles v3 SRTs send CORS `*`), stores it on our server and
 * returns the room-shareable URL. Pass the result to `cmd.setSubtitle`.
 */
export async function shareSubtitleFromUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  let text: string;
  try {
    // Another origin: plain fetch, no credentials
    const resp = await fetch(url, { signal });
    if (!resp.ok) {
      throw new Error();
    }
    text = await resp.text();
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      throw e;
    }
    throw new ShareSubtitleError("download");
  }
  return uploadSubtitleText(text);
}
