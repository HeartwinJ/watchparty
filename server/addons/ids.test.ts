import { describe, expect, it } from "vitest";
import { isContentId, isContentType, parseContentId } from "./ids.ts";

describe("content ids", () => {
  it("accepts the supported types and id shapes", () => {
    expect(isContentType("anime")).toBe(true);
    expect(isContentType("tv")).toBe(false);
    expect(isContentType(1)).toBe(false);
    for (const id of ["tt0111161", "tt0903747:1:2", "kitsu:11", "kitsu:11:5"]) {
      expect(isContentId(id), id).toBe(true);
    }
    for (const id of ["tt", "tt1:1", "kitsu:", "kitsu:1:2:3", "imdb:1", 5]) {
      expect(isContentId(id), String(id)).toBe(false);
    }
  });

  it("parses IMDb and Kitsu ids", () => {
    expect(parseContentId("tt1")).toEqual({
      kind: "imdb",
      base: "tt1",
      season: null,
      episode: null,
    });
    expect(parseContentId("tt1:2:3")).toEqual({
      kind: "imdb",
      base: "tt1",
      season: 2,
      episode: 3,
    });
    expect(parseContentId("kitsu:7")).toEqual({
      kind: "kitsu",
      base: "kitsu:7",
      season: null,
      episode: null,
    });
    expect(parseContentId("kitsu:7:4")).toMatchObject({ episode: 4 });
    expect(parseContentId("nope")).toBeNull();
  });
});
