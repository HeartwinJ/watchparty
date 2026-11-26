import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionIcon } from "@mantine/core";
import { IconMessage, IconMoodSmile } from "@tabler/icons-react";
import { EmojiPicker } from "../../Chat/EmojiPicker";
import { insertAtCaret } from "./insertText";
import { recentConversation } from "./quickChatPreview";
import {
  emptySinceAfterPicker,
  idleDelay,
  nextEmptySince,
  QUICK_CHAT_IDLE_MS,
} from "./quickChatIdle";
import styles from "./Player.module.css";

const MAX_LENGTH = 10000;

/**
 * Compact chat input over the video (`c` in fullscreen or with the sidebar collapsed). Enter sends, Esc closes (outside
 * fullscreen; in fullscreen the browser takes Esc), so does Backspace while it's already empty, and it closes by itself after 5 s empty (a small ring counts down).
 * The emoji button opens the Chat's emoji picker above the bar, portaled into `container` (the player, the fullscreen
 * element) so it shows in fullscreen; picks go in at the caret, and the countdown is paused while it's open. Above the
 * bar, the last 3 messages people typed give context for the reply (live; the 8 s bubbles are hidden meanwhile).
 */
export function QuickChat(props: {
  onSend: (msg: string) => void;
  onClose: () => void;
  /** Where the emoji picker is portaled to (the player container); inline in the bar without one */
  container?: HTMLElement | null;
  /** Narrow screens: fewer emoji per row so the picker fits */
  compact?: boolean;
  /** The room's chat, for the last 3 messages shown above the bar */
  chat?: readonly ChatMessage[];
  nameMap?: StringDict;
  clientId?: string;
}) {
  const [value, setValue] = useState("");
  const [emptySince, setEmptySince] = useState<number | null>(() => Date.now());
  const [pickerOpen, setPickerOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  // Caret to restore after inserting an emoji (the controlled re-render would move it to the end)
  const pendingCaret = useRef<number | null>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  // Empty for QUICK_CHAT_IDLE_MS: close (paused while the emoji picker is open)
  useEffect(() => {
    const delay = idleDelay(emptySince, Date.now(), { paused: pickerOpen });
    if (delay === null) {
      return;
    }
    const id = window.setTimeout(() => onCloseRef.current(), delay);
    return () => window.clearTimeout(id);
  }, [emptySince, pickerOpen]);
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const input = ref.current;
    if (caret === null || !input) {
      return;
    }
    pendingCaret.current = null;
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);
  }, [value]);

  const update = (v: string) => {
    valueRef.current = v;
    setValue(v);
    setEmptySince((prev) => nextEmptySince(prev, v, Date.now()));
  };
  const closePicker = (refocus: boolean) => {
    setPickerOpen(false);
    // Empty: a fresh 5 s from now
    setEmptySince(emptySinceAfterPicker(valueRef.current, Date.now()));
    if (refocus) {
      ref.current?.focus({ preventScroll: true });
    }
  };
  const pickEmoji = (emoji: { native: string }) => {
    const input = ref.current;
    const next = insertAtCaret(
      valueRef.current,
      emoji.native,
      input?.selectionStart ?? null,
      input?.selectionEnd ?? null,
    );
    if (next.value.length > MAX_LENGTH) {
      return;
    }
    pendingCaret.current = next.caret;
    update(next.value);
  };

  const { chat, nameMap, clientId } = props;
  const preview = useMemo(
    () => (chat ? recentConversation(chat, nameMap ?? {}, clientId ?? "") : []),
    [chat, nameMap, clientId],
  );

  const picker = pickerOpen && (
    <div
      className={styles.quickChatPicker}
      data-testid="quick-chat-emoji-picker"
      // Keys typed in the picker's search box (inside its shadow root) must not reach the player shortcuts
      data-no-shortcuts=""
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Esc closes only the picker (preventDefault keeps it from the player's Esc handling)
          e.preventDefault();
          e.stopPropagation();
          closePicker(true);
        }
      }}
    >
      <div className={styles.quickChatPickerBox}>
        <EmojiPicker
          theme="dark"
          previewPosition="none"
          maxFrequentRows={1}
          perLine={props.compact ? 7 : undefined}
          onEmojiSelect={pickEmoji}
          onClickOutside={(e) => {
            // Clicks on the bar (the input, the emoji button) keep it open
            const form = formRef.current;
            if (form && e.composedPath().includes(form)) {
              return;
            }
            closePicker(false);
          }}
        />
      </div>
    </div>
  );

  return (
    <>
      {preview.length > 0 && (
        <div
          className={styles.quickChatPreview}
          role="log"
          aria-label="Recent messages"
          data-testid="quick-chat-preview"
        >
          {preview.map((l) => (
            <div key={l.key} className={styles.quickChatPreviewLine}>
              <b>{l.name}</b>
              {l.text}
            </div>
          ))}
        </div>
      )}
      <form
        ref={formRef}
        className={styles.quickChat}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const msg = value.trim();
          if (msg) {
            props.onSend(msg);
            setValue("");
          }
          props.onClose();
        }}
      >
        <IconMessage size={16} aria-hidden="true" />
        <input
          ref={ref}
          aria-label="Message everyone"
          placeholder="Message everyone…"
          maxLength={MAX_LENGTH}
          value={value}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (pickerOpen) {
                closePicker(true);
              } else {
                props.onClose();
              }
            } else if (
              e.key === "Backspace" &&
              !e.repeat &&
              !pickerOpen &&
              e.currentTarget.value === ""
            ) {
              // Backspace on an already empty input dismisses it (not a held key clearing text, not with the picker open)
              e.preventDefault();
              props.onClose();
            }
          }}
          onBlur={(e) => {
            // Focus moved to the emoji picker (or the bar): stay open; the countdown covers the rest
            if (
              pickerOpen ||
              formRef.current?.contains(e.relatedTarget as Node | null)
            ) {
              return;
            }
            if (!value.trim()) {
              props.onClose();
            }
          }}
        />
        {emptySince !== null && !pickerOpen && (
          <svg
            key={emptySince}
            className={styles.quickChatRing}
            data-testid="quick-chat-countdown"
            viewBox="0 0 16 16"
            aria-hidden="true"
            style={
              {
                "--wp-quick-chat-idle": `${QUICK_CHAT_IDLE_MS}ms`,
              } as React.CSSProperties
            }
          >
            <circle cx="8" cy="8" r="6" pathLength="100" />
          </svg>
        )}
        <ActionIcon
          type="button"
          variant="subtle"
          color="gray"
          size={28}
          className={styles.quickChatEmoji}
          aria-label="Insert emoji"
          aria-expanded={pickerOpen}
          // Keep focus (and the caret) in the input
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (pickerOpen) {
              closePicker(true);
            } else {
              setPickerOpen(true);
            }
          }}
        >
          <IconMoodSmile size={18} />
        </ActionIcon>
        <span className={styles.kbd}>Enter</span>
        {picker &&
          (props.container ? createPortal(picker, props.container) : picker)}
      </form>
    </>
  );
}
