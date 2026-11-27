import { describe, expect, it } from "vitest";
import type { SubtitleTrackOption } from "../roomState";
import {
  captureCarry,
  pickCarry,
  sameShow,
  showId,
  trackLanguage,
  type CarryTrack,
  type SubtitleCarry,
} from "./subtitleCarry";

const meta = (id: string, extra: Partial<VideoMeta> = {}): VideoMeta => ({
  source: "aiostreams",
  type: "series",
  id,
  imdbId: null,
  season: 1,
  episode: 1,
  title: "Show",
  episodeTitle: null,
  poster: null,
  bingeGroup: null,
  ...extra,
});

const auto = (lang: string, url: string, label = ""): SubtitleTrackOption => ({
  id: url,
  label: label || lang,
  lang,
  url,
  source: "auto",
});

const room: CarryTrack = {
  index: 0,
  label: "English",
  language: "en",
  fromRoom: true,
};
const german: CarryTrack = {
  index: 1,
  label: "Deutsch",
  language: "ger",
  fromRoom: false,
};
const english: CarryTrack = {
  index: 2,
  label: "English [SDH]",
  language: "",
  fromRoom: false,
};

describe("trackLanguage", () => {
  it("names a language from its code or label", () => {
    expect(trackLanguage("en")).toBe("English");
    expect(trackLanguage("eng")).toBe("English");
    expect(trackLanguage("", "English 2")).toBe("English");
    expect(trackLanguage(undefined, "English [SDH]")).toBe("English");
    expect(trackLanguage("")).toBeNull();
  });
});

describe("captureCarry", () => {
  const base = {
    tracks: [room, german],
    roomSubtitle: "",
    autoTracks: undefined,
    meta: null,
    now: 5,
  };

  it("nothing when subtitles were off and there was no room subtitle", () => {
    expect(captureCarry({ ...base, selected: -1 })).toBeNull();
  });

  it("off when this device hid the room subtitle", () => {
    expect(
      captureCarry({ ...base, selected: -1, roomSubtitle: "/s/a" }),
    ).toEqual({ on: false, prevMeta: null, at: 5 });
  });

  it("the room subtitle's language from the auto track it came from", () => {
    const m = meta("tt1:1:1");
    expect(
      captureCarry({
        ...base,
        selected: 0,
        roomSubtitle: "https://subs/pt",
        autoTracks: [auto("pt-BR", "https://subs/pt")],
        meta: m,
      }),
    ).toEqual({
      on: true,
      kind: "room",
      lang: "Brazilian Portuguese",
      prevMeta: m,
      at: 5,
    });
    // An uploaded or searched subtitle: language unknown
    expect(
      captureCarry({ ...base, selected: 0, roomSubtitle: "/subtitle/x" }),
    ).toMatchObject({ on: true, kind: "room", lang: null });
  });

  it("an embedded track with its language", () => {
    expect(captureCarry({ ...base, selected: 1 })).toMatchObject({
      on: true,
      kind: "embedded",
      lang: "German",
    });
  });
});

describe("sameShow", () => {
  it("matches episodes of one series", () => {
    expect(showId(meta("tt1:1:2"))).toBe("tt1");
    expect(showId(meta("kitsu:45:6"))).toBe("kitsu:45");
    expect(sameShow(meta("tt1:1:2"), meta("tt1:1:3"))).toBe(true);
    expect(sameShow(meta("kitsu:45:6"), meta("kitsu:45:7"))).toBe(true);
    expect(sameShow(meta("kitsu:45:6"), meta("kitsu:46:1"))).toBe(false);
    expect(
      sameShow(
        meta("kitsu:45:12", { imdbId: "tt9" }),
        meta("tt9:2:1", { imdbId: "tt9" }),
      ),
    ).toBe(true);
    expect(sameShow(meta("tt1:1:2"), meta("tt2:1:1"))).toBe(false);
  });

  it("movies and mixed metadata never match; two plain links do", () => {
    expect(sameShow(meta("tt1", { type: "movie" }), meta("tt1"))).toBe(false);
    expect(sameShow(meta("tt1:1:1"), null)).toBe(false);
    expect(sameShow(null, meta("tt1:1:1"))).toBe(false);
    expect(sameShow(null, null)).toBe(true);
  });
});

describe("pickCarry", () => {
  const on = (
    kind: "room" | "embedded",
    lang: string | null,
  ): SubtitleCarry => ({ on: true, kind, lang, prevMeta: null, at: 0 });
  const base = {
    selected: -1,
    tracks: [] as CarryTrack[],
    roomSubtitle: "",
    autoTracks: undefined as SubtitleTrackOption[] | undefined,
    mediaReady: false,
  };

  it("room: waits for the auto subtitles, then picks the same language", () => {
    const c = on("room", "German");
    expect(pickCarry(c, base)).toBeNull();
    expect(
      pickCarry(c, {
        ...base,
        autoTracks: [auto("en", "u/en"), auto("de", "u/de")],
      }),
    ).toEqual({ action: "room", url: "u/de" });
    // Unknown language: the first (preferred) one
    expect(
      pickCarry(on("room", null), {
        ...base,
        autoTracks: [auto("en", "u/en"), auto("de", "u/de")],
      }),
    ).toEqual({ action: "room", url: "u/en" });
  });

  it("room: someone else already picked one, so nothing to do", () => {
    expect(
      pickCarry(on("room", "English"), {
        ...base,
        roomSubtitle: "u/other",
        autoTracks: [auto("en", "u/en")],
        tracks: [english],
      }),
    ).toBeNull();
  });

  it("room: falls back to an embedded track in the language", () => {
    expect(
      pickCarry(on("room", "English"), {
        ...base,
        autoTracks: [auto("de", "u/de")],
        tracks: [german, english],
      }),
    ).toEqual({ action: "track", index: 2 });
    expect(
      pickCarry(on("room", "English"), { ...base, autoTracks: [] }),
    ).toBeNull();
  });

  it("embedded: the file's track first, the auto subtitle once the media is in", () => {
    const c = on("embedded", "German");
    const autoTracks = [auto("de", "u/de")];
    expect(pickCarry(c, { ...base, tracks: [german], autoTracks })).toEqual({
      action: "track",
      index: 1,
    });
    expect(pickCarry(c, { ...base, autoTracks })).toBeNull();
    expect(pickCarry(c, { ...base, autoTracks, mediaReady: true })).toEqual({
      action: "room",
      url: "u/de",
    });
  });

  it("off: hides the room subtitle once it shows", () => {
    const c: SubtitleCarry = { on: false, prevMeta: null, at: 0 };
    expect(pickCarry(c, base)).toBeNull();
    expect(pickCarry(c, { ...base, tracks: [room, german] })).toBeNull();
    expect(
      pickCarry(c, { ...base, tracks: [room, german], selected: 1 }),
    ).toBeNull();
    expect(pickCarry(c, { ...base, tracks: [room], selected: 0 })).toEqual({
      action: "off",
    });
  });
});
