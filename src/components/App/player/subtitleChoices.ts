// The subtitle menu's track list, pure: one flat list while it's short, grouped by language (with a filter) once a
// title has many subtitles (auto subtitles from OpenSubtitles plus tracks embedded in an MKV easily make 40+).

/** One pickable subtitle in the menu */
export interface SubtitleChoice {
  id: string;
  label: string;
  /** Secondary line ("OpenSubtitles", "Embedded in the file") */
  detail?: string;
  /** Show the Auto badge */
  auto?: boolean;
  checked: boolean;
  /** The language it's grouped under ("English"); choices with the same name share a group */
  language: string;
}

export interface SubtitleChoiceGroup {
  /** Lowercased language name, stable across renders */
  key: string;
  language: string;
  choices: SubtitleChoice[];
  /** One of its choices is the selected subtitle */
  checked: boolean;
}

/** Up to this many choices are listed flat, as before; more are grouped by language with a filter */
export const GROUP_THRESHOLD = 8;

let displayNames: Intl.DisplayNames | null | undefined;

/** "en" / "eng" / "pt-BR" → "English" / "English" / "Brazilian Portuguese"; undefined for unknown or empty codes */
export function languageName(code: string | undefined): string | undefined {
  const c = code?.trim();
  if (!c) {
    return undefined;
  }
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      displayNames = null;
    }
  }
  try {
    const name = displayNames?.of(c);
    return name && name.toLowerCase() !== c.toLowerCase() ? name : undefined;
  } catch {
    // Not a valid language tag
    return undefined;
  }
}

/** "English 2" → "English" (the server numbers repeated languages) */
export const stripNumber = (label: string) =>
  label.replace(/\s+\d+$/, "").trim();

/** A language name from an embedded track's label when it has no language code: "English [SDH]" → "English" */
export const guessLanguage = (label: string) =>
  stripNumber(label.replace(/\s*[[(].*$/, ""));

/**
 * Groups choices by language, in the order each language first appears (auto subtitles come sorted with the room's
 * preferred languages first), keeping only the ones matching `query` (language, label or detail; case-insensitive).
 */
export function groupSubtitleChoices(
  choices: readonly SubtitleChoice[],
  query = "",
): SubtitleChoiceGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, SubtitleChoiceGroup>();
  for (const c of choices) {
    if (
      q &&
      ![c.language, c.label, c.detail ?? ""].some((s) =>
        s.toLowerCase().includes(q),
      )
    ) {
      continue;
    }
    const key = c.language.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { key, language: c.language, choices: [], checked: false };
      groups.set(key, g);
    }
    g.choices.push(c);
    g.checked ||= c.checked;
  }
  return [...groups.values()];
}
