/**
 * Subtitles from the keyless OpenSubtitles v3 Stremio addon, by IMDb id.
 * Kitsu ids are mapped to IMDb ids through the Kitsu addon's metadata first.
 * The returned SRT URLs (subs5.strem.io) send `Access-Control-Allow-Origin: *`,
 * so the browser fetches them directly.
 */
import type { TtlCache } from "./cache.ts";
import type { Catalog } from "./catalog.ts";
import { AddonError, fetchJson, type FetchFn } from "./http.ts";
import { parseContentId } from "./ids.ts";

export const OPENSUBTITLES_URL = "https://opensubtitles-v3.strem.io";
export const SUBTITLES_TTL_MS = 60 * 60 * 1000;

export type Subtitle = {
  id: string;
  /** ISO 639-1 where known ("en", "pt-BR"), otherwise the addon's code */
  lang: string;
  /** e.g. "English", "English 2" */
  label: string;
  url: string;
};

// OpenSubtitles uses ISO 639-2 (bibliographic and terminology variants both appear)
const ISO639_2_TO_1: Record<string, string> = {
  eng: "en",
  spa: "es",
  spn: "es",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  ita: "it",
  por: "pt",
  pob: "pt-BR",
  pt_br: "pt-BR",
  rus: "ru",
  jpn: "ja",
  chi: "zh",
  zho: "zh",
  zht: "zh-TW",
  kor: "ko",
  ara: "ar",
  hin: "hi",
  tur: "tr",
  pol: "pl",
  dut: "nl",
  nld: "nl",
  swe: "sv",
  nor: "no",
  nob: "no",
  dan: "da",
  fin: "fi",
  cze: "cs",
  ces: "cs",
  hun: "hu",
  rum: "ro",
  ron: "ro",
  gre: "el",
  ell: "el",
  heb: "he",
  hrv: "hr",
  srp: "sr",
  scc: "sr",
  slv: "sl",
  slo: "sk",
  slk: "sk",
  bul: "bg",
  ukr: "uk",
  est: "et",
  lav: "lv",
  lit: "lt",
  per: "fa",
  fas: "fa",
  mac: "mk",
  mkd: "mk",
  tha: "th",
  vie: "vi",
  ind: "id",
  may: "ms",
  msa: "ms",
  ben: "bn",
  tam: "ta",
  tel: "te",
  cat: "ca",
  baq: "eu",
  eus: "eu",
  glg: "gl",
  ice: "is",
  isl: "is",
  alb: "sq",
  sqi: "sq",
  bos: "bs",
  geo: "ka",
  kat: "ka",
  arm: "hy",
  hye: "hy",
  mal: "ml",
  urd: "ur",
  tgl: "tl",
  fil: "tl",
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

export function normalizeLang(code: string): string {
  const lower = code.trim().toLowerCase();
  return ISO639_2_TO_1[lower] ?? lower;
}

export function languageLabel(lang: string): string {
  try {
    const name = displayNames.of(lang);
    if (name && name.toLowerCase() !== lang.toLowerCase()) {
      return name;
    }
  } catch {
    // Not a valid BCP 47 tag
  }
  return lang;
}

/** Parses "en, es,pt-BR" into ["en", "es", "pt-br"]. */
export function parseLangList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Preferred languages first (in the configured order), then the rest by label. */
export function sortSubtitles(
  subs: Subtitle[],
  preferred: string[],
): Subtitle[] {
  const rank = (s: Subtitle) => {
    const lang = s.lang.toLowerCase();
    const i = preferred.findIndex(
      (p) => lang === p || lang.startsWith(`${p}-`),
    );
    return i === -1 ? preferred.length : i;
  };
  return subs
    .map((s, index) => ({ s, index, rank: rank(s) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.rank === preferred.length
          ? a.s.label.localeCompare(b.s.label)
          : 0) ||
        a.index - b.index,
    )
    .map(({ s }) => s);
}

export function normalizeSubtitles(body: unknown): Subtitle[] {
  const list = (body as { subtitles?: unknown } | null)?.subtitles;
  if (!Array.isArray(list)) {
    throw new AddonError("opensubtitles", "invalid_response");
  }
  const counts = new Map<string, number>();
  const out: Subtitle[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const r = item as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    const rawLang = typeof r.lang === "string" ? r.lang : "";
    if (!/^https?:\/\//i.test(url) || !rawLang || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const lang = normalizeLang(rawLang);
    const base = languageLabel(lang);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.push({
      id:
        typeof r.id === "string" || typeof r.id === "number"
          ? String(r.id)
          : url,
      lang,
      label: n === 1 ? base : `${base} ${n}`,
      url,
    });
  }
  return out;
}

export function createSubtitles(opts: {
  fetchFn: FetchFn;
  cache: TtlCache<unknown>;
  catalog: Catalog;
  preferredLangs: string[];
  timeoutMs?: number;
  baseUrl?: string;
}) {
  const base = opts.baseUrl ?? OPENSUBTITLES_URL;
  const timeoutMs = opts.timeoutMs ?? 10000;

  async function list(id: string): Promise<Subtitle[]> {
    const parsed = parseContentId(id);
    if (!parsed) {
      return [];
    }
    const imdbId =
      parsed.kind === "kitsu" ? await opts.catalog.kitsuToImdb(id) : id;
    if (!imdbId) {
      return [];
    }
    const type = imdbId.includes(":") ? "series" : "movie";
    const subs = (await opts.cache.wrap(
      `subs:${imdbId}`,
      SUBTITLES_TTL_MS,
      async () =>
        normalizeSubtitles(
          await fetchJson(
            opts.fetchFn,
            `${base}/subtitles/${type}/${imdbId}.json`,
            {
              label: "opensubtitles",
              timeoutMs,
            },
          ),
        ),
    )) as Subtitle[];
    return sortSubtitles(subs, opts.preferredLangs);
  }

  return { list };
}
