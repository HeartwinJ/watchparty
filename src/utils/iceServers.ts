import { apiFetch } from "./api";

export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

// TURN credentials from the server are short-lived, so don't hold on to them forever
const CACHE_TTL_MS = 60 * 60 * 1000;

let cached: { promise: Promise<RTCIceServer[]>; expires: number } | undefined;

function isIceServerList(data: unknown): data is RTCIceServer[] {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every(
      (s) =>
        s &&
        typeof s === "object" &&
        (typeof s.urls === "string" || Array.isArray(s.urls)),
    )
  );
}

async function loadIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await apiFetch("/iceServers");
    if (!response.ok) {
      throw new Error(`/iceServers responded ${response.status}`);
    }
    const data: unknown = await response.json();
    if (!isIceServerList(data)) {
      throw new Error("/iceServers returned an invalid list");
    }
    return data;
  } catch (e) {
    console.warn("Using fallback ICE servers:", e);
    return FALLBACK_ICE_SERVERS;
  }
}

/** ICE servers (STUN/TURN) for calls and screen/file share, fetched from the server once and cached in memory. */
export function getIceServers(now = Date.now()): Promise<RTCIceServer[]> {
  if (!cached || cached.expires <= now) {
    const entry = { promise: loadIceServers(), expires: now + CACHE_TTL_MS };
    cached = entry;
    entry.promise.then((servers) => {
      // Don't cache the fallback, so the next share asks the server again
      if (servers === FALLBACK_ICE_SERVERS && cached === entry) {
        cached = undefined;
      }
    });
  }
  return cached.promise;
}

export function resetIceServersCache() {
  cached = undefined;
}
