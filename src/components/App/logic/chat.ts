// Pure chat-state updates for the REC:* chat events. They return new arrays/objects instead of mutating.

/** How many messages the client keeps */
export const MAX_CHAT_MESSAGES = 100;

const sameMessage = (m: ChatMessage, msgId: string, msgTimestamp: string) =>
  m.id === msgId && m.timestamp === msgTimestamp;

export function appendChatMessage(chat: ChatMessage[], msg: ChatMessage) {
  const next = [...chat, msg];
  if (next.length > MAX_CHAT_MESSAGES) {
    next.shift();
  }
  return next;
}

/** Adds a reaction. Returns the index of the message (-1 if it isn't loaded, in which case chat is unchanged). */
export function addReaction(
  chat: ChatMessage[],
  reaction: Reaction,
): { chat: ChatMessage[]; index: number } {
  const index = chat.findIndex((m) =>
    sameMessage(m, reaction.msgId, reaction.msgTimestamp),
  );
  if (index === -1) {
    return { chat, index };
  }
  const msg = chat[index];
  const reactions = { ...msg.reactions };
  reactions[reaction.value] = [
    ...(reactions[reaction.value] ?? []),
    reaction.user,
  ];
  const next = [...chat];
  next[index] = { ...msg, reactions };
  return { chat: next, index };
}

export function removeReaction(chat: ChatMessage[], reaction: Reaction) {
  const index = chat.findIndex((m) =>
    sameMessage(m, reaction.msgId, reaction.msgTimestamp),
  );
  const msg = chat[index];
  if (!msg?.reactions?.[reaction.value]) {
    return chat;
  }
  const next = [...chat];
  next[index] = {
    ...msg,
    reactions: {
      ...msg.reactions,
      [reaction.value]: msg.reactions[reaction.value].filter(
        (id) => id !== reaction.user,
      ),
    },
  };
  return next;
}

/** Whether an incoming message should play the notification sound. */
export function shouldPlayChatSound(opts: {
  msg: ChatMessage;
  soundDisabled: boolean;
  documentVisible: boolean;
  chatTabActive: boolean;
}) {
  return (
    !opts.soundDisabled &&
    !opts.msg.system &&
    (!opts.documentVisible || !opts.chatTabActive)
  );
}
