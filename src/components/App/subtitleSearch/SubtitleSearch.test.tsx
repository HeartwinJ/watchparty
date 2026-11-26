import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverPath } from "../../../utils/api";
import { resetAddonsConfigured } from "../../../api/addons";
import { SubtitleSearch } from "./SubtitleSearch";
import { resetOpenSubtitlesProbe } from "./openSubtitlesStatus";
import { toast } from "../ui/toast";

vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

const HASH = "a".repeat(64);
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
// Fake AIOStreams playback URL: must never show up in the view
const AIO_URL =
  "https://aio.example.com/api/v1/debrid/playback/opaqueSECRET/-/x/Breaking.Bad.S02E04.mkv";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const SHOW = {
  id: "tt0903747",
  type: "series",
  name: "Breaking Bad",
  year: 2008,
  poster: null,
};
const MOVIE = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  year: 1994,
  poster: "https://images.example/s.jpg",
};
const META = {
  id: "tt0903747",
  type: "series",
  name: "Breaking Bad",
  year: 2008,
  genres: [],
  seasons: [
    {
      season: 1,
      episodes: [
        { id: "tt0903747:1:1", season: 1, episode: 1, title: "Pilot" },
        {
          id: "tt0903747:1:2",
          season: 1,
          episode: 2,
          title: "Cat's in the Bag",
        },
      ],
    },
    {
      season: 2,
      episodes: [
        {
          id: "tt0903747:2:3",
          season: 2,
          episode: 3,
          title: "Bit by a Dead Bee",
        },
        { id: "tt0903747:2:4", season: 2, episode: 4, title: "Down" },
      ],
    },
  ],
};
const SUBS = [
  {
    id: "1",
    lang: "en",
    label: "English",
    url: "https://subs.example.com/1.srt",
  },
  {
    id: "2",
    lang: "en",
    label: "English 2",
    url: "https://subs.example.com/2.srt",
  },
  {
    id: "3",
    lang: "es",
    label: "Spanish",
    url: "https://subs.example.com/3.srt",
  },
];

