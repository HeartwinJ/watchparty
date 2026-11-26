import { useEffect, useRef, useState } from "react";
import { IconMessage } from "@tabler/icons-react";
import { idleDelay, nextEmptySince, QUICK_CHAT_IDLE_MS } from "./quickChatIdle";
import styles from "./Player.module.css";

/**
 * Compact chat input over the video (`c` in fullscreen or with the sidebar collapsed). Enter sends, Esc closes (outside
 * fullscreen; in fullscreen the browser takes Esc), and it closes by itself after 5 s empty (a small ring counts down).
 */
export function QuickChat(props: {
  onSend: (msg: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [emptySince, setEmptySince] = useState<number | null>(() => Date.now());
  const ref = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  // Empty for QUICK_CHAT_IDLE_MS: close
  useEffect(() => {
    const delay = idleDelay(emptySince, Date.now());
    if (delay === null) {
      return;
    }
    const id = window.setTimeout(() => onCloseRef.current(), delay);
    return () => window.clearTimeout(id);
  }, [emptySince]);
  return (
    <form
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
        maxLength={10000}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          setEmptySince((prev) => nextEmptySince(prev, v, Date.now()));
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          }
        }}
        onBlur={() => {
          if (!value.trim()) {
            props.onClose();
          }
        }}
      />
      {emptySince !== null && (
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
      <span className={styles.kbd}>Enter</span>
    </form>
  );
}
