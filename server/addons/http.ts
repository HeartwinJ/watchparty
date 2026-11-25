/**
 * Minimal JSON client for Stremio addons: timeout, size limit, and errors that
 * never carry the request URL (the AIOStreams URL embeds credentials).
 */

export type FetchFn = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AddonErrorKind =
  | "timeout"
  | "network"
  | "http"
  | "too_large"
  | "invalid_json"
  | "invalid_response";

export class AddonError extends Error {
  kind: AddonErrorKind;
  upstreamStatus: number | null;
  constructor(label: string, kind: AddonErrorKind, upstreamStatus?: number) {
    // Deliberately built only from fixed strings, never from the URL or the
    // underlying error's message
    super(`${label}: ${kind}${upstreamStatus ? ` ${upstreamStatus}` : ""}`);
    this.name = "AddonError";
    this.kind = kind;
    this.upstreamStatus = upstreamStatus ?? null;
  }
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  opts: { label: string; timeoutMs: number; maxBytes?: number },
): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw toAddonError(opts.label, e);
  }
  if (!resp.ok) {
    throw new AddonError(opts.label, "http", resp.status);
  }
  if (Number(resp.headers.get("content-length")) > maxBytes) {
    throw new AddonError(opts.label, "too_large");
  }
  let text: string;
  try {
    text = await readLimited(resp, maxBytes);
  } catch (e) {
    if (e instanceof AddonError) {
      throw new AddonError(opts.label, e.kind);
    }
    throw toAddonError(opts.label, e);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AddonError(opts.label, "invalid_json");
  }
}

async function readLimited(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) {
    return "";
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AddonError("body", "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toAddonError(label: string, e: unknown): AddonError {
  const err = e as { name?: string; message?: string } | undefined;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new AddonError(label, "timeout");
  }
  // utils/ssrf.ts safeFetch throws "HTTP <status>" for non-2xx responses
  const status = err?.message?.match(/^HTTP (\d{3})$/)?.[1];
  if (status) {
    return new AddonError(label, "http", Number(status));
  }
  return new AddonError(label, "network");
}

/**
 * Builds a function that scrubs the given secret URL (and its distinctive
 * path segments, raw or URL-encoded) from any string, for log lines.
 */
export function createRedactor(secretUrl: string): (text: string) => string {
  if (!secretUrl) {
    return (text) => text;
  }
  const needles = new Set<string>([secretUrl]);
  try {
    const u = new URL(secretUrl);
    needles.add(u.pathname);
    for (const seg of u.pathname.split("/")) {
      // Skip generic segments like "stremio" or "manifest.json"
      if (seg.length >= 16) {
        needles.add(seg);
        needles.add(decodeURIComponent(seg));
        needles.add(encodeURIComponent(seg));
      }
    }
    if (u.password) {
      needles.add(u.password);
    }
  } catch {
    // Not a URL; the whole string is still redacted
  }
  const sorted = [...needles]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const n of sorted) {
      out = out.split(n).join("[redacted]");
    }
    return out;
  };
}
