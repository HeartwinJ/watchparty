import { describe, expect, it } from "vitest";
import { YOUTUBE_VIDEO_ID_REGEX } from "./regex.ts";

describe("YOUTUBE_VIDEO_ID_REGEX", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("extracts the id from %s", (url, id) => {
    expect(YOUTUBE_VIDEO_ID_REGEX.exec(url)?.[1]).toBe(id);
  });

  it("does not match non-YouTube URLs", () => {
    expect(YOUTUBE_VIDEO_ID_REGEX.exec("https://example.com/v.mp4")).toBeNull();
  });
});
