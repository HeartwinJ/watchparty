import config from "../config.ts";

/** Headers for the OpenSubtitles.com REST API (needs an API consumer key and a User-Agent). */
export function openSubtitlesHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "User-Agent": config.OPENSUBTITLES_USER_AGENT || "watchparty v1",
    "Api-Key": config.OPENSUBTITLES_KEY,
    ...extra,
  };
}

export interface OpenSubtitlesError {
  error: "opensubtitles_error";
  /** HTTP status OpenSubtitles returned */
  status: number;
  /** OpenSubtitles' own explanation, e.g. "You cannot consume this service" (bad/missing API key) */
  message: string;
}

/** Turn a failed OpenSubtitles response into a client-safe error (never includes the API key). */
export async function openSubtitlesError(
  resp: Response,
): Promise<OpenSubtitlesError> {
  let message = "";
  try {
    const text = (await resp.text()).slice(0, 2000);
    try {
      const body = JSON.parse(text);
      message = String(body?.message ?? body?.error ?? body?.errors ?? "");
    } catch {
      message = text;
    }
  } catch {
    // Body unreadable; the status is still useful
  }
  message = message.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!message) {
    message = `HTTP ${resp.status}`;
  }
  if (resp.status === 403 && /cannot consume/i.test(message)) {
    message +=
      " (check OPENSUBTITLES_KEY: it must be the API key of an API consumer created under your opensubtitles.com profile)";
  }
  return { error: "opensubtitles_error", status: resp.status, message };
}
