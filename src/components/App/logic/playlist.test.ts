import { describe, expect, it } from "vitest";
import {
  decideOnVideoEnded,
  getNextFileIndexUrl,
  withDisplayType,
} from "./playlist";

describe("getNextFileIndexUrl", () => {
  it("increments a trailing fileIndex", () => {
    expect(getNextFileIndexUrl("https://h/x?a=1&fileIndex=3")).toBe(
      "https://h/x?a=1&fileIndex=4",
    );
    expect(getNextFileIndexUrl("https://h/x?a=1&fileIndex=9")).toBe(
      "https://h/x?a=1&fileIndex=10",
    );
  });
  it("returns undefined without one", () => {
    expect(getNextFileIndexUrl("https://h/x.mp4")).toBeUndefined();
    expect(getNextFileIndexUrl("https://h/x?fileIndex=1&b=2")).toBeUndefined();
  });
});

describe("decideOnVideoEnded", () => {
  const base = {
    loading: false,
    loop: false,
    playlistLength: 0,
    roomMedia: "https://h/a.mp4",
    endedUrl: "https://h/a.mp4",
  };

  it("ignores ends while loading", () => {
    expect(decideOnVideoEnded({ ...base, loading: true, loop: true })).toEqual({
      type: "ignore",
    });
  });

  it("loops before advancing the playlist", () => {
    expect(
      decideOnVideoEnded({ ...base, loop: true, playlistLength: 2 }),
    ).toEqual({ type: "loop" });
  });

  it("advances the playlist with the URL that ended", () => {
    expect(
      decideOnVideoEnded({ ...base, playlistLength: 1, endedUrl: "u" }),
    ).toEqual({ type: "playlistNext", url: "u" });
  });

  it("plays the next file index", () => {
    expect(
      decideOnVideoEnded({ ...base, roomMedia: "https://h/x?&fileIndex=0" }),
    ).toEqual({ type: "setMedia", url: "https://h/x?&fileIndex=1" });
  });

  it("otherwise just stops", () => {
    expect(decideOnVideoEnded(base)).toEqual({ type: "stop" });
  });
});

describe("withDisplayType", () => {
  it("shows items with thumbnails as YouTube", () => {
    const item = { url: "u", name: "n", duration: 1, type: "file", img: "i" };
    expect(withDisplayType(item).type).toBe("youtube");
    expect(item.type).toBe("file");
    const plain = { url: "u", name: "n", duration: 1, type: "file" };
    expect(withDisplayType(plain)).toBe(plain);
  });
});
