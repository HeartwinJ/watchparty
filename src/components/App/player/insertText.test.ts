import { describe, expect, it } from "vitest";
import { insertAtCaret } from "./insertText";

describe("insertAtCaret", () => {
  it("inserts at the caret", () => {
    expect(insertAtCaret("hello world", "🎉", 5, 5)).toEqual({
      value: "hello🎉 world",
      caret: 7,
    });
  });

  it("replaces the selection", () => {
    expect(insertAtCaret("hello world", "😀", 6, 11)).toEqual({
      value: "hello 😀",
      caret: 8,
    });
  });

  it("appends without a known caret and into an empty value", () => {
    expect(insertAtCaret("hi", "!", null, null)).toEqual({
      value: "hi!",
      caret: 3,
    });
    expect(insertAtCaret("", "👍", 0, 0)).toEqual({ value: "👍", caret: 2 });
  });

  it("clamps bad positions", () => {
    expect(insertAtCaret("ab", "x", 10, 20)).toEqual({
      value: "abx",
      caret: 3,
    });
    expect(insertAtCaret("ab", "x", -3, 1)).toEqual({
      value: "xb",
      caret: 1,
    });
    // Reversed: treated as a caret at start
    expect(insertAtCaret("abc", "x", 2, 1)).toEqual({
      value: "abxc",
      caret: 3,
    });
  });
});
