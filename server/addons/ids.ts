/** Validation for Stremio content types and ids taken from request params. */

export const CONTENT_TYPES = ["movie", "series", "anime"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export function isContentType(v: unknown): v is ContentType {
  return (
    typeof v === "string" && (CONTENT_TYPES as readonly string[]).includes(v)
  );
}

// tt0111161, tt0903747:1:2, kitsu:11, kitsu:11:5
const IMDB_ID = /^tt\d{1,10}(?::\d{1,4}:\d{1,5})?$/;
const KITSU_ID = /^kitsu:\d{1,10}(?::\d{1,5})?$/;

export function isContentId(v: unknown): v is string {
  return typeof v === "string" && (IMDB_ID.test(v) || KITSU_ID.test(v));
}

export type ParsedId =
  | {
      kind: "imdb";
      base: string;
      season: number | null;
      episode: number | null;
    }
  | { kind: "kitsu"; base: string; season: null; episode: number | null };

export function parseContentId(id: string): ParsedId | null {
  if (IMDB_ID.test(id)) {
    const [base, s, e] = id.split(":");
    return s === undefined
      ? { kind: "imdb", base, season: null, episode: null }
      : { kind: "imdb", base, season: Number(s), episode: Number(e) };
  }
  if (KITSU_ID.test(id)) {
    const [, num, e] = id.split(":");
    return {
      kind: "kitsu",
      base: `kitsu:${num}`,
      season: null,
      episode: e === undefined ? null : Number(e),
    };
  }
  return null;
}
