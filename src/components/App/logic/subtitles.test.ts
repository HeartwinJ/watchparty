import { describe, expect, it } from "vitest";
import {
  describeOffset,
  effectiveOffset,
  formatOffset,
  normalizeOffset,
  parseOffsetInput,
  retimeCues,
  stepOffset,
  toWebVtt,
  type CueLike,
  cuesAt,
} from "./subtitles";

describe("toWebVtt", () => {
  it("converts SRT timestamps and adds the header", () => {
    const srt =
      "﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n\r\n2\r\n01:02:03,04 --> 01:02:04,5\r\n<i>Bye</i>\r\n";
    expect(toWebVtt(srt)).toBe(
      "WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nHello\n\n2\n01:02:03.04 --> 01:02:04.5\n<i>Bye</i>\n",
    );
  });

  it("passes WebVTT through and leaves commas in cue text alone", () => {
    const vtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nHi, there\n";
    expect(toWebVtt(vtt)).toBe(vtt);
    expect(
      toWebVtt("1\n00:00:00,000 --> 00:00:01,000\nHi, 00:00:02,000\n"),
    ).toContain("Hi, 00:00:02,000");
  });
});

describe("offset math", () => {
  it("steps by 0.1 without float drift", () => {
    let v = 0;
    for (let i = 0; i < 10; i++) {
      v = stepOffset(v, 0.1);
    }
    expect(v).toBe(1);
    for (let i = 0; i < 13; i++) {
      v = stepOffset(v, -0.1);
    }
    expect(v).toBe(-0.3);
  });

  it("allows large offsets (only a ±24 h sanity bound) and normalizes junk", () => {
    expect(stepOffset(29.95, 0.1)).toBe(30.05);
    expect(normalizeOffset(-100)).toBe(-100);
    expect(normalizeOffset(1e9)).toBe(86400);
    expect(normalizeOffset(NaN)).toBe(0);
    expect(Object.is(normalizeOffset(-0.001), -0)).toBe(false);
  });

  it("formats with sign and a hint", () => {
    expect(formatOffset(0.3)).toBe("+0.3 s");
    expect(formatOffset(-1.25)).toBe("−1.25 s");
    expect(formatOffset(0)).toBe("0.0 s");
    expect(formatOffset(2)).toBe("+2.0 s");
    expect(describeOffset(1)).toMatch(/later/);
    expect(describeOffset(-1)).toMatch(/earlier/);
  });

  it("lets a local override win over the room value", () => {
    expect(effectiveOffset(0.5, null)).toBe(0.5);
    expect(effectiveOffset(0.5, -1)).toBe(-1);
    expect(effectiveOffset(0.5, 0)).toBe(0);
  });
});

describe("retimeCues", () => {
  const make = (): CueLike[] => [
    { startTime: 1, endTime: 2 },
    { startTime: 5, endTime: 7.5 },
  ];

  it("shifts cues from their original times, without accumulating", () => {
    const cues = make();
    const originals = new WeakMap<CueLike, { start: number; end: number }>();
    expect(retimeCues(cues, 0.3, originals)).toBe(2);
    expect(cues[0]).toEqual({ startTime: 1.3, endTime: 2.3 });
    retimeCues(cues, 0.3, originals);
    retimeCues(cues, 0.5, originals);
    expect(cues[1].startTime).toBeCloseTo(5.5);
    expect(cues[1].endTime).toBeCloseTo(8);
    retimeCues(cues, 0, originals);
    expect(cues).toEqual(make());
  });

  it("clamps negative times at 0", () => {
    const cues = make();
    const originals = new WeakMap<CueLike, { start: number; end: number }>();
    retimeCues(cues, -1.5, originals);
    expect(cues[0]).toEqual({ startTime: 0, endTime: 0.5 });
    retimeCues(cues, -3, originals);
    expect(cues[0]).toEqual({ startTime: 0, endTime: 0 });
    // Original timing is still recoverable
    retimeCues(cues, 0, originals);
    expect(cues[0]).toEqual({ startTime: 1, endTime: 2 });
  });

  it("picks up cues added later (track still loading)", () => {
    const cues = make();
    const originals = new WeakMap<CueLike, { start: number; end: number }>();
    retimeCues(cues.slice(0, 1), 1, originals);
    retimeCues(cues, 1, originals);
    expect(cues.map((c) => c.startTime)).toEqual([2, 6]);
  });
});

describe("parseOffsetInput", () => {
  it("reads seconds, signs, units and minutes:seconds", () => {
    expect(parseOffsetInput("2.5")).toBe(2.5);
    expect(parseOffsetInput("+2.5")).toBe(2.5);
    expect(parseOffsetInput(" -1.25 s ")).toBe(-1.25);
    expect(parseOffsetInput("\u22123")).toBe(-3);
    expect(parseOffsetInput("45 sec")).toBe(45);
    expect(parseOffsetInput("1:30")).toBe(90);
    expect(parseOffsetInput("-1:05.5")).toBe(-65.5);
    expect(parseOffsetInput("0,4")).toBe(0.4);
    expect(parseOffsetInput(".5")).toBe(0.5);
    expect(parseOffsetInput("0")).toBe(0);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "abc", "1:75", "1..2", "--1", "1:2:3", "1e3"]) {
      expect(parseOffsetInput(bad)).toBeUndefined();
    }
  });
});

describe("cuesAt", () => {
  const cues = [
    { startTime: 1, endTime: 2, text: "a" },
    { startTime: 1.5, endTime: 3, text: "b" },
    { startTime: 4, endTime: 5, text: "c" },
  ];
  it("returns the cues on screen at a time, in order (start inclusive, end exclusive)", () => {
    expect(cuesAt(cues, 0.5)).toEqual([]);
    expect(cuesAt(cues, 1).map((c) => c.text)).toEqual(["a"]);
    expect(cuesAt(cues, 1.7).map((c) => c.text)).toEqual(["a", "b"]);
    expect(cuesAt(cues, 2).map((c) => c.text)).toEqual(["b"]);
    expect(cuesAt(cues, 4.99).map((c) => c.text)).toEqual(["c"]);
    expect(cuesAt(cues, 5)).toEqual([]);
  });
  it("handles no cues and bad times", () => {
    expect(cuesAt(null, 1)).toEqual([]);
    expect(cuesAt(cues, NaN)).toEqual([]);
  });
});
