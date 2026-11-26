import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchYoutubeVideo,
  getVideoDuration,
  getYoutubeVideoID,
  isYouTube,
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

  it("maps missing fields to empty values", async () => {
    mockFetch({ items: [{}] });
    expect(await searchYoutube("x")).toEqual([
      {
        channel: "",
        url: "https://www.youtube.com/watch?v=undefined",
        name: "",
        img: "",
        duration: 0,
        type: "youtube",
      },
    ]);
    expect(await youtubePlaylist("PL")).toMatchObject([
      { name: "", img: "", channel: "", duration: 0 },
    ]);
    mockFetch({ items: [{ id: "v9" }] });
    expect(await fetchYoutubeVideo("v9")).toMatchObject({
      name: "",
      img: "",
      channel: "",
      duration: 0,
    });
    mockFetch({});
    expect(await searchYoutube("x")).toEqual([]);
  });

  it("returns empty lists without an API key", async () => {
    setYoutubeClient({ apiKey: "" });
    expect(await youtubePlaylist("PL")).toEqual([]);
  });

  it("uses the global fetch by default", async () => {
    const real = globalThis.fetch;
    const fn = vi.fn(async () => Response.json({ items: [] }));
    vi.stubGlobal("fetch", fn);
    try {
      // A fresh module instance has the default client
      vi.resetModules();
      const fresh = await import("./youtube.ts");
      fresh.setYoutubeClient({ apiKey: "KEY" });
      expect(await fresh.searchYoutube("x")).toEqual([]);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      expect(globalThis.fetch).toBe(real);
    }
  });

  it("parses hours, minutes and seconds", () => {
    expect(getVideoDuration("PT1H2M3S")).toBe(3723);
    expect(getVideoDuration("PT2H")).toBe(7200);
    expect(getVideoDuration("P0D")).toBe(0);
  });

  it("extracts video ids and recognizes YouTube links", () => {
    expect(
      getYoutubeVideoID("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
    expect(getYoutubeVideoID("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(getYoutubeVideoID("https://example.com/v.mp4")).toBeUndefined();
    expect(isYouTube("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(isYouTube("https://youtu.be/x")).toBe(true);
    expect(isYouTube("https://example.com/youtube")).toBe(false);
  });
});
