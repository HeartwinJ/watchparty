import { describe, expect, it } from "vitest";
import {
  cleanSubtitleText,
  decodeSubtitleBytes,
  fixMojibake,
} from "./subtitleText";

/** What a UTF-8 string looks like after being read as Windows-1252 */
const garble = (s: string) =>
  new TextDecoder("windows-1252").decode(new TextEncoder().encode(s));

describe("fixMojibake", () => {
  it("repairs the music note from the screenshot", () => {
    expect(fixMojibake("â™ªThough this world is bitterly coldâ™ª")).toBe(
      "♪Though this world is bitterly cold♪",
    );
  });

  it.each([
    "It’s “quoted” — and… done",
    "Café, naïve, Straße, São Paulo, Ærø",
    "Ça va? ¿Qué? ¡Sí!",
    "Привет, мир",
    "日本語のテキスト 🎵",
    "€5 • 100°",
  ])("round-trips %s", (text) => {
    expect(fixMojibake(garble(text))).toBe(text);
  });

  it("repairs text garbled twice", () => {
    expect(fixMojibake(garble(garble("It’s ♪ café")))).toBe("It’s ♪ café");
  });

  it("leaves correct text alone", () => {
    for (const text of [
      "Plain ASCII, nothing to do.",
      "café, über, señor, Zoë, à bientôt",
      "IRMÃ e SÃO",
      "50 °C ± 2 · ½ ©",
      "“Quotes” ‘and’ dashes — –",
    ]) {
      expect(fixMojibake(text)).toBe(text);
    }
  });

  it("fixes sequences that lost a byte, but only in garbled text", () => {
    // ” is E2 80 9D and 0x9D is often dropped; à's no-break space often becomes a plain space
    expect(fixMojibake("â€œHiâ€ she said. Ã  bientÃ´t")).toBe(
      "“Hi” she said. à bientôt",
    );
    expect(fixMojibake("IRMÃ e SÃO")).toBe("IRMÃ e SÃO");
  });
});

describe("cleanSubtitleText", () => {
  it("strips ASS override tags and converts ASS line breaks", () => {
    expect(
      cleanSubtitleText("{\\an8}Top line\\Nsecond {\\i1}it{\\i0}\\hend"),
    ).toBe("Top line\nsecond it end");
  });

  it("keeps ordinary braces and HTML tags", () => {
    expect(cleanSubtitleText("<i>{laughs}</i> ♪")).toBe("<i>{laughs}</i> ♪");
  });
});

describe("decodeSubtitleBytes", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nCafé ♪\n";

  it("decodes UTF-8 with and without a BOM", () => {
    const utf8 = new TextEncoder().encode(text);
    expect(decodeSubtitleBytes(utf8)).toBe(text);
    expect(
      decodeSubtitleBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])),
    ).toBe(text);
    expect(decodeSubtitleBytes(utf8.buffer)).toBe(text);
  });

  it("decodes UTF-16 with a BOM or detected from its zero bytes", () => {
    const le = new Uint8Array(text.length * 2);
    const be = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      le[2 * i] = c & 0xff;
      le[2 * i + 1] = c >> 8;
      be[2 * i] = c >> 8;
      be[2 * i + 1] = c & 0xff;
    }
    expect(decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, ...le]))).toBe(text);
    expect(decodeSubtitleBytes(new Uint8Array([0xfe, 0xff, ...be]))).toBe(text);
    expect(decodeSubtitleBytes(le)).toBe(text);
    expect(decodeSubtitleBytes(be)).toBe(text);
  });

  it("falls back to Windows-1252 for files that aren't UTF-8", () => {
    // "Café – ‘ok’" in Windows-1252
    const bytes = new Uint8Array([
      0x43, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x91, 0x6f, 0x6b, 0x92,
    ]);
    expect(decodeSubtitleBytes(bytes)).toBe("Café – ‘ok’");
  });

  it("handles empty and tiny files", () => {
    expect(decodeSubtitleBytes(new Uint8Array())).toBe("");
    expect(decodeSubtitleBytes(new Uint8Array([0x41]))).toBe("A");
  });
});
