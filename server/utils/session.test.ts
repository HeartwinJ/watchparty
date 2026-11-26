import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_MS,
  checkPassword,
  createRateLimiter,
  parseCookies,
  signSession,
  verifySession,
} from "./session.ts";

describe("session tokens", () => {
  const secret = "test-secret";

  it("verifies a freshly signed token", () => {
    expect(verifySession(secret, signSession(secret))).toBe(true);
  });

  it("expires after the TTL", () => {
    const token = signSession(secret, 1000);
    expect(verifySession(secret, token, 1000 + SESSION_TTL_MS - 1)).toBe(true);
    expect(verifySession(secret, token, 1000 + SESSION_TTL_MS)).toBe(false);
  });

  it("rejects tampered tokens and other secrets", () => {
    const token = signSession(secret, 0);
    const [v, exp, nonce, mac] = token.split(".");
    // Extending the expiry invalidates the signature
    expect(
      verifySession(secret, [v, Number(exp) + 1e12, nonce, mac].join("."), 0),
    ).toBe(false);
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    expect(verifySession(secret, [v, exp, nonce, flipped].join("."), 0)).toBe(
      false,
    );
    expect(verifySession("other-secret", token, 0)).toBe(false);
    expect(verifySession(secret, undefined)).toBe(false);
    expect(verifySession(secret, "")).toBe(false);
    expect(verifySession(secret, "garbage")).toBe(false);
  });
});

describe("checkPassword", () => {
  it("compares passwords", () => {
    expect(checkPassword("hunter2", "hunter2")).toBe(true);
    expect(checkPassword("hunter3", "hunter2")).toBe(false);
    expect(checkPassword("", "hunter2")).toBe(false);
    expect(checkPassword(undefined, "hunter2")).toBe(false);
    expect(checkPassword({ toString: () => "hunter2" }, "hunter2")).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("a=1; wp_session=v1.x.y.z; b=%20c")).toEqual({
      a: "1",
      wp_session: "v1.x.y.z",
      b: " c",
    });
    expect(parseCookies(undefined)).toEqual({});
    // First occurrence wins
    expect(parseCookies("a=1; a=2").a).toBe("1");
  });
});

describe("createRateLimiter", () => {
  it("allows max attempts per window per key", () => {
    const limiter = createRateLimiter({ max: 10, windowMs: 600_000 });
    for (let i = 0; i < 10; i++) {
      expect(limiter.hit("1.2.3.4", 0)).toBe(true);
    }
    expect(limiter.hit("1.2.3.4", 1000)).toBe(false);
    // Other IPs are unaffected
    expect(limiter.hit("5.6.7.8", 1000)).toBe(true);
    // The window resets
    expect(limiter.hit("1.2.3.4", 600_000)).toBe(true);
  });

  it("reports how long until a limited key can retry", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    expect(limiter.hit("k", 0)).toBe(true);
    expect(limiter.retryAfterSec("k", 0)).toBe(0);
    expect(limiter.hit("k", 1000)).toBe(false);
    expect(limiter.retryAfterSec("k", 1000)).toBe(59);
    expect(limiter.retryAfterSec("k", 59_500)).toBe(1);
    expect(limiter.retryAfterSec("k", 60_000)).toBe(0);
    expect(limiter.retryAfterSec("other", 1000)).toBe(0);
  });

  it("blockedSec only reports a wait once all attempts are used up", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    expect(limiter.blockedSec("k", 0)).toBe(0);
    limiter.hit("k", 0);
    expect(limiter.blockedSec("k", 0)).toBe(0);
    limiter.hit("k", 0);
    expect(limiter.blockedSec("k", 1000)).toBe(59);
    expect(limiter.blockedSec("k", 59_999)).toBe(1);
    expect(limiter.blockedSec("k", 60_000)).toBe(0);
  });
});
