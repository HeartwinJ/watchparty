import { describe, expect, it } from "vitest";
import {
  addReaction,
  appendChatMessage,
  MAX_CHAT_MESSAGES,
  removeReaction,
  shouldPlayChatSound,
} from "./chat";

const msg = (id: string, timestamp: string, extra?: Partial<ChatMessage>) =>
  ({ id, timestamp, msg: "hi", ...extra }) as ChatMessage;

describe("appendChatMessage", () => {
  it("appends without mutating", () => {
    const chat = [msg("a", "1")];
    const next = appendChatMessage(chat, msg("b", "2"));
    expect(next.map((m) => m.id)).toEqual(["a", "b"]);
    expect(chat).toHaveLength(1);
  });

  it("keeps at most MAX_CHAT_MESSAGES, dropping the oldest", () => {
    let chat: ChatMessage[] = [];
    for (let i = 0; i < MAX_CHAT_MESSAGES + 5; i++) {
      chat = appendChatMessage(chat, msg("u", String(i)));
    }
    expect(chat).toHaveLength(MAX_CHAT_MESSAGES);
    expect(chat[0].timestamp).toBe("5");
  });
});

describe("reactions", () => {
  const chat = [msg("a", "1"), msg("b", "2")];
  const reaction = (user: string, value = "👍"): Reaction => ({
    user,
    value,
    msgId: "b",
    msgTimestamp: "2",
  });

  it("adds a reaction to the matching message", () => {
    const { chat: next, index } = addReaction(chat, reaction("u1"));
    expect(index).toBe(1);
    expect(next[1].reactions).toEqual({ "👍": ["u1"] });
    expect(chat[1].reactions).toBeUndefined();
    const again = addReaction(next, reaction("u2")).chat;
    expect(again[1].reactions).toEqual({ "👍": ["u1", "u2"] });
  });

  it("ignores reactions to unknown messages", () => {
    const result = addReaction(chat, { ...reaction("u1"), msgId: "zzz" });
    expect(result.index).toBe(-1);
    expect(result.chat).toBe(chat);
  });

  it("removes a user's reaction", () => {
    const withTwo = addReaction(
      addReaction(chat, reaction("u1")).chat,
      reaction("u2"),
    ).chat;
    const next = removeReaction(withTwo, reaction("u1"));
    expect(next[1].reactions).toEqual({ "👍": ["u2"] });
    expect(withTwo[1].reactions).toEqual({ "👍": ["u1", "u2"] });
  });

  it("leaves chat unchanged when there's nothing to remove", () => {
    expect(removeReaction(chat, reaction("u1"))).toBe(chat);
    expect(removeReaction(chat, { ...reaction("u1"), msgId: "zzz" })).toBe(
      chat,
    );
  });
});

describe("shouldPlayChatSound", () => {
  const base = {
    msg: msg("a", "1"),
    soundDisabled: false,
    documentVisible: true,
    chatTabActive: true,
  };
  it("plays only when the chat isn't in view", () => {
    expect(shouldPlayChatSound(base)).toBe(false);
    expect(shouldPlayChatSound({ ...base, documentVisible: false })).toBe(true);
    expect(shouldPlayChatSound({ ...base, chatTabActive: false })).toBe(true);
  });
  it("never plays for system messages or when disabled", () => {
    const hidden = { ...base, documentVisible: false };
    expect(
      shouldPlayChatSound({ ...hidden, msg: msg("a", "1", { system: true }) }),
    ).toBe(false);
    expect(shouldPlayChatSound({ ...hidden, soundDisabled: true })).toBe(false);
  });
});
