import { describe, expect, it } from "vitest";
import { DUCK_FACTOR, DUCK_TIMING as T, Ducker, stepDuck } from "./ducking";

describe("stepDuck", () => {
  it("fades down over attackMs and up over releaseMs", () => {
    expect(DUCK_FACTOR).toBe(0.6);
    expect(stepDuck(1, DUCK_FACTOR, T.attackMs / 2)).toBeCloseTo(0.8);
    expect(stepDuck(1, DUCK_FACTOR, T.attackMs * 2)).toBe(DUCK_FACTOR);
    expect(stepDuck(DUCK_FACTOR, 1, T.releaseMs / 2)).toBeCloseTo(0.8);
    expect(stepDuck(DUCK_FACTOR, 1, T.releaseMs * 2)).toBe(1);
    expect(stepDuck(1, 1, 100)).toBe(1);
  });
});

describe("Ducker", () => {
  const run = (
    d: Ducker,
    from: number,
    to: number,
    input: { enabled: boolean; remoteSpeaking: boolean },
  ) => {
    let level = d.level;
    for (let t = from; t <= to; t += 50) {
      level = d.update(input, t);
    }
    return level;
  };

  it("lowers the movie 40 % while someone else speaks, then restores it smoothly", () => {
    const d = new Ducker();
    expect(d.update({ enabled: true, remoteSpeaking: false }, 0)).toBe(1);
    const down = run(d, 50, 400, { enabled: true, remoteSpeaking: true });
    expect(down).toBe(DUCK_FACTOR);
    // Held for a moment after they stop
    const held = run(d, 450, 400 + T.holdMs - 50, {
      enabled: true,
      remoteSpeaking: false,
    });
    expect(held).toBe(DUCK_FACTOR);
    // Then a slow fade back
    const partway = run(d, 400 + T.holdMs, 400 + T.holdMs + 600, {
      enabled: true,
      remoteSpeaking: false,
    });
    expect(partway).toBeGreaterThan(DUCK_FACTOR);
    expect(partway).toBeLessThan(1);
    expect(run(d, 1600, 4000, { enabled: true, remoteSpeaking: false })).toBe(
      1,
    );
  });

  it("does nothing when the viewer turned it off (the default)", () => {
    const d = new Ducker();
    expect(run(d, 0, 2000, { enabled: false, remoteSpeaking: true })).toBe(1);
  });

  it("turning it off while ducked fades back up", () => {
    const d = new Ducker();
    run(d, 0, 500, { enabled: true, remoteSpeaking: true });
    expect(d.level).toBe(DUCK_FACTOR);
    expect(run(d, 550, 3000, { enabled: false, remoteSpeaking: true })).toBe(1);
  });

  it("reset jumps back to full volume", () => {
    const d = new Ducker();
    run(d, 0, 500, { enabled: true, remoteSpeaking: true });
    d.reset();
    expect(d.level).toBe(1);
  });
});
