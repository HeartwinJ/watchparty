import { describe, expect, it } from "vitest";
import {
  MAX_REVOKED_GUESTS,
  RoomAccess,
  normalizeRoomPassword,
  parseRoomPasswordCommand,
} from "./roomAccess.ts";
import { makeRoomPassword } from "./utils/moniker.ts";

const fixed = (pw: string) => () => pw;
const grant = (epoch: number, guestId = "guest-abc-123") => ({
  roomId: "/r",
  epoch,
  guestId,
  expiresAt: Date.now() + 1000,
});

describe("makeRoomPassword", () => {
  it("is readable: two words and two digits", () => {
    for (let i = 0; i < 50; i++) {
      expect(makeRoomPassword()).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    }
    const many = new Set(Array.from({ length: 50 }, makeRoomPassword));
    expect(many.size).toBeGreaterThan(45);
  });
});

describe("normalizeRoomPassword", () => {
  it("trims and accepts 4–64 characters", () => {
    expect(normalizeRoomPassword("  movie night  ")).toBe("movie night");
    expect(normalizeRoomPassword("abcd")).toBe("abcd");
    expect(normalizeRoomPassword("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeRoomPassword("🍿🍿🍿🍿")).toBe("🍿🍿🍿🍿");
  });

  it("rejects too short/long, control characters and non-strings", () => {
    expect(normalizeRoomPassword("abc")).toBeUndefined();
    expect(normalizeRoomPassword("   ab   ")).toBeUndefined();
    expect(normalizeRoomPassword("a".repeat(65))).toBeUndefined();
    expect(normalizeRoomPassword("ab\ncd")).toBeUndefined();
    expect(normalizeRoomPassword("ab\u202Ecd")).toBeUndefined();
    expect(normalizeRoomPassword(1234)).toBeUndefined();
    expect(normalizeRoomPassword(null)).toBeUndefined();
  });
});

describe("parseRoomPasswordCommand", () => {
  it("accepts the three actions", () => {
    expect(parseRoomPasswordCommand({ action: "regenerate" })).toEqual({
      action: "regenerate",
    });
    expect(
      parseRoomPasswordCommand({ action: "set", password: " popcorn " }),
    ).toEqual({ action: "set", password: "popcorn" });
    expect(
      parseRoomPasswordCommand({ action: "enable", enabled: false }),
    ).toEqual({ action: "enable", enabled: false });
  });

  it("rejects anything else", () => {
    for (const raw of [
      null,
      "regenerate",
      [],
      {},
      { action: "set", password: "ab" },
      { action: "set" },
      { action: "enable", enabled: "yes" },
      { action: "delete" },
    ]) {
      expect(parseRoomPasswordCommand(raw)).toBeUndefined();
    }
  });
});

describe("RoomAccess", () => {
  it("new rooms get a generated password that's required", () => {
    const access = RoomAccess.create(fixed("otter-maple-42"));
    expect(access.serialize()).toEqual({
      password: "otter-maple-42",
      enabled: true,
      epoch: 0,
      revoked: [],
    });
  });

  it("old rooms without access data get a generated password (not open)", () => {
    for (const raw of [undefined, null, {}, { enabled: false }, "x"]) {
      const access = RoomAccess.from(raw, fixed("new-pass-01"));
      expect(access.password).toBe("new-pass-01");
      expect(access.enabled).toBe(true);
    }
  });

  it("restores stored data", () => {
    const access = RoomAccess.from({
      password: "popcorn",
      enabled: false,
      epoch: 4,
      revoked: ["a", 5, "b"],
    });
    expect(access.serialize()).toEqual({
      password: "popcorn",
      enabled: false,
      epoch: 4,
      revoked: ["a", "b"],
    });
    expect(RoomAccess.from({ password: "popcorn", epoch: -2 }).epoch).toBe(0);
  });

  it("checks the password (any input while it's off)", () => {
    const access = RoomAccess.create(fixed("popcorn"));
    expect(access.checkPassword("popcorn")).toBe(true);
    expect(access.checkPassword("Popcorn")).toBe(false);
    expect(access.checkPassword(undefined)).toBe(false);
    access.apply({ action: "enable", enabled: false });
    expect(access.checkPassword(undefined)).toBe(true);
  });

  it("validates grants by epoch and revocation", () => {
    const access = RoomAccess.create(fixed("popcorn"));
    expect(access.isGrantValid(grant(0))).toBe(true);
    expect(access.isGrantValid(grant(1))).toBe(false);
    access.revoke("guest-abc-123");
    expect(access.isGrantValid(grant(0))).toBe(false);
    expect(access.isGrantValid(grant(0, "someone-else-1"))).toBe(true);
  });

  it("a new password or turning it on bumps the epoch and clears revocations; turning it off doesn't", () => {
    const access = RoomAccess.create(fixed("popcorn"));
    access.revoke("kicked-guest-1");
    expect(
      access.apply({ action: "set", password: "popcorn" }),
    ).toBeUndefined();
    expect(access.apply({ action: "set", password: "nachos" })).toBe("changed");
    expect(access.epoch).toBe(1);
    expect(access.isRevoked("kicked-guest-1")).toBe(false);

    expect(access.apply({ action: "enable", enabled: true })).toBeUndefined();
    expect(access.apply({ action: "enable", enabled: false })).toBe("off");
    expect(access.epoch).toBe(1);
    expect(access.apply({ action: "enable", enabled: false })).toBeUndefined();
    expect(access.apply({ action: "enable", enabled: true })).toBe("on");
    expect(access.epoch).toBe(2);

    expect(access.apply({ action: "regenerate" }, fixed("fresh-pass-07"))).toBe(
      "changed",
    );
    expect(access.password).toBe("fresh-pass-07");
    expect(access.epoch).toBe(3);

    // Setting a password while it's off turns it on
    access.apply({ action: "enable", enabled: false });
    expect(access.apply({ action: "set", password: "fresh-pass-07" })).toBe(
      "on",
    );
    expect(access.enabled).toBe(true);
    expect(access.epoch).toBe(4);
  });

  it("keeps the revoked list bounded", () => {
    const access = RoomAccess.create(fixed("popcorn"));
    for (let i = 0; i < MAX_REVOKED_GUESTS + 10; i++) {
      access.revoke(`guest-${i}`);
    }
    access.revoke("guest-20");
    expect(access.serialize().revoked).toHaveLength(MAX_REVOKED_GUESTS);
    expect(access.isRevoked("guest-0")).toBe(false);
    expect(access.isRevoked(`guest-${MAX_REVOKED_GUESTS + 9}`)).toBe(true);
  });
});
