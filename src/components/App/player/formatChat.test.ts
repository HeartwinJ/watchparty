import { describe, expect, it } from "vitest";
import { describeChatCommand, isPersonlessLine } from "./formatChat";

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
    expect(settings({ autoSyncSubtitles: true })).toBe(
      "turned subtitle auto-sync on",
    );
    expect(settings({ autoSyncSubtitles: false })).toBe(
      "turned subtitle auto-sync off",
    );
  });

  it("describes the room's subtitle auto-sync", () => {
    expect(describeChatCommand("subtitleAutoSync", "2.35")).toBe(
      "auto-synced the subtitles: +2.35 s for everyone",
    );
    expect(describeChatCommand("subtitleAutoSync", "0")).toBe(
      "auto-synced the subtitles (already in sync)",
    );
    expect(describeChatCommand("subtitleAutoSync", "x")).toBeUndefined();
  });

  it("returns undefined for unknown or broken payloads", () => {
    expect(describeChatCommand("roomSettings", "not json")).toBeUndefined();
    expect(describeChatCommand("roomSettings", undefined)).toBeUndefined();
    expect(describeChatCommand("roomSettings", "null")).toBeUndefined();
    expect(settings({ somethingNew: 1 })).toBeUndefined();
  });
});

describe("describeChatCommand roomPassword", () => {
  it("never shows the password, only what changed", () => {
    expect(describeChatCommand("roomPassword", "changed")).toBe(
      "changed the room password",
    );
    expect(describeChatCommand("roomPassword", "on")).toBe(
      "turned on the room password",
    );
    expect(describeChatCommand("roomPassword", "off")).toBe(
      "turned off the room password",
    );
    expect(
      describeChatCommand("roomPassword", "otter-maple-42"),
    ).toBeUndefined();
  });
});

describe("describeChatCommand nowPlaying", () => {
  const line = (data: object, mediaName?: (url?: string) => string) =>
    describeChatCommand("nowPlaying", JSON.stringify(data), mediaName);

  it("says what started and why", () => {
    expect(line({ via: "queue", title: "Spring" })).toBe(
      "Now playing Spring (from the queue)",
    );
    expect(line({ via: "nextEpisode", title: "Example Show · S01E03" })).toBe(
      "Now playing Example Show · S01E03 (next episode)",
    );
  });

  it("names a bare URL like a host line", () => {
    expect(
      line({ via: "queue", url: "https://example.com/a.mp4" }, () => "a.mp4"),
    ).toBe("Now playing a.mp4 (from the queue)");
  });

  it("copes with broken payloads", () => {
    expect(describeChatCommand("nowPlaying", "nope")).toBeUndefined();
    expect(line({ via: "queue" })).toBe(
      "Now playing the next video (from the queue)",
    );
  });

  it("has no person", () => {
    expect(isPersonlessLine({ id: "" })).toBe(true);
    expect(isPersonlessLine({ id: "a" })).toBe(false);
  });
});
