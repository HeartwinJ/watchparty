import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GUEST_TTL_MS,
  MAX_GUEST_GRANTS,
  addGuestGrant,
  deriveGuestKey,
  newGuestId,
  signGuestGrants,
  verifyGuestGrants,
  type GuestGrant,
} from "./guestToken.ts";
import { signSession, verifySession } from "./session.ts";

const key = deriveGuestKey("test-secret");
const grant = (over: Partial<GuestGrant> = {}): GuestGrant => ({
  roomId: "/happy-otter-runs",
  epoch: 0,
  guestId: newGuestId(),
  expiresAt: 1000 + GUEST_TTL_MS,
  ...over,
});

describe("guest grant tokens", () => {
  it("round-trips grants", () => {
    const grants = [grant(), grant({ roomId: "/other-room-here", epoch: 3 })];
    expect(verifyGuestGrants(key, signGuestGrants(key, grants), 1000)).toEqual(
      grants,
    );
  });

  it("drops expired grants but keeps the rest", () => {
    const a = grant({ expiresAt: 5000 });
    const b = grant({ roomId: "/b-room-x", expiresAt: 9000 });
    const token = signGuestGrants(key, [a, b]);
    expect(verifyGuestGrants(key, token, 4999)).toEqual([a, b]);
    expect(verifyGuestGrants(key, token, 5000)).toEqual([b]);
    expect(verifyGuestGrants(key, token, 9000)).toEqual([]);
  });

  it("rejects tampered payloads and signatures", () => {
    const token = signGuestGrants(key, [grant()]);
    const [v, payload, mac] = token.split(".");
    // Rewrite the payload (e.g. another room or a later expiry) with the old MAC
    const forged = Buffer.from(
      JSON.stringify([["/someone-elses-room", 0, "abcdefgh12", 9e15]]),
    ).toString("base64url");
    expect(verifyGuestGrants(key, [v, forged, mac].join("."), 1000)).toEqual(
      [],
    );
    // Flip one character of the MAC
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    expect(
      verifyGuestGrants(key, [v, payload, flipped].join("."), 1000),
    ).toEqual([]);
    expect(verifyGuestGrants(key, [v, payload].join("."), 1000)).toEqual([]);
    expect(
      verifyGuestGrants(key, ["v1", payload, mac].join("."), 1000),
    ).toEqual([]);
  });

  it("rejects tokens signed with another secret", () => {
    const token = signGuestGrants(deriveGuestKey("other"), [grant()]);
    expect(verifyGuestGrants(key, token, 1000)).toEqual([]);
  });

  it("can't be confused with an owner session (separate key and format)", () => {
    const secret = "shared-secret";
    const guestKey = deriveGuestKey(secret);
    const guestToken = signGuestGrants(guestKey, [grant()]);
    expect(verifySession(secret, guestToken, 1000)).toBe(false);
    expect(
      verifyGuestGrants(guestKey, signSession(secret, 1000), 1000),
    ).toEqual([]);
    // The derived key isn't the secret itself
    expect(guestKey.equals(Buffer.from(secret))).toBe(false);
  });

  it("ignores garbage, oversize tokens and invalid grant entries", () => {
    expect(verifyGuestGrants(key, undefined)).toEqual([]);
    expect(verifyGuestGrants(key, "")).toEqual([]);
    expect(verifyGuestGrants(key, "g1.x.y")).toEqual([]);
    expect(verifyGuestGrants(key, "g1." + "a".repeat(5000) + ".b")).toEqual([]);
    // Validly signed but malformed entries are dropped
    const sign = (data: unknown) => {
      const payload = `g1.${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
      const mac = crypto
        .createHmac("sha256", key)
        .update(payload)
        .digest("base64url");
      return `${payload}.${mac}`;
    };
    expect(verifyGuestGrants(key, sign({ not: "an array" }), 0)).toEqual([]);
    expect(
      verifyGuestGrants(
        key,
        sign([
          ["no-slash", 0, "abcdefgh12", 9e12],
          ["/ok-room", -1, "abcdefgh12", 9e12],
          ["/ok-room", 0, "bad id!", 9e12],
          ["/ok-room", 0, "abcdefgh12"],
          ["/ok-room", 1.5, "abcdefgh12", 9e12],
          ["/ok-room", 2, "abcdefgh12", 9e12],
        ]),
        0,
      ),
    ).toEqual([
      { roomId: "/ok-room", epoch: 2, guestId: "abcdefgh12", expiresAt: 9e12 },
    ]);
  });

  it("keeps at most MAX_GUEST_GRANTS, replacing the same room and dropping the soonest to expire", () => {
    let grants: GuestGrant[] = [];
    for (let i = 0; i < MAX_GUEST_GRANTS + 3; i++) {
      grants = addGuestGrant(
        grants,
        grant({ roomId: `/room-${i}`, expiresAt: 1000 + i }),
      );
    }
    expect(grants).toHaveLength(MAX_GUEST_GRANTS);
    expect(grants.map((g) => g.roomId)).not.toContain("/room-0");
    expect(grants[0].roomId).toBe(`/room-${MAX_GUEST_GRANTS + 2}`);
    const replaced = addGuestGrant(
      grants,
      grant({ roomId: "/room-5", epoch: 7, expiresAt: 5 }),
    );
    expect(replaced).toHaveLength(MAX_GUEST_GRANTS);
    expect(replaced.filter((g) => g.roomId === "/room-5")).toEqual([
      expect.objectContaining({ epoch: 7 }),
    ]);
    // A full cookie with long room ids stays far below browser cookie limits
    const long = Array.from({ length: MAX_GUEST_GRANTS }, (_, i) =>
      grant({ roomId: "/" + "x".repeat(60) + i }),
    );
    expect(signGuestGrants(key, long).length).toBeLessThan(2000);
  });

  it("generates unguessable guest ids", () => {
    const id = newGuestId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newGuestId()).not.toBe(id);
  });
});
