import { useEffect, useRef, useState } from "react";
import { IconMessage } from "@tabler/icons-react";
import styles from "./Player.module.css";

/** Compact chat input over the video (`c` in fullscreen or with the sidebar collapsed). Enter sends, Esc closes. */
export function QuickChat(props: {
  onSend: (msg: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
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
        onChange={(e) => setValue(e.target.value)}
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
      <span className={styles.kbd}>Enter</span>
      <span className={styles.kbd}>Esc</span>
    </form>
  );
}
