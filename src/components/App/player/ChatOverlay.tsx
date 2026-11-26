import { useEffect, useRef, useState } from "react";
import { describeChatCommand, isPersonlessLine } from "./formatChat";
import styles from "./Player.module.css";

export const BUBBLE_MS = 8000;
export const BUBBLE_FADE_MS = 600;
export const MAX_BUBBLES = 4;

interface Bubble {
  key: string;
  name: string;
  text: string;
  system: boolean;
  leaving: boolean;
}

const keyOf = (m: ChatMessage) => `${m.timestamp}|${m.id}|${m.cmd ?? ""}`;

/**
 * Translucent chat bubbles over the video (fullscreen, or with the sidebar collapsed). Only messages that arrive while
 * it's shown appear; each stays 8 s then fades for 600 ms, at most 4 at once.
 */
export function ChatOverlay(props: {
  chat: ChatMessage[];
  nameMap: StringDict;
  clientId: string;
  mediaName: (url?: string) => string;
  /** Quick chat is open: sit above it */
  chatting: boolean;
}) {
  const { chat } = props;
  const seen = useRef<Set<string> | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (!seen.current) {
      // History that was there before the overlay showed isn't replayed
      seen.current = new Set(chat.map(keyOf));
      return;
    }
    const fresh = chat.filter((m) => !seen.current!.has(keyOf(m)));
    if (!fresh.length) {
      return;
    }
    const added: Bubble[] = [];
    for (const m of fresh) {
      seen.current.add(keyOf(m));
      // Lines nobody caused (the queue advanced, the next episode started) have no name
      const name = isPersonlessLine(m)
        ? ""
        : m.id === props.clientId
          ? "You"
          : props.nameMap[m.id] || "Someone";
      const text = m.cmd
        ? describeChatCommand(m.cmd, m.msg, props.mediaName)
        : m.msg;
      if (!text) {
        continue;
      }
      added.push({
        key: keyOf(m),
        name,
        text,
        system: Boolean(m.cmd || m.system),
        leaving: false,
      });
    }
    if (!added.length) {
      return;
    }
    setBubbles((prev) => [...prev, ...added].slice(-MAX_BUBBLES));
    for (const b of added) {
      timers.current.push(
        window.setTimeout(() => {
          setBubbles((prev) =>
            prev.map((x) => (x.key === b.key ? { ...x, leaving: true } : x)),
          );
        }, BUBBLE_MS),
        window.setTimeout(() => {
          setBubbles((prev) => prev.filter((x) => x.key !== b.key));
        }, BUBBLE_MS + BUBBLE_FADE_MS),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  useEffect(
    () => () => timers.current.forEach((t) => window.clearTimeout(t)),
    [],
  );

  return (
    <div
      className={styles.chatOverlay}
      data-chatting={props.chatting}
      aria-live="polite"
      aria-label="Chat messages"
    >
      {bubbles.map((b) => (
        <div
          key={b.key}
          className={styles.bubble}
          data-leaving={b.leaving}
          data-system={b.system}
        >
          {b.name && <b>{b.name}</b>}
          {b.text}
        </div>
      ))}
    </div>
  );
}
