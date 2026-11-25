import { useEffect, useRef } from "react";
import { IconX } from "@tabler/icons-react";
import { SHORTCUT_GROUPS } from "../logic/shortcuts";
import styles from "./Player.module.css";

/** Keyboard shortcuts (`?`, or the overflow menu's `wp:show-shortcuts` event). Rendered inside the player. */
export function ShortcutsOverlay(props: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, []);
  return (
    <div
      className={styles.shortcutsScrim}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div
        className={styles.shortcuts}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wp-shortcuts-title"
      >
        <div className={styles.shortcutsHead}>
          <h2 id="wp-shortcuts-title">Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            className={styles.overlayClose}
            aria-label="Close"
            onClick={props.onClose}
          >
            <IconX size={20} />
          </button>
        </div>
        <div className={styles.kbGrid}>
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title} className={styles.kbGroup}>
              <h4>{g.title}</h4>
              {g.rows.map(([label, keys]) => (
                <div key={label} className={styles.kbRow}>
                  <span>{label}</span>
                  <span>
                    {keys.map((k) => (
                      <kbd key={k} className={styles.kbd}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
