import { describe, expect, it } from "vitest";
import { recentConversation } from "./quickChatPreview";

const msg = (
  id: string,
  t: number,
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  timestamp: new Date(t * 1000).toISOString(),
  msg: text,
  ...extra,
});

const names = { a: "Ann", b: "Ben" };

describe("recentConversation", () => {
  it("is the last 3 typed messages, oldest first, with You for your own", () => {
    const chat = [
      msg("a", 1, "one"),
      msg("b", 2, "two"),
      msg("me", 3, "three"),
      msg("a", 4, "four"),
    ];
    expect(
      recentConversation(chat, names, "me").map((l) => [l.name, l.text]),
    ).toEqual([
      ["Ben", "two"],
      ["You", "three"],
      ["Ann", "four"],
    ]);
  });

  it("skips system lines, personless lines and blank messages", () => {
    const chat = [
      msg("a", 1, "hello"),
      msg("b", 2, "hi"),
      msg("a", 3, "12.5", { cmd: "pause" }),
      msg("a", 4, "", { cmd: "seek" }),
      msg("", 5, '{"via":"queue","title":"Ep 2"}', { cmd: "nowPlaying" }),
      msg("b", 6, "joined", { system: true }),
      msg("a", 7, "   "),
      msg("b", 8, '{"title":"x"}', { cmd: "roomSettings" }),
    ];
    expect(recentConversation(chat, names, "me").map((l) => l.text)).toEqual([
      "hello",
      "hi",
    ]);
  });

  it("is empty without conversation and names unknown people Someone", () => {
    expect(recentConversation([], names, "me")).toEqual([]);
    expect(
      recentConversation([msg("a", 1, "x", { cmd: "play" })], names, "me"),
    ).toEqual([]);
    expect(recentConversation([msg("zz", 1, "yo")], names, "me")[0].name).toBe(
      "Someone",
    );
  });

  it("gives each line a stable, distinct key", () => {
    const chat = [msg("a", 1, "x"), msg("b", 1, "y"), msg("a", 2, "z")];
    const keys = recentConversation(chat, names, "me").map((l) => l.key);
    expect(new Set(keys).size).toBe(3);
    expect(recentConversation(chat, names, "me").map((l) => l.key)).toEqual(
      keys,
    );
  });
});
