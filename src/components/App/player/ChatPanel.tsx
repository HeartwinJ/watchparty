import { useEffect, useState, type RefObject } from "react";
import { IconX } from "@tabler/icons-react";
import { Chat } from "../../Chat/Chat";
import type { Room } from "../hooks/useRoom";
import { keyboardInset } from "./chatPanel";
import styles from "./Player.module.css";

/**
 * The room's chat in a translucent panel over the right side of the player (fullscreen, or with the sidebar
 * collapsed). It's the real `Chat` (history, replies, reactions, emoji, links), with its own ref: `room.chatRef` stays
 * the sidebar's. Popovers portal into `container` (the player, the fullscreen element). Keys pressed inside it never
 * reach the player shortcuts (`data-no-shortcuts`), except Esc.
 */
export function ChatPanel(props: {
  room: Room;
  open: boolean;
  /** Panel width in px (chatPanelWidth) */
  width: number;
  container: HTMLElement | null;
  chatRef: RefObject<Chat | null>;
  onClose: () => void;
  onHoverChange: (hovering: boolean) => void;
}) {
  const { room, open } = props;
  const { state } = room;
  const kb = useKeyboardInset(open);

  return (
    <section
      className={styles.chatPanel}
      data-open={open}
      data-kb={kb > 0 || undefined}
      data-no-shortcuts=""
      aria-label="Chat"
      aria-hidden={!open}
      inert={!open}
      style={
        {
          "--wp-chat-panel-w": `${props.width}px`,
          "--wp-kb-inset": `${kb}px`,
        } as React.CSSProperties
      }
      // Clicks and taps in the panel never reach the click-to-pause layer or the player's double-click
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerEnter={(e) =>
        e.pointerType === "mouse" && props.onHoverChange(true)
      }
      onPointerLeave={(e) =>
        e.pointerType === "mouse" && props.onHoverChange(false)
      }
    >
      <header className={styles.chatPanelHead}>
        <h2>Chat</h2>
        <button
          type="button"
          className={styles.btn}
          aria-label="Close chat"
          title="Close chat (Shift + c)"
          onClick={props.onClose}
        >
          <IconX size={20} />
        </button>
      </header>
      <Chat
        ref={props.chatRef}
        className={styles.chatPanelChat}
        chat={state.chat}
        nameMap={state.nameMap}
        pictureMap={state.pictureMap}
        cmd={room.cmd}
        scrollTimestamp={state.scrollTimestamp}
        getMediaDisplayName={room.getMediaDisplayName}
        portalTarget={props.container}
        compact
        placeholder="Message everyone"
      />
    </section>
  );
}

/** Lifts the panel above the on-screen keyboard while it's open (see keyboardInset) */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) {
      setInset(0);
      return;
    }
    const update = () => setInset(keyboardInset(window.innerHeight, vv));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
  return inset;
}
