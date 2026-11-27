import { useState } from "react";
import { IconCheck, IconChevronDown, IconSearch } from "@tabler/icons-react";
import {
  GROUP_THRESHOLD,
  groupSubtitleChoices,
  type SubtitleChoice,
  type SubtitleChoiceGroup,
} from "./subtitleChoices";
import styles from "./Player.module.css";

/**
 * The subtitle menu's track list. Short lists are flat. Longer ones (> GROUP_THRESHOLD) get a filter box and one row
 * per language: a language with several subtitles folds them under it (open while it holds the selected one, or while
 * filtering); a language with one is a plain row.
 */
export function SubtitleChoiceList(props: {
  choices: SubtitleChoice[];
  onPick: (id: string) => void;
  /** Rows before the choices inside the list (the "Off" row) */
  leading?: React.ReactNode;
}) {
  const { choices, onPick } = props;
  const [query, setQuery] = useState("");
  /** Groups the viewer opened or closed by hand (otherwise: open when it holds the selected subtitle) */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const grouped = choices.length > GROUP_THRESHOLD;
  const groups = grouped ? groupSubtitleChoices(choices, query) : [];
  const filtering = query.trim() !== "";

  const row = (c: SubtitleChoice, nested = false) => (
    <button
      key={c.id}
      className={`${styles.menuItem} ${nested ? styles.nested : ""}`}
      role="menuitemradio"
      aria-checked={c.checked}
      onClick={() => onPick(c.id)}
    >
      <IconCheck size={16} className={styles.check} />
      <span className={styles.grow}>
        {c.label}
        {c.detail && <small>{c.detail}</small>}
      </span>
      {c.auto && <span className={styles.badge}>Auto</span>}
    </button>
  );

  const group = (g: SubtitleChoiceGroup) => {
    if (g.choices.length === 1) {
      return row(g.choices[0]);
    }
    const open = filtering || (toggled[g.key] ?? g.checked);
    const selected = g.choices.find((c) => c.checked);
    return (
      <div key={g.key} role="group" aria-label={g.language}>
        <button
          className={styles.menuItem}
          role="menuitem"
          aria-expanded={open}
          onClick={() => setToggled((t) => ({ ...t, [g.key]: !open }))}
        >
          <IconCheck
            size={16}
            className={`${styles.check} ${g.checked ? styles.checkOn : ""}`}
          />
          <span className={styles.grow}>
            {g.language}
            <small>
              {g.choices.length} subtitles
              {selected && !open ? ` · ${selected.label}` : ""}
            </small>
          </span>
          <IconChevronDown
            size={16}
            className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
            aria-hidden="true"
          />
        </button>
        {open && g.choices.map((c) => row(c, true))}
      </div>
    );
  };

  return (
    <>
      {grouped && (
        <label className={styles.filterRow}>
          <IconSearch size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Filter subtitles"
            placeholder={`Filter ${choices.length} subtitles…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div role="menu" aria-label="Subtitle tracks">
        {props.leading}
        {grouped ? groups.map(group) : choices.map((c) => row(c))}
        {grouped && filtering && groups.length === 0 && (
          <div className={styles.emptyNote}>No subtitles match “{query}”</div>
        )}
      </div>
    </>
  );
}
