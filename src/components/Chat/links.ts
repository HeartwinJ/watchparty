// Finds links in chat text. Replaces react-linkify (unmaintained, and its linkify-it dependency has ReDoS advisories).

export type TextPart =
  { type: "text"; text: string } | { type: "link"; text: string; href: string };

// http(s) URLs, or www. hosts, up to the next whitespace
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;
// Punctuation that usually ends a sentence rather than the URL
const TRAILING_RE = /[.,;:!?'"]+$/;

/** Splits text into plain parts and links (linear time). */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    let url = match[0];
    const trailing = TRAILING_RE.exec(url);
    if (trailing) {
      url = url.slice(0, -trailing[0].length);
    }
    // Drop an unbalanced closing parenthesis, e.g. "(see https://example.com)"
    if (url.endsWith(")") && !url.includes("(")) {
      url = url.slice(0, -1);
    }
    const start = match.index;
    if (start > last) {
      parts.push({ type: "text", text: text.slice(last, start) });
    }
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    parts.push({ type: "link", text: url, href });
    last = start + url.length;
  }
  if (last < text.length) {
    parts.push({ type: "text", text: text.slice(last) });
  }
  return parts;
}
