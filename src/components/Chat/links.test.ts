import { describe, expect, it } from "vitest";
import { splitLinks } from "./links";

describe("splitLinks", () => {
  it("returns plain text unchanged", () => {
    expect(splitLinks("hello there")).toEqual([
      { type: "text", text: "hello there" },
    ]);
  });

  it("finds http(s) links in text", () => {
    expect(splitLinks("see https://example.com/a?b=1 now")).toEqual([
      { type: "text", text: "see " },
      {
        type: "link",
        text: "https://example.com/a?b=1",
        href: "https://example.com/a?b=1",
      },
      { type: "text", text: " now" },
    ]);
  });

  it("adds https:// to www. links", () => {
    expect(splitLinks("www.example.com")).toEqual([
      {
        type: "link",
        text: "www.example.com",
        href: "https://www.example.com",
      },
    ]);
  });

  it("leaves trailing punctuation and unbalanced parentheses out", () => {
    expect(splitLinks("(go to http://a.com/x).")).toEqual([
      { type: "text", text: "(go to " },
      { type: "link", text: "http://a.com/x", href: "http://a.com/x" },
      { type: "text", text: ")." },
    ]);
    expect(splitLinks("http://en.wikipedia.org/wiki/A_(b)")[0]).toEqual({
      type: "link",
      text: "http://en.wikipedia.org/wiki/A_(b)",
      href: "http://en.wikipedia.org/wiki/A_(b)",
    });
  });

  it("finds several links", () => {
    const parts = splitLinks("http://a.com and http://b.com");
    expect(parts.filter((p) => p.type === "link")).toHaveLength(2);
  });

  it("doesn't link other schemes", () => {
    expect(splitLinks("javascript:alert(1)")).toEqual([
      { type: "text", text: "javascript:alert(1)" },
    ]);
  });

  it("handles long input quickly", () => {
    const start = performance.now();
    splitLinks("mailto:".repeat(20000) + "a".repeat(50000));
    expect(performance.now() - start).toBeLessThan(500);
  });
});
