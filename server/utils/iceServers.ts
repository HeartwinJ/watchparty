/**
 * ICE servers for P2P WebRTC (voice/video calls, screen/file share). Uses short-lived Cloudflare Realtime TURN
 * credentials when configured, otherwise STUN only.
 * https://developers.cloudflare.com/realtime/turn/generate-credentials/
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const STUN_ONLY: IceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

// Browsers block port 53, so those URLs only make ICE wait for a timeout
function dropPort53(servers: IceServer[]): IceServer[] {
  return servers
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
        (u) => typeof u === "string" && !/:53(\?|$)/.test(u),
      );
      return { ...s, urls };
    })
    .filter((s) => s.urls.length > 0);
}

export function createIceServerProvider(opts: {
  keyId: string;
  apiToken: string;
  ttlSeconds?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}) {
  const ttlSeconds = opts.ttlSeconds ?? 24 * 60 * 60;
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  // Refresh well before expiry so a client never gets nearly-expired credentials
  const refreshMarginMs = Math.min(60 * 60 * 1000, (ttlSeconds * 1000) / 4);
  // After a failed request, serve STUN for a short while before retrying
  const failureBackoffMs = 60 * 1000;
  let cache: { servers: IceServer[]; refreshAt: number } | null = null;
  let inflight: Promise<IceServer[]> | null = null;

  const fetchCredentials = async (): Promise<IceServer[]> => {
    try {
      const resp = await fetchFn(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(opts.keyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: ttlSeconds }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!resp.ok) {
        throw new Error(`Cloudflare TURN API returned ${resp.status}`);
      }
      const data = (await resp.json()) as { iceServers?: unknown };
      const raw = Array.isArray(data?.iceServers)
        ? data.iceServers
        : data?.iceServers
          ? [data.iceServers]
          : [];
      const servers = dropPort53(raw as IceServer[]);
      if (!servers.length) {
        throw new Error("Cloudflare TURN API returned no ICE servers");
      }
      cache = {
        servers,
        refreshAt: now() + ttlSeconds * 1000 - refreshMarginMs,
      };
      return servers;
    } catch (e: any) {
      // Never log the token, only the error message
      console.warn("[iceServers] TURN credential request failed:", e?.message);
      cache = { servers: STUN_ONLY, refreshAt: now() + failureBackoffMs };
      return STUN_ONLY;
    }
  };

  return {
    async get(): Promise<IceServer[]> {
      if (!opts.keyId || !opts.apiToken) {
        return STUN_ONLY;
      }
      if (cache && cache.refreshAt > now()) {
        return cache.servers;
      }
      if (!inflight) {
        inflight = fetchCredentials().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
