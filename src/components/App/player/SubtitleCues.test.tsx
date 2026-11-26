import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { SubtitleCues } from "./SubtitleCues";

afterEach(cleanup);

/** A TextTrack stand-in whose activeCues can go stale, like browsers' after cue times change in place */
function fakeTrack(
  cues: { startTime: number; endTime: number; text: string }[],
) {
  const target = new EventTarget();
  return Object.assign(target, {
    cues,
    activeCues: [] as unknown[],
  }) as unknown as TextTrack;
}

/** The rendered subtitle lines (children of the cue box) */
const lines = (c: HTMLElement) =>
  Array.from(c.firstElementChild?.children ?? []).map((d) => d.textContent);

describe("SubtitleCues", () => {
  it("shows the cues at the video's time, not stale activeCues", () => {
    const cues = [
      { startTime: 1, endTime: 2, text: "first" },
      { startTime: 3, endTime: 4, text: "second" },
    ];
    const track = fakeTrack(cues);
    const media = new EventTarget() as HTMLMediaElement & {
      currentTime: number;
    };
    media.currentTime = 1.5;
    const { container } = render(
      <SubtitleCues
        track={track}
        getMedia={() => media}
        style={{ size: "m", background: "shadow" }}
        lift={false}
      />,
    );
    expect(lines(container)).toEqual(["first"]);

    // The browser still lists "first" as active after it ended (the reported bug): it must not stay on screen
    (track as unknown as { activeCues: unknown[] }).activeCues = [
      cues[0],
      cues[1],
    ];
    media.currentTime = 3.2;
    act(() => {
      track.dispatchEvent(new Event("cuechange"));
    });
    expect(lines(container)).toEqual(["second"]);

    // A cue ending without any cuechange is caught by timeupdate
    media.currentTime = 4.5;
    act(() => {
      media.dispatchEvent(new Event("timeupdate"));
    });
    expect(lines(container)).toEqual([]);
  });
});
