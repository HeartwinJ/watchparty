import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_HIDE_MS, IdleTimer } from "./autoHide";

describe("IdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const changes: boolean[] = [];
    const t = new IdleTimer((idle) => changes.push(idle));
    return { t, changes };
  };

  it("hides after 2500 ms without activity", () => {
    const { t, changes } = setup();
    t.poke();
    vi.advanceTimersByTime(IDLE_HIDE_MS - 1);
    expect(t.isIdle()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.isIdle()).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("activity shows the controls again and restarts the timer", () => {
    const { t, changes } = setup();
    t.poke();
    vi.advanceTimersByTime(2000);
    t.poke();
    vi.advanceTimersByTime(2000);
    expect(t.isIdle()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(t.isIdle()).toBe(true);
    t.poke();
    expect(t.isIdle()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("stays visible while held (paused, hovering, menu open...)", () => {
    const { t } = setup();
    t.poke();
    t.setHold("paused", true);
    vi.advanceTimersByTime(10_000);
    expect(t.isIdle()).toBe(false);
    t.setHold("menu", true);
    t.setHold("paused", false);
    vi.advanceTimersByTime(10_000);
    expect(t.isIdle()).toBe(false);
    t.setHold("menu", false);
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    expect(t.isIdle()).toBe(true);
  });

  it("a new hold shows hidden controls", () => {
    const { t } = setup();
    t.poke();
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    expect(t.isIdle()).toBe(true);
    t.setHold("paused", true);
    expect(t.isIdle()).toBe(false);
  });

  it("supports a shorter delay (pointer left the player) and hiding now", () => {
    const { t } = setup();
    t.poke(500);
    vi.advanceTimersByTime(500);
    expect(t.isIdle()).toBe(true);
    t.poke();
    t.hideNow();
    expect(t.isIdle()).toBe(true);
    t.setHold("quick-chat", true);
    t.hideNow();
    expect(t.isIdle()).toBe(false);
  });

  it("does nothing after dispose", () => {
    const { t, changes } = setup();
    t.poke();
    t.dispose();
    vi.advanceTimersByTime(10_000);
    expect(changes).toEqual([]);
  });

  it("ignores a hold that doesn't change anything", () => {
    const { t, changes } = setup();
    t.setHold("menu", false);
    t.setHold("menu", true);
    t.setHold("menu", true);
    vi.advanceTimersByTime(IDLE_HIDE_MS * 2);
    expect(t.isIdle()).toBe(false);
    t.setHold("menu", false);
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    expect(t.isIdle()).toBe(true);
    expect(changes).toEqual([true]);
  });
});
