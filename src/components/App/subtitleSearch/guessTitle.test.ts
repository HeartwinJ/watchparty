import { describe, expect, it } from "vitest";
import {
  fileNameFromUrl,
  findGuessedEpisode,
  groupSubtitlesByLanguage,
  guessFromName,
  guessSubtitleSearch,
  subtitleTargetLabel,
  rankTitleResults,
} from "./guessTitle";

describe("guessFromName", () => {
  it.each([
    [
      "Breaking.Bad.S02E04.720p.HDTV.x264-CTU.mkv",
      { query: "Breaking Bad", year: null, season: 2, episode: 4 },
    ],
    [
      "The.Office.US.S05E14.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv",
      { query: "The Office US", year: null, season: 5, episode: 14 },
    ],
    [
      "Severance.2022.S01E03.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv",
      { query: "Severance", year: 2022, season: 1, episode: 3 },
    ],
    [
      "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mp4",
      {
        query: "The Shawshank Redemption",
        year: 1994,
        season: null,
        episode: null,
      },
    ],
    [
      "Uncut.Gems.2019.1080p.WEBRip.x265-RARBG.mkv",
      { query: "Uncut Gems", year: 2019, season: null, episode: null },
    ],
    [
      "2001.A.Space.Odyssey.1968.REMASTERED.2160p.UHD.BluRay.mkv",
      {
        query: "2001 A Space Odyssey",
        year: 1968,
        season: null,
        episode: null,
      },
    ],
    [
      "1917 (2019) [1080p] [YTS.MX].mp4",
      { query: "1917", year: 2019, season: null, episode: null },
    ],
    [
      "Friends 3x12 The One with All the Jealousy.avi",
      { query: "Friends", year: null, season: 3, episode: 12 },
    ],
    [
      "[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv",
      { query: "Sousou no Frieren", year: null, season: null, episode: 5 },
    ],
    [
      "Movie_Name_EXTENDED_1080p.mkv",
      { query: "Movie Name", year: null, season: null, episode: null },
    ],
    [
      "Breaking Bad · S02E04",
      { query: "Breaking Bad", year: null, season: 2, episode: 4 },
    ],
    [
      "Show Name Season 2 Episode 10",
      { query: "Show Name", year: null, season: 2, episode: 10 },
    ],
    [
      "Charlotte's Web",
      { query: "Charlotte's Web", year: null, season: null, episode: null },
    ],
    ["", { query: "", year: null, season: null, episode: null }],
  ])("%s", (name, expected) => {
    expect(guessFromName(name)).toEqual(expected);
  });
});

describe("fileNameFromUrl", () => {
  it("returns the decoded last path segment", () => {
    expect(
      fileNameFromUrl("https://cdn.example.com/a/My%20Movie.2020.mkv?x=1#y"),
    ).toBe("My Movie.2020.mkv");
    expect(fileNameFromUrl("https://cdn.example.com/")).toBe("");
  });
});

const META: VideoMeta = {
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
};

describe("guessSubtitleSearch", () => {
  it("goes straight to the episode's subtitles with AIOStreams metadata", () => {
    expect(
      guessSubtitleSearch(
        "https://aio.example.com/api/v1/debrid/playback/x/file.mkv#wp-name=Breaking%20Bad",
        META,
      ),
    ).toEqual({
      kind: "subtitles",
      type: "series",
      id: "tt0903747:2:4",
      label: "Breaking Bad · S02E04",
      guess: { query: "Breaking Bad", year: null, season: 2, episode: 4 },
    });
  });

  it("prefers the display name over the file name", () => {
    expect(
      guessSubtitleSearch(
        "https://files.example.com/x/abc123.mkv#wp-name=Severance%20%C2%B7%20S01E03",
        null,
      ),
    ).toEqual({
      kind: "search",
      guess: { query: "Severance", year: null, season: 1, episode: 3 },
    });
  });

  it("falls back to the file name", () => {
    const start = guessSubtitleSearch(
      "https://files.example.com/media/The.Bear.S02E06.1080p.WEB.h264-GRP.mkv",
      undefined,
    );
    expect(start).toEqual({
      kind: "search",
      guess: { query: "The Bear", year: null, season: 2, episode: 6 },
    });
  });

  it("starts empty for shares and nothing", () => {
    for (const url of ["fileshare://abc", "screenshare://abc", "", undefined]) {
      expect(guessSubtitleSearch(url, null)).toEqual({
        kind: "search",
        guess: { query: "", year: null, season: null, episode: null },
      });
    }
  });
});

