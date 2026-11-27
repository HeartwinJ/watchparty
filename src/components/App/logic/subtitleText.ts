// Subtitle text clean-up: decoding files in legacy encodings and repairing the usual artifacts (mojibake, ASS tags).

/** The characters Windows-1252 gives bytes 0x80–0x9F (the rest of 0x80–0xFF is Latin-1, i.e. the same code point) */
const CP1252_HIGH: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  ƒ: 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  ˆ: 0x88,
  "‰": 0x89,
  Š: 0x8a,
  "‹": 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  š: 0x9a,
  "›": 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** The byte a character had if it came from decoding UTF-8 as Windows-1252/Latin-1, or -1 */
function cp1252Byte(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 0x80 && code <= 0xff) {
    return code;
  }
  return CP1252_HIGH[ch] ?? -1;
}

/** Runs of characters that could all be Windows-1252 bytes ≥ 0x80 (UTF-8's multi-byte sequences are only those) */
const RUN_RE = new RegExp(
  `[\\u0080-\\u00ff${Object.keys(CP1252_HIGH).join("")}]{2,}`,
  "g",
);

/** Length of the UTF-8 sequence starting with `lead`, or 0 if it can't start one */
function sequenceLength(lead: number) {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Re-decodes the valid UTF-8 sequences in one run; anything else is left as it was */
function repairRun(run: string): string {
  const chars = Array.from(run);
  const bytes = chars.map(cp1252Byte);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const len = sequenceLength(bytes[i]);
    if (len && i + len <= chars.length) {
      const seq = bytes.slice(i, i + len);
      if (seq.slice(1).every((b) => b >= 0x80 && b <= 0xbf)) {
        try {
          // Fatal decoding rejects overlong forms and surrogates
          out += utf8Strict.decode(Uint8Array.from(seq));
          i += len;
          continue;
        } catch {
          // not a real sequence, keep the characters
        }
      }
    }
    out += chars[i];
    i++;
  }
  return out;
}

/**
 * Repairs mojibake: UTF-8 text that was read as Windows-1252 somewhere along the way (often by a subtitle site
 * re-encoding a file it misdetected), so `♪` shows as `â™ª`, `’` as `â€™` and `é` as `Ã©`. Applied up to three times
 * for text that went through it twice. Single accented letters (`café`) are never touched, only character pairs/triples
 * that form a valid UTF-8 sequence, which real text practically never contains.
 */
export function fixMojibake(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = current.replace(RUN_RE, repairRun);
    if (next === current) {
      break;
    }
    current = next;
  }
  if (current !== text) {
    // Only in text that had mojibake: the sequences that lost a byte on the way (0x9D is undefined in Windows-1252 and
    // often dropped, a no-break space often becomes a plain one)
    current = current
      .replace(/â€(?![\u0080-\u00ff])/g, "”")
      .replace(/Ã /g, "à");
  }
  return current;
}

/**
 * Cleans subtitle text before it's shown: repairs mojibake and removes ASS/SSA override tags that some SRTs carry
 * (`{\an8}`, `{\i1}`, `{\c&H00FFFF&}`) and would otherwise show as literal text; their `\N` line breaks become real ones
 * and `\h` a no-break space.
 */
export function cleanSubtitleText(text: string): string {
  return fixMojibake(text)
    .replace(/\{\\[^}\n]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\h/g, "\u00a0");
}

/** Share of zero bytes at even/odd positions in the first 4 KB, to spot UTF-16 without a BOM */
function looksUtf16(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) {
    return null;
  }
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  const half = n / 2;
  if (oddZeros > half * 0.3 && evenZeros < half * 0.05) return "utf-16le";
  if (evenZeros > half * 0.3 && oddZeros < half * 0.05) return "utf-16be";
  return null;
}

/**
 * Decodes a subtitle file: UTF-8 (with or without BOM), UTF-16 (BOM, or detected from its zero bytes), and anything
 * that isn't valid UTF-8 as Windows-1252, the usual encoding of older Western-language SRTs (`.text()` would turn their
 * accented letters into `�`). Other legacy code pages (Cyrillic, Greek, …) can't be told apart reliably and also come out
 * as Windows-1252.
 */
export function decodeSubtitleBytes(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  const utf16 = looksUtf16(bytes);
  if (utf16) {
    return new TextDecoder(utf16).decode(bytes);
  }
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
