import { describe, expect, it } from "vitest";
import { describePlayback, mediaKindLabel, shortMediaTitle } from "./roomInfo";
import { avatarColor, initials } from "../../Avatar/avatar";
import { prettyRoomName, roomDisplayName } from "../../../utils/rooms";

describe("shortMediaTitle", () => {
  it("prefers a real display name", () => {
    expect(shortMediaTitle("screenshare://x", "Alex's screen")).toBe(
      "Alex's screen",
    );
  });
  it("shortens raw URLs", () => {
    const yt = "https://www.youtube.com/watch?v=abc123";
    expect(shortMediaTitle(yt, yt)).toBe("YouTube · abc123");
    const file = "https://cdn.example.com/media/My%20Movie.mp4";
    expect(shortMediaTitle(file, file)).toBe("My Movie.mp4");
    expect(shortMediaTitle("https://example.com/", "")).toBe("example.com");
  });
  it("is empty without media", () => {
    expect(shortMediaTitle("", "")).toBe("");
  });
});

describe("mediaKindLabel", () => {
  it("labels sources", () => {
    expect(mediaKindLabel("https://youtu.be/x")).toBe("YouTube");
    expect(mediaKindLabel("https://a.example/x.m3u8")).toBe("HLS stream");
    expect(mediaKindLabel("")).toBe("");
  });
});

describe("describePlayback", () => {
  const base = { hasMedia: true, hasDuration: true };
  it("is idle without media", () => {
    expect(
      describePlayback({ ...base, hasMedia: false, ts: 1, referenceTs: 1 }),
    ).toEqual({ label: "Idle", tone: "idle" });
  });
  it("reports in sync, behind and ahead", () => {
    expect(describePlayback({ ...base, ts: 61, referenceTs: 61.5 })).toEqual({
      label: "In sync · 01:01",
      tone: "ok",
    });
    expect(describePlayback({ ...base, ts: 58, referenceTs: 61 })).toEqual({
      label: "3.0 s behind · 00:58",
      tone: "warn",
    });
    expect(describePlayback({ ...base, ts: 90, referenceTs: 61 }).label).toBe(
      "29 s ahead · 01:30",
    );
  });
  it("handles live/shared media and missing timestamps", () => {
    expect(
      describePlayback({ ...base, hasDuration: false, ts: 5, referenceTs: 5 })
        .label,
    ).toBe("Watching");
    expect(
      describePlayback({ ...base, ts: undefined, referenceTs: 5 }).label,
    ).toBe("Joining…");
  });
});

describe("avatars and names", () => {
  it("gives a stable avatar colour token per id", () => {
    expect(avatarColor("abc")).toBe(avatarColor("abc"));
    expect(avatarColor("abc")).toMatch(/^var\(--wp-avatar-[1-8]\)$/);
  });
  it("makes initials", () => {
    expect(initials("happy otter")).toBe("HO");
    expect(initials("  sam ")).toBe("S");
    expect(initials("")).toBe("?");
  });
  it("prettifies room ids", () => {
    expect(prettyRoomName("brave-otter-sings")).toBe("Brave otter sings");
    expect(prettyRoomName("/x")).toBe("X");
    expect(prettyRoomName("")).toBe("Room");
  });
  it("prefers the room title from room settings", () => {
    expect(roomDisplayName("brave-otter", "Friday movies")).toBe(
      "Friday movies",
    );
    expect(roomDisplayName("brave-otter", "")).toBe("Brave otter");
    expect(roomDisplayName("brave-otter", "   ")).toBe("Brave otter");
    expect(roomDisplayName("brave-otter")).toBe("Brave otter");
  });
});
