import { describe, expect, it } from "vitest";
import {
  bufferedAhead,
  describeReadyCheckChange,
  formatNames,
  isMediaStalled,
  isReadyToPlay,
  StallDebounce,
  StallTracker,
  waitingLabel,
} from "./readyCheck";

const base = {
  notBlocking: false,
  loading: false,
  currentTime: 10,
  duration: 100,
  ranges: [] as { start: number; end: number }[],
};

describe("bufferedAhead", () => {
  it("measures the range containing the playhead", () => {
    const ranges = [
      { start: 0, end: 5 },
      { start: 9.9, end: 20 },
    ];
    expect(bufferedAhead(ranges, 12)).toBe(8);
    expect(bufferedAhead(ranges, 9.8)).toBeCloseTo(10.2); // just before a range after a seek
    expect(bufferedAhead(ranges, 7)).toBe(0);
    expect(bufferedAhead([], 1)).toBe(0);
  });
});

describe("isReadyToPlay", () => {
  it("never blocks without media / for shares and live", () => {
    expect(isReadyToPlay({ ...base, notBlocking: true, loading: true })).toBe(
      true,
    );
  });

  it("needs enough buffered ahead, with hysteresis", () => {
    expect(isReadyToPlay({ ...base, ranges: [{ start: 0, end: 13 }] })).toBe(
      false,
    );
    expect(isReadyToPlay({ ...base, ranges: [{ start: 0, end: 16 }] })).toBe(
      true,
    );
    expect(
      isReadyToPlay({
        ...base,
        ranges: [{ start: 0, end: 13 }],
        wasReady: true,
      }),
    ).toBe(true);
    expect(
      isReadyToPlay({
        ...base,
        ranges: [{ start: 0, end: 11 }],
        wasReady: true,
      }),
    ).toBe(false);
  });

  it("is ready when buffered to the end", () => {
    expect(
      isReadyToPlay({
        ...base,
        currentTime: 98,
        ranges: [{ start: 90, end: 100 }],
      }),
    ).toBe(true);
  });

  it("trusts HAVE_ENOUGH_DATA, except while converting", () => {
    expect(isReadyToPlay({ ...base, readyState: 4 })).toBe(true);
    expect(isReadyToPlay({ ...base, readyState: 3 })).toBe(false);
    expect(isReadyToPlay({ ...base, readyState: 4, converting: true })).toBe(
      false,
    );
  });

  it("isn't ready while loading or YouTube is buffering", () => {
    const full = [{ start: 0, end: 100 }];
    expect(isReadyToPlay({ ...base, ranges: full, loading: true })).toBe(false);
    expect(isReadyToPlay({ ...base, ranges: full, ytBuffering: true })).toBe(
      false,
    );
  });
});

describe("StallDebounce", () => {
  it("only reports stalls that last 1.5 s", () => {
    const d = new StallDebounce();
    expect(d.update(true, 0)).toBe(false);
    expect(d.update(true, 1499)).toBe(false);
    expect(d.update(true, 1500)).toBe(true);
    expect(d.update(false, 1600)).toBe(false);
    expect(d.update(true, 1700)).toBe(false);
  });
});

describe("isMediaStalled", () => {
  it("is a playing <video> without data at the playhead", () => {
    expect(isMediaStalled({ paused: false, readyState: 1 })).toBe(true);
    expect(isMediaStalled({ paused: false, readyState: 2 })).toBe(true);
    expect(isMediaStalled({ paused: false, readyState: 3 })).toBe(false);
    expect(isMediaStalled({ paused: true, readyState: 1 })).toBe(false);
    expect(isMediaStalled({ paused: false, ended: true, readyState: 2 })).toBe(
      false,
    );
    expect(isMediaStalled({ readyState: 1 })).toBe(false);
  });
});

describe("StallTracker", () => {
  const playing = {
    active: true,
    roomPlaying: true,
    stalled: false,
    hasFutureData: true,
  };

  it("ignores hiccups shorter than the debounce", () => {
    const t = new StallTracker();
    const stalled = { ...playing, stalled: true, hasFutureData: false };
    expect(t.update(stalled, 0)).toEqual({ buffering: false, stuck: false });
    expect(t.update(stalled, 1000)).toEqual({ buffering: false, stuck: false });
    expect(t.update(playing, 1400)).toEqual({ buffering: false, stuck: false });
    expect(t.update(stalled, 1500)).toEqual({ buffering: false, stuck: false });
  });

  it("stays stuck after a long stall until there's data at the playhead, also while the room is paused", () => {
    const t = new StallTracker();
    const stalled = { ...playing, stalled: true, hasFutureData: false };
    t.update(stalled, 0);
    expect(t.update(stalled, 1500)).toEqual({ buffering: true, stuck: true });
    // The ready check paused the room: no longer stalling, but still nothing to play
    const paused = { ...playing, roomPlaying: false, hasFutureData: false };
    expect(t.update(paused, 2000)).toEqual({ buffering: false, stuck: true });
    expect(t.update(paused, 30000)).toEqual({ buffering: false, stuck: true });
    expect(t.update({ ...paused, hasFutureData: true }, 31000)).toEqual({
      buffering: false,
      stuck: false,
    });
  });

  it("forgets the stall when there's nothing to block on (new video loading, share)", () => {
    const t = new StallTracker();
    const stalled = { ...playing, stalled: true, hasFutureData: false };
    t.update(stalled, 0);
    t.update(stalled, 2000);
    expect(t.update({ ...stalled, active: false }, 2500)).toEqual({
      buffering: false,
      stuck: false,
    });
    // The debounce starts over
    expect(t.update(stalled, 3000).buffering).toBe(false);
  });

  it("doesn't count a stall while the room is paused", () => {
    const t = new StallTracker();
    const pausedStall = {
      ...playing,
      roomPlaying: false,
      stalled: true,
      hasFutureData: false,
    };
    t.update(pausedStall, 0);
    expect(t.update(pausedStall, 5000)).toEqual({
      buffering: false,
      stuck: false,
    });
  });
});

