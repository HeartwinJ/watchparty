import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverPath } from "./api";
import {
  continueWatching,
  deleteHistoryItem,
  fetchHistory,
  resumeHistoryItem,
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

describe("history API", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the history with a limit", async () => {
    fetchMock.mockResolvedValueOnce(json([item({ id: 7 })]));
    const ctrl = new AbortController();
    const items = await fetchHistory(20, ctrl.signal);
    expect(items.map((i) => i.id)).toEqual([7]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${serverPath}/history?limit=20`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      signal: ctrl.signal,
      credentials: "include",
    });
  });

  it("treats a non-array body as empty and throws on errors", async () => {
    fetchMock.mockResolvedValueOnce(json({ nope: true }));
    await expect(fetchHistory()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${serverPath}/history?limit=50`);
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await expect(fetchHistory()).rejects.toThrow("history 500");
  });

  it("deletes an entry; an already deleted one is fine", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteHistoryItem(3);
    expect(fetchMock.mock.calls[0]).toEqual([
      `${serverPath}/history/3`,
      expect.objectContaining({ method: "DELETE" }),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(deleteHistoryItem(3)).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(deleteHistoryItem(3)).rejects.toThrow("history delete 403");
  });

  it("resumes in a new room and goes there", async () => {
    window.history.replaceState(null, "", "/");
    fetchMock.mockResolvedValueOnce(json({ roomId: "calm-otter" }));
    await expect(resumeHistoryItem(5)).resolves.toBe("calm-otter");
    expect(fetchMock.mock.calls[0]).toEqual([
      `${serverPath}/history/5/resume`,
      expect.objectContaining({ method: "POST" }),
    ]);
    expect(window.location.pathname).toBe("/watch/calm-otter");
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(resumeHistoryItem(5)).rejects.toThrow("history resume 404");
  });
});
