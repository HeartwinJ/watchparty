import { describe, expect, it } from "vitest";
import {
  groupSubtitleChoices,
  guessLanguage,
  languageName,
  stripNumber,
  type SubtitleChoice,
} from "./subtitleChoices";

const c = (
  id: string,
  language: string,
  extra: Partial<SubtitleChoice> = {},
): SubtitleChoice => ({ id, label: id, language, checked: false, ...extra });

describe("languageName", () => {
  it("names ISO codes and ignores unknown or empty ones", () => {
    expect(languageName("en")).toBe("English");
    expect(languageName("eng")).toBe("English");
    expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
    expect(languageName("")).toBeUndefined();
    expect(languageName(undefined)).toBeUndefined();
    expect(languageName("zz")).toBeUndefined();
    expect(languageName("not a tag!")).toBeUndefined();
  });
});

describe("label helpers", () => {
  it("strip the server's numbering and track decorations", () => {
    expect(stripNumber("English 2")).toBe("English");
    expect(stripNumber("English")).toBe("English");
    expect(guessLanguage("English [SDH]")).toBe("English");
    expect(guessLanguage("Français (Forced) 2")).toBe("Français");
  });
});

describe("groupSubtitleChoices", () => {
  const choices = [
    c("English", "English", { detail: "OpenSubtitles" }),
    c("Español", "Spanish"),
    c("English 2", "English", { checked: true }),
    c("Deutsch", "German", { detail: "Embedded in the file" }),
  ];

  it("groups by language in first-seen order and marks the selected one", () => {
    const groups = groupSubtitleChoices(choices);
    expect(
      groups.map((g) => [g.language, g.choices.length, g.checked]),
    ).toEqual([
      ["English", 2, true],
      ["Spanish", 1, false],
      ["German", 1, false],
    ]);
  });

  it("filters by language, label or detail, case-insensitively", () => {
    expect(groupSubtitleChoices(choices, " span ").map((g) => g.key)).toEqual([
      "spanish",
    ]);
    expect(
      groupSubtitleChoices(choices, "english 2")[0].choices.map((x) => x.id),
    ).toEqual(["English 2"]);
    expect(groupSubtitleChoices(choices, "EMBEDDED")[0].language).toBe(
      "German",
    );
    expect(groupSubtitleChoices(choices, "klingon")).toEqual([]);
  });
});
