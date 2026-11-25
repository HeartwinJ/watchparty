import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverPath } from "../../../utils/api";
import { useAutoSubtitles } from "./useAutoSubtitles";

const meta: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000002:1:2",
  imdbId: "tt0000002",
  season: 1,
  episode: 2,
  title: "Example Show",
  episodeTitle: null,
  poster: null,
  bingeGroup: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("useAutoSubtitles", () => {
  it("lists the title's subtitles as auto tracks, and clears them without metadata", async () => {
    const fetch = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify([
            {
              id: "9",
              lang: "en",
              label: "English",
              url: "https://subs.example.com/9.srt",
            },
          ]),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const store = { set: vi.fn() };
    const { rerender } = renderHook(({ m }) => useAutoSubtitles(m, store), {
      initialProps: { m: meta as VideoMeta | null },
    });
    await waitFor(() =>
      expect(store.set).toHaveBeenCalledWith({
        subtitleTracks: [
          {
            id: "auto-9",
            label: "English",
            lang: "en",
            url: "https://subs.example.com/9.srt",
            detail: "OpenSubtitles",
            source: "auto",
          },
        ],
      }),
    );
    expect(String(fetch.mock.calls[0][0])).toBe(
      serverPath + "/addon/subtitles/series/tt0000002%3A1%3A2",
    );
    store.set.mockClear();
    rerender({ m: null });
    expect(store.set).toHaveBeenCalledWith({ subtitleTracks: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
