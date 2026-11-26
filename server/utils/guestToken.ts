import crypto from "node:crypto";

/**
 * Guest access to individual rooms (see roomAuth.ts). One httpOnly cookie holds up to MAX_GUEST_GRANTS grants, each
 * {roomId, epoch, guestId, expiresAt}, signed together:
 *
 *   g1.<base64url(JSON [[roomId, epoch, guestId, expiresAtMs], ...])>.<base64url HMAC-SHA256>
 *
 * The MAC key is derived from SESSION_SECRET with a fixed label, so it differs from the owner session's key, and the
 * format ("g1", 3 parts) can never parse as an owner session ("v1", 4 parts) or the other way round. A grant only
 * counts while the room's password epoch still matches and its guestId isn't revoked (checked by the caller).
 */

export const GUEST_COOKIE = "wp_guest";
export const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_GUEST_GRANTS = 8;
/** Cookie values above this are ignored without parsing (8 grants with long room ids stay well below it) */
const MAX_TOKEN_LENGTH = 3000;
const MAX_ROOM_ID_LENGTH = 200;

export interface GuestGrant {
  /** Room id with the leading slash, as used for the Socket.IO namespace */
  roomId: string;
  /** The room's password epoch when the grant was issued */
  epoch: number;
  /** Random id for this guest in this room (kicking revokes it) */
  guestId: string;
  expiresAt: number;
}

/** The MAC key for guest grants: a label-separated derivation of the session secret. */
export function deriveGuestKey(sessionSecret: string): Buffer {
  return crypto
    .createHmac("sha256", sessionSecret)
    .update("watchparty guest grants v1")
    .digest();
}

function mac(key: Buffer, payload: string) {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

export function newGuestId(): string {
  return crypto.randomBytes(12).toString("base64url");
}

export function signGuestGrants(key: Buffer, grants: GuestGrant[]): string {
  const data = grants.map((g) => [g.roomId, g.epoch, g.guestId, g.expiresAt]);
  const payload = `g1.${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
  return `${payload}.${mac(key, payload)}`;
}

function isGrantTuple(v: unknown): v is [string, number, string, number] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    typeof v[0] === "string" &&
    v[0].startsWith("/") &&
    v[0].length <= MAX_ROOM_ID_LENGTH &&
    Number.isSafeInteger(v[1]) &&
    v[1] >= 0 &&
    typeof v[2] === "string" &&
    /^[A-Za-z0-9_-]{8,32}$/.test(v[2]) &&
    Number.isSafeInteger(v[3])
  );
}

/** The unexpired grants in a cookie value; [] if it's missing, malformed or the signature doesn't match. */
export function verifyGuestGrants(
  key: Buffer,
  token: string | undefined,
  now = Date.now(),
): GuestGrant[] {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return [];
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "g1") {
    return [];
  }
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(mac(key, payload));
  const actual = Buffer.from(parts[2]);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .filter(isGrantTuple)
    .slice(0, MAX_GUEST_GRANTS)
    .map(([roomId, epoch, guestId, expiresAt]) => ({
      roomId,
      epoch,
      guestId,
      expiresAt,
    }))
    .filter((g) => g.expiresAt > now);
}

/**
 * Adds (or replaces) the grant for `grant.roomId`. Keeps at most MAX_GUEST_GRANTS, dropping the ones that expire
 * first, so the cookie stays bounded in size.
 */
export function addGuestGrant(
  grants: GuestGrant[],
  grant: GuestGrant,
): GuestGrant[] {
  const others = grants
    .filter((g) => g.roomId !== grant.roomId)
    .sort((a, b) => b.expiresAt - a.expiresAt)
    .slice(0, MAX_GUEST_GRANTS - 1);
  return [grant, ...others];
}
