import { describe, expect, it } from "vitest";
import {
  continueWatching,
  formatTimeLeft,
  historyProgress,
  type HistoryItem,
} from "./history";

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  id: 1,
  roomId: "/room",
  kind: "aiostreams",
  title: "Show",
  subtitle: null,
  poster: null,
  position: 600,
  duration: 3000,
  updatedAt: 1,
  finished: false,
  group: "g1",
  ...over,
});

describe("continueWatching", () => {
  it("keeps the newest entry per title and drops finished ones", () => {
    const items = [
      item({ id: 1, group: "show", updatedAt: 10, subtitle: "S01E01" }),
      item({ id: 2, group: "show", updatedAt: 30, subtitle: "S01E02" }),
      item({ id: 3, group: "movie", updatedAt: 20 }),
      item({ id: 4, group: "done", updatedAt: 40, finished: true }),
      item({ id: 5, group: "done", updatedAt: 5 }),
    ];
    expect(continueWatching(items).map((i) => i.id)).toEqual([2, 3]);
  });

  it("caps the row", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      item({ id: i + 1, group: "g" + i, updatedAt: i }),
    );
    expect(continueWatching(many, 5)).toHaveLength(5);
  });
});

describe("progress and time left", () => {
  it("formats the remaining time", () => {
    expect(formatTimeLeft(item({ position: 600, duration: 3000 }))).toBe(
      "40 min left",
    );
    expect(formatTimeLeft(item({ position: 0, duration: 5400 }))).toBe(
      "1 h 30 min left",
    );
    expect(formatTimeLeft(item({ position: 0, duration: 7200 }))).toBe(
      "2 h left",
    );
    expect(formatTimeLeft(item({ position: 2990, duration: 3000 }))).toBe(
      "<1 min left",
    );
    expect(formatTimeLeft(item({ position: 754, duration: null }))).toBe(
      "At 12:34",
    );
    expect(formatTimeLeft(item({ position: 3723, duration: null }))).toBe(
      "At 1:02:03",
    );
  });

  it("computes progress", () => {
    expect(historyProgress(item({ position: 750, duration: 3000 }))).toBe(0.25);
    expect(historyProgress(item({ duration: null }))).toBeNull();
    expect(historyProgress(item({ position: 5000, duration: 3000 }))).toBe(1);
  });
});
