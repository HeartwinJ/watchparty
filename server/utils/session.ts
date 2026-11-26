import crypto from "node:crypto";

/**
 * Stateless session tokens for the instance password.
 * Format: v1.<expiresAtMs>.<nonce>.<base64url HMAC-SHA256 of the preceding parts>
 */

export const SESSION_COOKIE = "wp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hmac(secret: string, payload: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

export function signSession(
  secret: string,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
): string {
  const payload = `v1.${now + ttlMs}.${crypto.randomBytes(12).toString("base64url")}`;
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifySession(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token || token.length > 200) {
    return false;
  }
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return false;
  }
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(hmac(secret, payload));
  const actual = Buffer.from(parts[3]);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return false;
  }
  const expiresAt = Number(parts[1]);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Constant-time password comparison (hashing first makes the lengths equal). */
export function checkPassword(input: unknown, expected: string): boolean {
  if (typeof input !== "string" || input.length > 1000) {
    return false;
  }
  const a = crypto.createHash("sha256").update(input).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): StringDict {
  const out: StringDict = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) {
      continue;
    }
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name || Object.hasOwn(out, name)) {
      continue;
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function createRateLimiter(opts: { max: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Record an attempt. Returns false if the key is over the limit. */
    hit(key: string, now = Date.now()): boolean {
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        // Opportunistically drop expired entries so the map can't grow forever
        if (hits.size > 10000) {
          for (const [k, v] of hits) {
            if (v.resetAt <= now) {
              hits.delete(k);
            }
          }
        }
        entry = { count: 0, resetAt: now + opts.windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= opts.max;
    },
    reset(key: string) {
      hits.delete(key);
    },
    /**
     * For limiters that only count failures: whole seconds until the key may try again once it has used up all
     * `max` attempts in the window (0 while it still has attempts left). Doesn't record anything.
     */
    blockedSec(key: string, now = Date.now()): number {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now || entry.count < opts.max) {
        return 0;
      }
      return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    },
    /** Whole seconds until the key's window resets (0 if it isn't limited). */
    retryAfterSec(key: string, now = Date.now()): number {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now || entry.count <= opts.max) {
        return 0;
      }
      return Math.ceil((entry.resetAt - now) / 1000);
    },
  };
}