describe("findGuessedEpisode", () => {
  const ep = (season: number, episode: number) => ({ season, episode });
  const seasons = [
    { season: 1, episodes: [ep(1, 1), ep(1, 2)] },
    { season: 2, episodes: [ep(2, 1), ep(2, 2)] },
    { season: 0, episodes: [ep(0, 1)] },
  ];

  it("finds the exact season/episode", () => {
    expect(findGuessedEpisode(seasons, { season: 2, episode: 2 })).toBe(
      seasons[1].episodes[1],
    );
  });

  it("uses the episode number alone (anime) and skips specials", () => {
    expect(findGuessedEpisode(seasons, { season: null, episode: 1 })).toBe(
      seasons[0].episodes[0],
    );
    expect(findGuessedEpisode(seasons, { season: 5, episode: 2 })).toBe(
      seasons[0].episodes[1],
    );
  });

  it("is null without a guess or a match", () => {
    expect(findGuessedEpisode(seasons, { season: 1, episode: null })).toBe(
      null,
    );
    expect(findGuessedEpisode(seasons, { season: 1, episode: 9 })).toBe(null);
  });
});

describe("groupSubtitlesByLanguage", () => {
  it("groups by language in the server's order", () => {
    const subs = [
      { lang: "en", label: "English" },
      { lang: "en", label: "English 2" },
      { lang: "pt-BR", label: "Brazilian Portuguese" },
      { lang: "es", label: "Spanish" },
      { lang: "en", label: "English 3" },
    ];
    const groups = groupSubtitlesByLanguage(subs);
    expect(groups.map((g) => [g.language, g.items.length])).toEqual([
      ["English", 3],
      ["Brazilian Portuguese", 1],
      ["Spanish", 1],
    ]);
  });
});

describe("subtitleTargetLabel", () => {
  it("adds the episode code", () => {
    expect(subtitleTargetLabel("Dark", 1, 2)).toBe("Dark · S01E02");
    expect(subtitleTargetLabel("Up", null, null)).toBe("Up");
  });
});

describe("rankTitleResults", () => {
  const items = [
    { name: "El Camino", year: 2019, kind: "movie" },
    {
      name: "The Bad News Bears in Breaking Training",
      year: 1977,
      kind: "movie",
    },
    { name: "Breaking Bad Wolf", year: 2018, kind: "movie" },
    { name: "Breaking Bad", year: 2008, kind: "series" },
    { name: "Breaking", year: 2022, kind: "movie" },
  ];
  const names = (r: typeof items) => r.map((i) => i.name);

  it("puts the exact series match first for an episode file", () => {
    expect(
      names(
        rankTitleResults(items, "Breaking Bad", { year: null, episode: 2 }),
      )[0],
    ).toBe("Breaking Bad");
  });

  it("puts an exact match first even without an episode, and keeps the rest in order", () => {
    expect(
      names(
        rankTitleResults(items, "breaking bad", { year: null, episode: null }),
      ),
    ).toEqual([
      "Breaking Bad",
      "Breaking Bad Wolf",
      "El Camino",
      "The Bad News Bears in Breaking Training",
      "Breaking",
    ]);
  });

  it("uses the year to pick between same-name titles", () => {
    const remakes = [
      { name: "Dune", year: 1984, kind: "movie" },
      { name: "Dune", year: 2021, kind: "movie" },
    ];
    expect(
      rankTitleResults(remakes, "Dune", { year: 2021, episode: null })[0].year,
    ).toBe(2021);
  });
});
