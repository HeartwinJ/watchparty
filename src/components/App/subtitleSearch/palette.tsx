/**
 * The subtitle dialogs' shell ("Search subtitles…" and the OpenSubtitles file-name search), built from the source
 * picker's parts (picker/SourcePicker.module.css) so they look and work like it: an opaque palette over the scrim
 * (full screen on phones), a search field in the header with Back/Close, a scrolling list of rows (↑/↓ move between
 * them) and a key-hint footer.
 */
import React, { useEffect, useRef } from "react";
import { ActionIcon, Loader, Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconDownload,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { cx } from "../picker/RootViews";
import picker from "../picker/SourcePicker.module.css";
import styles from "./SubtitleSearch.module.css";

export { cx, picker, styles };

export function usePhone() {
  return (
    useMediaQuery("(max-width: 768px)", false, {
      getInitialValueInEffect: false,
    }) ?? false
  );
}

/** The modal around a palette; `children` renders only while it's open */
export function PaletteModal({
  opened,
  onClose,
  label,
  phone,
  children,
}: {
  opened: boolean;
  onClose: () => void;
  /** The dialog's accessible name */
  label: string;
  phone: boolean;
  children: React.ReactNode;
}) {
  return (
    <Modal.Root
      opened={opened}
      onClose={onClose}
      size={640}
      yOffset="10vh"
      fullScreen={phone}
      // Esc is handled by useEscape (back one level, then close)
      closeOnEscape={false}
      trapFocus
      returnFocus
      zIndex={400}
      transitionProps={{
        transition: phone ? "slide-up" : "pop",
        duration: 180,
      }}
      classNames={{
        overlay: picker.overlay,
        content: cx(picker.content, styles.content),
        body: picker.modalBody,
      }}
    >
      <Modal.Overlay />
      <Modal.Content aria-label={label} data-full-screen={phone || undefined}>
        <Modal.Body>{opened && children}</Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

/** Esc anywhere in the dialog: `back()` (returns false at the top), else `close()` */
export function useEscape(back: () => boolean, close: () => void) {
  const ref = useRef({ back, close });
  ref.current = { back, close };
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (!ref.current.back()) {
        ref.current.close();
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, []);
}

/**
 * ↑/↓ between the list's rows (`button[data-row]`), and from the search field into the list and back. Put the
 * returned handler on the palette's root.
 */
export function arrowKeysBetweenRows(
  list: React.RefObject<HTMLElement | null>,
  input: React.RefObject<HTMLInputElement | null>,
) {
  return (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      return;
    }
    const rows = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-row]:not(:disabled)",
      ) ?? [],
    );
    if (!rows.length) {
      return;
    }
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const down = e.key === "ArrowDown";
    if (at < 0) {
      if (down) {
        rows[0].focus();
      }
    } else if (!down && at === 0) {
      input.current?.focus();
    } else {
      rows[Math.min(rows.length - 1, at + (down ? 1 : -1))].focus();
    }
  };
}

/** The header: Back (when `onBack`) or a search icon/spinner, the search field, Close */
export function PaletteHead({
  inputRef,
  value,
  onChange,
  onSubmit,
  onBack,
  onClose,
  busy,
  label,
  placeholder,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onBack?: () => void;
  onClose: () => void;
  busy: boolean;
  /** The field's accessible name */
  label: string;
  placeholder: string;
}) {
  return (
    <form
      className={picker.head}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {onBack ? (
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Back"
          onClick={onBack}
          size="lg"
        >
          <IconChevronLeft size={20} />
        </ActionIcon>
      ) : (
        <span className={picker.headIcon} aria-hidden>
          {busy ? <Loader size={18} color="gray" /> : <IconSearch size={20} />}
        </span>
      )}
      <input
        ref={inputRef}
        data-autofocus
        className={cx(picker.input, styles.input)}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        maxLength={100}
        onChange={(e) => onChange(e.currentTarget.value)}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label="Close"
        onClick={onClose}
        size="lg"
      >
        <IconX size={20} />
      </ActionIcon>
    </form>
  );
}

/** The footer: key hints (not on phones) and something on the right */
export function PaletteFoot({
  phone,
  right,
}: {
  phone: boolean;
  right: React.ReactNode;
}) {
  return (
    <div className={cx(picker.foot, styles.foot)}>
      {!phone && (
        <>
          <span>
            <kbd className={picker.kbd}>↑</kbd>
            <kbd className={picker.kbd}>↓</kbd> move
          </span>
          <span>
            <kbd className={picker.kbd}>↵</kbd> choose
          </span>
          <span>
            <kbd className={picker.kbd}>esc</kbd> back / close
          </span>
        </>
      )}
      <span className={picker.footRight}>{right}</span>
    </div>
  );
}

export function LoadingState({ text }: { text: string }) {
  return (
    <div className={styles.state} role="status">
      <Loader size="sm" color="gray" />
      <span>{text}</span>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className={picker.errorBox} role="alert">
      <IconAlertTriangle size={18} className={styles.danger} aria-hidden />
      <span className={picker.grow}>{message}</span>
      {onRetry && (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** "Load for everyone" at the end of a subtitle row (just an icon on phones, where the release name needs the room) */
export function LoadHint() {
  return (
    <span className={styles.hint}>
      <IconDownload size={14} aria-hidden className={styles.hintIcon} />
      <span className={styles.hintText}>Load for everyone</span>
    </span>
  );
}
