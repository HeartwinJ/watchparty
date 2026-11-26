import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Chat } from "../../Chat/Chat";
import type { RoomStore } from "../roomState";
import {
  INITIAL_CHAT_PANEL,
  INITIAL_UNREAD,
  chatPanelReducer,
  updateUnread,
} from "./chatPanel";

/**
 * The chat panel's open state (collapsed every time it becomes available, see chatPanelReducer) and its unread count
 * (messages people wrote since this person last had the chat on screen: the open panel, or the sidebar's chat tab
 * outside fullscreen).
 */
export function useChatPanel(opts: {
  allowed: boolean;
  fullscreen: boolean;
  chat: ChatMessage[];
  chatInitCount: number;
  currentTab: string;
  clientId: string;
  store: RoomStore;
}) {
  const [panel, dispatch] = useReducer(chatPanelReducer, INITIAL_CHAT_PANEL);
  const chatRef = useRef<Chat | null>(null);
  // Mounted on the first open, unmounted when the panel stops being available (so a new fullscreen starts fresh)
  const [mounted, setMounted] = useState(false);
  const open = panel.open && opts.allowed;

  useEffect(() => {
    dispatch({ type: "allowed", allowed: opts.allowed });
    if (!opts.allowed) {
      setMounted(false);
    }
  }, [opts.allowed]);

  useEffect(() => {
    if (open) {
      setMounted(true);
    }
  }, [open]);

  const visible = open || (!opts.fullscreen && opts.currentTab === "chat");
  const unreadRef = useRef(INITIAL_UNREAD);
  unreadRef.current = updateUnread(unreadRef.current, {
    chat: opts.chat,
    initCount: opts.chatInitCount,
    visible,
    clientId: opts.clientId,
  });
  const unread = unreadRef.current.unread;

  // While the panel shows the chat, the sidebar's Chat tab badge has been read too
  const { store } = opts;
  useEffect(() => {
    if (open && store.get().unreadCount > 0) {
      store.set({ unreadCount: 0 });
    }
  }, [open, opts.chat, store]);

  const actions = useMemo(
    () => ({
      toggle: () => dispatch({ type: "toggle" }),
      openPanel: () => dispatch({ type: "open" }),
      close: () => dispatch({ type: "close" }),
    }),
    [],
  );

  return {
    open,
    mounted: mounted || open,
    unread,
    chatRef,
    ...actions,
  };
}
