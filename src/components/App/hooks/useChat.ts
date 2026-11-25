import { useMemo, type RefObject } from "react";
import { getCurrentSettings } from "../../Settings/LocalSettings";
import type { Chat } from "../../Chat/Chat";
import type { RoomStore } from "../roomState";
import {
  addReaction,
  appendChatMessage,
  removeReaction,
  shouldPlayChatSound,
} from "../logic/chat";

/** Chat state: applies REC:chat/chatinit/reaction events to the store, plays the message sound. */
export function useChat(opts: {
  store: RoomStore;
  chatRef: RefObject<Chat | null>;
}) {
  const { store, chatRef } = opts;
  return useMemo(() => {
    const onMessage = (msg: ChatMessage) => {
      const { chat, currentTab, unreadCount } = store.get();
      const chatTabActive = currentTab === "chat";
      if (
        shouldPlayChatSound({
          msg,
          soundDisabled: Boolean(getCurrentSettings().disableChatSound),
          documentVisible: !(
            document.visibilityState && document.visibilityState !== "visible"
          ),
          chatTabActive,
        })
      ) {
        new Audio("/clearly.mp3").play();
      }
      store.set({
        chat: appendChatMessage(chat, msg),
        scrollTimestamp: Date.now(),
        unreadCount: chatTabActive ? unreadCount : unreadCount + 1,
      });
    };

    const onInit = (chat: ChatMessage[]) => {
      store.set({ chat, scrollTimestamp: Date.now() });
    };

    const onAddReaction = (reaction: Reaction) => {
      const result = addReaction(store.get().chat, reaction);
      if (result.index === -1) {
        return;
      }
      store.set({ chat: result.chat });
      // if we add a reaction to the last message we need to scroll down
      // or else the reaction icon might be hidden
      if (
        result.index === result.chat.length - 1 &&
        chatRef.current?.state.isNearBottom
      ) {
        // Wait for the reaction to render
        window.setTimeout(() => chatRef.current?.scrollToBottom(), 0);
      }
    };

    const onRemoveReaction = (reaction: Reaction) => {
      store.set({ chat: removeReaction(store.get().chat, reaction) });
    };

    return { onMessage, onInit, onAddReaction, onRemoveReaction };
  }, [store, chatRef]);
}
