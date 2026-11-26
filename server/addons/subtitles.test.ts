// OpenSubtitles v3 addon client (subtitles.ts): language normalization, labels, sorting and the cached list.
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.ts";
import type { Catalog } from "./catalog.ts";
import { AddonError } from "./http.ts";
import {
  OPENSUBTITLES_URL,
  createSubtitles,
  languageLabel,
  normalizeLang,
  normalizeSubtitles,
  parseLangList,
  sortSubtitles,
  type Subtitle,
} from "./subtitles.ts";

describe("languages", () => {
  it("maps ISO 639-2 codes to 639-1 and labels them", () => {
    expect(normalizeLang(" ENG ")).toBe("en");
    expect(normalizeLang("pob")).toBe("pt-BR");
    expect(normalizeLang("xx")).toBe("xx");
    expect(languageLabel("en")).toBe("English");
    // Unknown or invalid tags are shown as is
    expect(languageLabel("qqq")).toBe("qqq");
    expect(languageLabel("not a tag!")).toBe("not a tag!");
  });

  it("parses the configured list", () => {
    expect(parseLangList(" en, es,,PT-BR ")).toEqual(["en", "es", "pt-br"]);
  });
});

describe("normalizeSubtitles", () => {
  it("numbers repeated languages and skips bad or duplicate entries", () => {
    const subs = normalizeSubtitles({
      subtitles: [
        { id: 1, url: "https://s.example.com/1.srt", lang: "eng" },
        { id: "b", url: "https://s.example.com/2.srt", lang: "en" },
        { url: "https://s.example.com/3.srt", lang: "spa" },
        { id: 4, url: "https://s.example.com/1.srt", lang: "eng" },
        { id: 5, url: "javascript:alert(1)", lang: "eng" },
        { id: 6, url: "https://s.example.com/6.srt" },
        { id: {}, url: "https://s.example.com/7.srt", lang: "fre" },
        null,
        "x",
      ],
    });
    expect(subs).toEqual([
      {
        id: "1",
        lang: "en",
        label: "English",
        url: "https://s.example.com/1.srt",
      },
      {
        id: "b",
        lang: "en",
        label: "English 2",
        url: "https://s.example.com/2.srt",
      },
      {
        id: "https://s.example.com/3.srt",
        lang: "es",
        label: "Spanish",
        url: "https://s.example.com/3.srt",
      },
      {
        id: "https://s.example.com/7.srt",
        lang: "fr",
        label: "French",
        url: "https://s.example.com/7.srt",
      },
    ]);
  });

  it("rejects responses without a list", () => {
    expect(() => normalizeSubtitles({})).toThrow(AddonError);
    expect(() => normalizeSubtitles(null)).toThrow(AddonError);
  });
});

describe("sortSubtitles", () => {
  const sub = (lang: string, label: string): Subtitle => ({
    id: label,
    lang,
    label,
    url: "https://s.example.com/" + label,
  });

  it("puts preferred languages first in order, regional variants included, the rest by label", () => {
    const sorted = sortSubtitles(
      [
        sub("fr", "French"),
        sub("en", "English"),
        sub("pt-br", "Portuguese (Brazil)"),
        sub("de", "German"),
        sub("en", "English 2"),
      ],
      ["pt", "en"],
    );
    expect(sorted.map((s) => s.label)).toEqual([
      "Portuguese (Brazil)",
      "English",
      "English 2",
      "French",
      "German",
    ]);
  });
});

describe("createSubtitles", () => {
  function setup(kitsu: string | null = "tt9:1:2") {
    const fetchFn = vi.fn(async () =>
      Response.json({
        subtitles: [
          { id: 1, url: "https://s.example.com/de.srt", lang: "ger" },
          { id: 2, url: "https://s.example.com/en.srt", lang: "eng" },
        ],
      }),
    );
    const catalog = {
      kitsuToImdb: vi.fn(async () => kitsu),
    } as unknown as Catalog;
    const subtitles = createSubtitles({
      fetchFn: fetchFn as unknown as typeof fetch,
      cache: new TtlCache({ maxEntries: 10 }),
      catalog,
      preferredLangs: ["en"],
    });
    return { subtitles, fetchFn, catalog };
  }

  it("lists movie and episode subtitles, preferred first, cached", async () => {
    const { subtitles, fetchFn } = setup();
    const list = await subtitles.list("tt1");
    expect(list.map((s) => s.lang)).toEqual(["en", "de"]);
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      `${OPENSUBTITLES_URL}/subtitles/movie/tt1.json`,
    );
    await subtitles.list("tt2:1:3");
    expect(String(fetchFn.mock.calls[1][0])).toBe(
      `${OPENSUBTITLES_URL}/subtitles/series/tt2:1:3.json`,
    );
    await subtitles.list("tt1");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("maps Kitsu ids to IMDb, or gives nothing", async () => {
    const mapped = setup();
    await mapped.subtitles.list("kitsu:5:2");
    expect(String(mapped.fetchFn.mock.calls[0][0])).toContain(
      "/series/tt9:1:2.json",
    );

    const unmapped = setup(null);
    expect(await unmapped.subtitles.list("kitsu:5:2")).toEqual([]);
    expect(unmapped.fetchFn).not.toHaveBeenCalled();
    expect(await unmapped.subtitles.list("bad id")).toEqual([]);
  });
});