let subtitles: () => Response;
let srt: () => Response;
let searchReply: () => Response | Promise<Response>;
let metaReply: () => Response;
let fileNameSearch = false;
const calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  subtitles = () => json(SUBS);
  srt = () => new Response(SRT);
  searchReply = () => json({ movies: [MOVIE], series: [SHOW], anime: [] });
  metaReply = () => json(META);
  fileNameSearch = false;
  calls.length = 0;
  resetAddonsConfigured();
  resetOpenSubtitlesProbe();
  vi.mocked(toast).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("https://subs.example.com/")) {
        return srt();
      }
      const path = new URL(url).pathname;
      if (path === "/addon/search") {
        return searchReply();
      }
      if (path.startsWith("/addon/meta/series/")) {
        return metaReply();
      }
      if (path.startsWith("/addon/subtitles/")) {
        return subtitles();
      }
      if (path === "/searchSubtitles/status") {
        return json({ configured: fileNameSearch });
      }
      if (path === "/subtitle" && init?.method === "POST") {
        return json({ hash: HASH });
      }
      return json({ error: "not_found" }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSearch(
  over: Partial<Parameters<typeof SubtitleSearch>[0]> = {},
) {
  const props = {
    opened: true,
    onClose: vi.fn(),
    mediaUrl:
      "https://files.example.com/media/Breaking.Bad.S02E04.720p.HDTV.x264-CTU.mkv",
    videoMeta: null,
    setRoomSubtitle: vi.fn(),
    openFileNameSearch: vi.fn(),
    ...over,
  };
  render(
    <MantineProvider env="test">
      <SubtitleSearch {...props} />
    </MantineProvider>,
  );
  return props;
}

describe("SubtitleSearch", () => {
  it("guesses the title from the file name, pre-selects the episode and loads a subtitle for the room", async () => {
    const props = renderSearch();
    const input = screen.getByRole("searchbox", {
      name: "Movie or show title",
    }) as HTMLInputElement;
    expect(input.value).toBe("Breaking Bad");
    fireEvent.click(await screen.findByText("Breaking Bad"));

    // Season 2 is shown and S02E04 is marked as the guessed episode
    const guessed = await screen.findByRole("button", { current: true });
    expect(guessed.textContent).toContain("S02E04");
    expect(guessed.textContent).toContain("Down");
    expect(
      screen.getByRole("button", { name: "Season 2", pressed: true }),
    ).toBeTruthy();
    fireEvent.click(guessed);

    // Grouped by language, in the server's order
    const english = await screen.findByRole("region", { name: "English" });
    expect(within(english).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Spanish" })).toBeTruthy();
    expect(screen.getByText("Breaking Bad · S02E04")).toBeTruthy();
    expect(
      calls.some((c) =>
        c.url.endsWith("/addon/subtitles/series/tt0903747%3A2%3A4"),
      ),
    ).toBe(true);

    fireEvent.click(within(english).getByText("English 2"));
    await waitFor(() =>
      expect(props.setRoomSubtitle).toHaveBeenCalledWith(
        `${serverPath}/subtitle/${HASH}`,
      ),
    );
    // Downloaded without credentials, then shared through POST /subtitle (same as uploads)
    const download = calls.find((c) => c.url === SUBS[1].url)!;
    expect(download.init?.credentials).toBeUndefined();
    const upload = calls.find((c) => c.init?.method === "POST")!;
    expect(upload.url).toBe(`${serverPath}/subtitle`);
    expect(upload.init?.body).toBe(SRT);
    expect(props.onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "English 2 subtitles loaded for everyone",
      expect.objectContaining({ tone: "success" }),
    );
  });

  it("goes straight to an AIOStreams pick's subtitles, and Back searches its title", async () => {
    renderSearch({
      mediaUrl: `${AIO_URL}#wp-name=Breaking%20Bad%20%C2%B7%20S02E04`,
      videoMeta: {
        source: "aiostreams",
        type: "series",
        id: "tt0903747:2:4",
        imdbId: "tt0903747",
        season: 2,
        episode: 4,
        title: "Breaking Bad",
        episodeTitle: "Down",
        poster: null,
        bingeGroup: null,
      },
    });
    expect(await screen.findByRole("region", { name: "English" })).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/addon/search"))).toBe(false);
    expect(document.body.textContent).not.toContain("aio.example.com");
    expect(document.body.textContent).not.toContain("opaqueSECRET");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    expect(input.value).toBe("Breaking Bad");
    expect(await screen.findByText("The Shawshank Redemption")).toBeTruthy();
    expect(document.body.textContent).not.toContain("aio.example.com");
  });

  it("opens a movie's subtitles directly", async () => {
    renderSearch({
      mediaUrl: "https://files.example.com/x/Shawshank.1994.mkv",
    });
    fireEvent.click(await screen.findByText("The Shawshank Redemption"));
    expect(
      await screen.findByText("The Shawshank Redemption (1994)"),
    ).toBeTruthy();
    expect(
      calls.some((c) => c.url.endsWith("/addon/subtitles/movie/tt0111161")),
    ).toBe(true);
  });

  it("shows the empty state", async () => {
    subtitles = () => json([]);
    renderSearch();
    fireEvent.click(await screen.findByText("Breaking Bad"));
    fireEvent.click(await screen.findByRole("button", { current: true }));
    expect(
      await screen.findByText("No subtitles found for this episode."),
    ).toBeTruthy();
  });

  it("shows an error with Try again", async () => {
    subtitles = () => json({ error: "upstream_timeout" }, 502);
    renderSearch();
    fireEvent.click(await screen.findByText("Breaking Bad"));
    fireEvent.click(await screen.findByRole("button", { current: true }));
    expect(
      await screen.findByText("OpenSubtitles took too long to answer"),
    ).toBeTruthy();
    subtitles = () => json(SUBS);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "English" })).toBeTruthy();
  });

  it("toasts when the subtitle can't be downloaded and leaves the room subtitle alone", async () => {
    srt = () => new Response("nope", { status: 500 });
    const props = renderSearch();
    fireEvent.click(await screen.findByText("Breaking Bad"));
    fireEvent.click(await screen.findByRole("button", { current: true }));
    const spanish = await screen.findByRole("region", { name: "Spanish" });
    fireEvent.click(within(spanish).getByRole("button"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Couldn't download the subtitle file. Try another one.",
        expect.objectContaining({ tone: "danger" }),
      ),
    );
    expect(props.setRoomSubtitle).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("starts empty for a share and searches what's typed", async () => {
    renderSearch({ mediaUrl: "fileshare://abc" });
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByText(/Type the name/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "shaw" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("The Shawshank Redemption")).toBeTruthy();
  });

  it("links the OpenSubtitles API search only when the server has a key", async () => {
    const first = renderSearch();
    await screen.findByText("Breaking Bad");
    expect(screen.queryByText(/Search by file name/)).toBeNull();
    expect(first.openFileNameSearch).not.toHaveBeenCalled();
    cleanup();

    resetOpenSubtitlesProbe();
    fileNameSearch = true;
    const props = renderSearch();
    fireEvent.click(await screen.findByText(/Search by file name/));
    expect(props.openFileNameSearch).toHaveBeenCalled();
  });
});

describe("SubtitleSearch edge cases", () => {
  it("explains a failed title search and retries it", async () => {
    searchReply = () => json({ error: "upstream_error" }, 502);
    renderSearch();
    expect(
      await screen.findByText("The title search didn't answer"),
    ).toBeTruthy();
    searchReply = () => json({ movies: [MOVIE], series: [SHOW], anime: [] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Breaking Bad")).toBeTruthy();
  });

  it("shows other errors as they are", async () => {
    searchReply = () => json({ error: "not_found" }, 404);
    renderSearch();
    await screen.findByRole("button", { name: "Try again" });
  });

  it("goes back to the hint when the query is cleared", async () => {
    renderSearch();
    await screen.findByText("Breaking Bad");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " " } });
    expect(await screen.findByText(/Type the name/)).toBeTruthy();
  });

  it("replaces a poster that doesn't load", async () => {
    renderSearch({
      mediaUrl: "https://files.example.com/x/Shawshank.1994.mkv",
    });
    await screen.findByText("The Shawshank Redemption");
    const img = document.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(MOVIE.poster);
    fireEvent.error(img);
    await waitFor(() => expect(document.querySelector("img")).toBeNull());
  });

  it("switches seasons, lists specials last and falls back to the first real season", async () => {
    metaReply = () =>
      json({
        ...META,
        seasons: [
          {
            season: 0,
            episodes: [
              { id: "tt0903747:0:1", season: 0, episode: 1, title: "Minisode" },
            ],
          },
          ...META.seasons,
        ],
      });
    renderSearch({ mediaUrl: "https://files.example.com/x/Breaking.Bad.mkv" });
    fireEvent.click(await screen.findByText("Breaking Bad"));
    expect(
      await screen.findByRole("button", { name: "Season 1", pressed: true }),
    ).toBeTruthy();
    expect(screen.getByText("Pilot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Specials" }));
    expect(await screen.findByText("Minisode")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Season 2" }));
    expect(await screen.findByText("Bit by a Dead Bee")).toBeTruthy();
  });

  it("explains a failed episode list and retries it", async () => {
    metaReply = () => json({ error: "upstream_timeout" }, 504);
    renderSearch();
    fireEvent.click(await screen.findByText("Breaking Bad"));
    expect(
      await screen.findByText("The title search took too long to answer"),
    ).toBeTruthy();
    metaReply = () => json(META);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Down")).toBeTruthy();
  });
});