const names = { a: "Sam", b: "Alex", c: "Kim", d: "Lee" };

describe("formatNames / waitingLabel", () => {
  it("lists names readably", () => {
    expect(formatNames(["a"], names, "me")).toBe("Sam");
    expect(formatNames(["a", "me"], names, "me")).toBe("Sam and you");
    expect(formatNames(["a", "b", "c"], names, "me")).toBe("Sam, Alex and Kim");
    expect(formatNames(["a", "b", "c", "d"], names, "me")).toBe(
      "Sam, Alex and 2 others",
    );
    expect(formatNames(["x"], names, "me")).toBe("someone");
  });

  it("labels the pill", () => {
    expect(waitingLabel(null, names, "me")).toBe("");
    expect(
      waitingLabel({ active: true, waitingFor: ["a", "b"] }, names, "me"),
    ).toBe("Waiting for Sam and Alex…");
  });
});

describe("describeReadyCheckChange", () => {
  const active: ReadyCheckState = {
    active: true,
    waitingFor: ["a"],
    reason: "buffering",
    trigger: "a",
  };

  it("announces the pause", () => {
    expect(describeReadyCheckChange(null, active, names, "me")).toEqual({
      text: "Paused — waiting for Sam to buffer",
      tone: "warning",
    });
    expect(
      describeReadyCheckChange(
        null,
        { ...active, reason: "join", trigger: "me" },
        names,
        "me",
      )?.text,
    ).toBe("Paused — waiting for you to load the video");
    // Already active: no new toast
    expect(describeReadyCheckChange(active, active, names, "me")).toBeNull();
  });

  it("announces a timeout and someone else's skip, quietly ends otherwise", () => {
    const end = (s: Partial<ReadyCheckState>) =>
      describeReadyCheckChange(
        active,
        { active: false, waitingFor: [], ...s },
        names,
        "me",
      );
    expect(end({ outcome: "timeout" })).toEqual({
      text: "Resumed without waiting longer for Sam",
      tone: "warning",
    });
    expect(end({ outcome: "skipped", actorId: "b" })?.text).toBe(
      "Alex resumed without waiting",
    );
    expect(end({ outcome: "skipped", actorId: "me" })).toBeNull();
    expect(end({ outcome: "ready" })).toBeNull();
    expect(end({ outcome: "cancelled" })).toBeNull();
    // The initial state on connect isn't a change
    expect(
      describeReadyCheckChange(
        null,
        { active: false, waitingFor: [], outcome: "timeout" },
        names,
        "me",
      ),
    ).toBeNull();
  });
});

describe("ready check edge cases", () => {
  it("has no names and a generic pill with nobody to wait for", () => {
    expect(formatNames([], names, "me")).toBe("");
    expect(waitingLabel({ active: true, waitingFor: [] }, names, "me")).toBe(
      "Getting ready…",
    );
    expect(
      waitingLabel({ active: false, waitingFor: ["a"] }, names, "me"),
    ).toBe("");
  });

  it("names everyone waited for without a trigger, and stays quiet with nobody", () => {
    expect(
      describeReadyCheckChange(
        null,
        { active: true, waitingFor: ["a", "b"], reason: "buffering" },
        names,
        "me",
      )?.text,
    ).toBe("Paused — waiting for Sam and Alex to buffer");
    expect(
      describeReadyCheckChange(
        null,
        { active: true, waitingFor: [], reason: "buffering" },
        names,
        "me",
      ),
    ).toBeNull();
  });

  it("ends a timeout without names, and an anonymous skip", () => {
    const prev: ReadyCheckState = { active: true, waitingFor: [] };
    expect(
      describeReadyCheckChange(
        prev,
        { active: false, waitingFor: [], outcome: "timeout" },
        names,
        "me",
      )?.text,
    ).toBe("Resumed without waiting longer");
    expect(
      describeReadyCheckChange(
        prev,
        { active: false, waitingFor: [], outcome: "skipped", actorId: "zz" },
        names,
        "me",
      )?.text,
    ).toBe("Someone resumed without waiting");
    expect(
      describeReadyCheckChange(
        prev,
        { active: false, waitingFor: [], outcome: "skipped" },
        names,
        "me",
      )?.text,
    ).toBe("Someone resumed without waiting");
  });
});
