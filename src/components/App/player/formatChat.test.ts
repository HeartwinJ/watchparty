import { describe, expect, it } from "vitest";
import { describeChatCommand } from "./formatChat";

const settings = (change: object) =>
  describeChatCommand("roomSettings", JSON.stringify(change));

describe("describeChatCommand roomSettings", () => {
  it("describes each setting", () => {
    expect(settings({ title: "Friday movies" })).toBe(
      "renamed the room to “Friday movies”",
    );
    expect(settings({ title: "" })).toBe("reset the room name");
    expect(settings({ readyCheck: true })).toBe("turned the ready check on");
    expect(settings({ readyCheck: false })).toBe("turned the ready check off");
    expect(settings({ nextEpisodeOffset: 30 })).toBe(
      "set the next-episode card to 30s before the end",
    );
  });

  it("returns undefined for unknown or broken payloads", () => {
    expect(describeChatCommand("roomSettings", "not json")).toBeUndefined();
    expect(describeChatCommand("roomSettings", undefined)).toBeUndefined();
    expect(describeChatCommand("roomSettings", "null")).toBeUndefined();
    expect(settings({ somethingNew: 1 })).toBeUndefined();
  });
});
