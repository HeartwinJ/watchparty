import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchYoutubeVideo,
  getVideoDuration,
  searchYoutube,
  setYoutubeClient,
  youtubePlaylist,
} from "./youtube.ts";

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(
    async (_url: URL | string) =>
      new Response(JSON.stringify(body), { status }),
  );
  setYoutubeClient({ fetchFn: fn as unknown as typeof fetch, apiKey: "KEY" });
  return fn;
}

const snippet = (title: string) => ({
  title,
  channelTitle: "Chan",
  thumbnails: { default: { url: `https://i.ytimg.com/${title}.jpg` } },
});

describe("youtube client", () => {
  afterEach(() => {
    setYoutubeClient({ apiKey: "" });
  });

  it("returns nothing without an API key", async () => {
    const fn = vi.fn();
    setYoutubeClient({ fetchFn: fn as unknown as typeof fetch, apiKey: "" });
    expect(await searchYoutube("cats")).toEqual([]);
    expect(await fetchYoutubeVideo("abc")).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("maps search results", async () => {
    const fn = mockFetch({
      items: [{ id: { videoId: "vid1" }, snippet: snippet("One") }],
    });
    expect(await searchYoutube("cats & dogs")).toEqual([
      {
        channel: "Chan",
        url: "https://www.youtube.com/watch?v=vid1",
        name: "One",
        img: "https://i.ytimg.com/One.jpg",
        duration: 0,
        type: "youtube",
      },
    ]);
    const url = new URL(String(fn.mock.calls[0][0]));
    expect(url.pathname).toBe("/youtube/v3/search");
    expect(url.searchParams.get("q")).toBe("cats & dogs");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("part")).toBe("snippet");
    expect(url.searchParams.get("key")).toBe("KEY");
  });

  it("maps video details with duration", async () => {
    const fn = mockFetch({
      items: [
        {
          id: "vid2",
          snippet: snippet("Two"),
          contentDetails: { duration: "PT1H2M3S" },
        },
      ],
    });
    expect(await fetchYoutubeVideo("vid2")).toEqual({
      url: "https://www.youtube.com/watch?v=vid2",
      name: "Two",
      img: "https://i.ytimg.com/Two.jpg",
      channel: "Chan",
      duration: 3723,
      type: "youtube",
    });
    const url = new URL(String(fn.mock.calls[0][0]));
    expect(url.pathname).toBe("/youtube/v3/videos");
    expect(url.searchParams.get("id")).toBe("vid2");
    expect(url.searchParams.get("part")).toBe("snippet,contentDetails");
  });

  it("returns null for an unknown video", async () => {
    mockFetch({ items: [] });
    expect(await fetchYoutubeVideo("nope")).toBeNull();
  });

  it("maps playlist items", async () => {
    const fn = mockFetch({
      items: [
        { snippet: { ...snippet("Three"), resourceId: { videoId: "v3" } } },
      ],
    });
    expect(await youtubePlaylist("PL123")).toEqual([
      {
        url: "https://www.youtube.com/watch?v=v3",
        name: "Three",
        img: "https://i.ytimg.com/Three.jpg",
        channel: "Chan",
        duration: 0,
        type: "youtube",
      },
    ]);
    const url = new URL(String(fn.mock.calls[0][0]));
    expect(url.pathname).toBe("/youtube/v3/playlistItems");
    expect(url.searchParams.get("playlistId")).toBe("PL123");
  });

  it("throws on API errors without leaking the key", async () => {
    mockFetch({ error: {} }, 403);
    await expect(searchYoutube("x")).rejects.toThrow(/403/);
    await expect(searchYoutube("x")).rejects.not.toThrow(/KEY/);
  });

  it("parses ISO 8601 durations", () => {
    expect(getVideoDuration("PT4M13S")).toBe(253);
    expect(getVideoDuration("")).toBe(0);
  });
});
