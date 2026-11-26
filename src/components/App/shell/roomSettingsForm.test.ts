import { describe, expect, it } from "vitest";
import {
  offsetToSend,
  roomPasswordToSend,
  skipIntroChip,
  skipIntroToSend,
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

describe("skipIntroToSend", () => {
  it("rounds and clamps the custom value to 1–600", () => {
    expect(skipIntroToSend(100, 0)).toBe(100);
    expect(skipIntroToSend("75", 0)).toBe(75);
    expect(skipIntroToSend(89.6, 0)).toBe(90);
    expect(skipIntroToSend(0, 30)).toBe(1);
    expect(skipIntroToSend(9999, 0)).toBe(600);
  });

  it("skips empty, invalid and unchanged values", () => {
    expect(skipIntroToSend("", 0)).toBeUndefined();
    expect(skipIntroToSend("abc", 0)).toBeUndefined();
    expect(skipIntroToSend(90, 90)).toBeUndefined();
  });
});

describe("skipIntroChip", () => {
  it("selects the matching preset, else Custom", () => {
    expect(skipIntroChip(0, false)).toBe("0");
    expect(skipIntroChip(90, false)).toBe("90");
    expect(skipIntroChip(100, false)).toBe("custom");
    // The custom input stays open while editing, even on a preset value
    expect(skipIntroChip(90, true)).toBe("custom");
  });
});
