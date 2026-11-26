import { describe, expect, it } from "vitest";
import {
  meterLevel,
  rmsDb,
  SPEAKING_DEFAULTS as D,
  SpeakingDetector,
} from "./speaking";

describe("rmsDb", () => {
  it("measures RMS in dBFS", () => {
    expect(rmsDb(new Float32Array(100))).toBe(-100);
    expect(rmsDb([])).toBe(-100);
    expect(rmsDb(new Float32Array(100).fill(1))).toBeCloseTo(0);
    expect(rmsDb(new Float32Array(100).fill(0.1))).toBeCloseTo(-20);
  });
  it("maps to a meter level", () => {
    expect(meterLevel(-100)).toBe(0);
    expect(meterLevel(-35)).toBeCloseTo(0.5);
    expect(meterLevel(0)).toBe(1);
  });
});

describe("SpeakingDetector", () => {
  const loud = D.onDb + 5;
  const between = (D.onDb + D.offDb) / 2;
  const quiet = D.offDb - 5;

  it("needs the level held above the start threshold before speaking", () => {
    const d = new SpeakingDetector();
    expect(d.update(loud, 0)).toBe(false);
    expect(d.update(loud, D.attackMs - 1)).toBe(false);
    expect(d.update(loud, D.attackMs)).toBe(true);
  });

  it("ignores a short click", () => {
    const d = new SpeakingDetector();
    d.update(loud, 0);
    d.update(quiet, 20);
    expect(d.update(loud, D.attackMs + 10)).toBe(false);
  });

  it("keeps speaking between the thresholds and through short pauses", () => {
    const d = new SpeakingDetector();
    d.update(loud, 0);
    d.update(loud, D.attackMs);
    expect(d.update(between, 1000)).toBe(true);
    expect(d.update(quiet, 1100)).toBe(true);
    // A word: the release timer starts over
    expect(d.update(loud, 1300)).toBe(true);
    expect(d.update(quiet, 1400)).toBe(true);
    expect(d.update(quiet, 1400 + D.releaseMs - 1)).toBe(true);
    expect(d.update(quiet, 1400 + D.releaseMs)).toBe(false);
  });

  it("resets", () => {
    const d = new SpeakingDetector();
    d.update(loud, 0);
    d.update(loud, D.attackMs);
    d.reset();
    expect(d.speaking).toBe(false);
  });
});
