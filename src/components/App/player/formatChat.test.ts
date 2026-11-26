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
    expect(settings({ skipIntro: 90 })).toBe("set skip intro to 1:30");
    expect(settings({ skipIntro: 15 })).toBe("set skip intro to 0:15");
    expect(settings({ skipIntro: 0 })).toBe("turned off skip intro");
  });

  it("describes subtitle timings with a time scale", () => {
    expect(
      describeChatCommand(
        "subtitleOffset",
        JSON.stringify({ offset: 2.35, scale: 0.959041 }),
      ),
    ).toBe("set subtitles +2.35 s · speed 0.959 (23.976→25 fps) for everyone");
    expect(describeChatCommand("subtitleOffset", "1.5")).toBe(
      "set subtitles +1.5 s for everyone",
    );
    expect(describeChatCommand("subtitleOffset", "0")).toBe(
      "reset the subtitle offset",
    );
    expect(
      describeChatCommand(
        "subtitleAutoSync",
        JSON.stringify({ offset: -1, scale: 1.041667 }),
      ),
    ).toBe(
      "auto-synced the subtitles: −1.0 s · speed 1.042 (25→24 fps) for everyone",
    );
    expect(describeChatCommand("subtitleOffset", "{oops")).toBeUndefined();
    expect(describeChatCommand("subtitleOffset", "")).toBeUndefined();
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

describe("describeChatCommand host for shares", () => {
  it("says the sharer started sharing, without a name lookup", () => {
    const name = () => "undefined's screen";
    expect(describeChatCommand("host", "screenshare://abc", name)).toBe(
      "started sharing their screen",
    );
    expect(describeChatCommand("host", "fileshare://abc", name)).toBe(
      "started sharing a file",
    );
  });
});
