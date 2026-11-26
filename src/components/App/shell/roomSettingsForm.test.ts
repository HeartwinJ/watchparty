import { describe, expect, it } from "vitest";
import {
  offsetToSend,
  roomPasswordToSend,
  titleToSend,
} from "./roomSettingsForm";

describe("titleToSend", () => {
  it("normalizes the draft and skips unchanged titles", () => {
    expect(titleToSend("  Friday   movies ", "")).toBe("Friday movies");
    expect(titleToSend("Friday movies", "Friday movies")).toBeUndefined();
    expect(titleToSend("   ", "Old")).toBe("");
    expect(titleToSend("", "")).toBeUndefined();
    expect(titleToSend("x".repeat(80), "")).toBe("x".repeat(60));
  });
});

describe("offsetToSend", () => {
  it("clamps, rounds and skips unchanged or invalid values", () => {
    expect(offsetToSend(30, 25)).toBe(30);
    expect(offsetToSend("45", 25)).toBe(45);
    expect(offsetToSend(2, 25)).toBe(5);
    expect(offsetToSend(500, 25)).toBe(120);
    expect(offsetToSend(25.4, 25)).toBeUndefined();
    expect(offsetToSend("", 25)).toBeUndefined();
    expect(offsetToSend("abc", 25)).toBeUndefined();
  });
});

describe("roomPasswordToSend", () => {
  it("trims and enforces 4–64 characters", () => {
    expect(roomPasswordToSend("  popcorn ")).toBe("popcorn");
    expect(roomPasswordToSend("abc")).toBeUndefined();
    expect(roomPasswordToSend("    ")).toBeUndefined();
    expect(roomPasswordToSend("x".repeat(64))).toBe("x".repeat(64));
    expect(roomPasswordToSend("x".repeat(65))).toBeUndefined();
    expect(roomPasswordToSend("ab\tcd")).toBeUndefined();
  });
});
