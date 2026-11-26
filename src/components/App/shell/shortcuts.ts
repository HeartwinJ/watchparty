import { useEffect, useRef } from "react";

/** True when a key press should go to a text field (or a dialog) rather than a room shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  return Boolean(
    el.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]',
    ),
  );
}

/** Whether a modal dialog is open (room shortcuts are ignored then; the picker has its own keys). */
export function isModalOpen(doc: Document = document): boolean {
  return Boolean(doc.querySelector('[role="dialog"][aria-modal="true"]'));
}

/**
 * Pressing `/` anywhere in the room (when not typing and no modal is open) calls `onOpen`,
 * which opens the source picker.
 */
export function useSlashShortcut(onOpen: () => void) {
  const ref = useRef(onOpen);
  ref.current = onOpen;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key !== "/" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.defaultPrevented ||
        e.isComposing ||
        isTypingTarget(e.target) ||
        isModalOpen()
      ) {
        return;
      }
      e.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** The overflow menu's "Keyboard shortcuts" item fires this; the player shows the overlay. */
export const SHOW_SHORTCUTS_EVENT = "wp:show-shortcuts";

export function requestShortcutsOverlay() {
  window.dispatchEvent(new CustomEvent(SHOW_SHORTCUTS_EVENT));
}
