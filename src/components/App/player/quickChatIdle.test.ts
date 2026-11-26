import { describe, expect, it } from "vitest";
import {
  emptySinceAfterPicker,
  idleDelay,
  nextEmptySince,
  QUICK_CHAT_IDLE_MS,
} from "./quickChatIdle";

describe("quick chat idle countdown", () => {
  it("counts down from when the input became empty", () => {
    expect(idleDelay(1_000, 1_000)).toBe(QUICK_CHAT_IDLE_MS);
    expect(idleDelay(1_000, 4_000)).toBe(2_000);
    expect(idleDelay(1_000, 9_000)).toBe(0);
  });

  it("text cancels it, emptying restarts it, staying empty keeps it", () => {
    let since = nextEmptySince(null, "", 0);
    expect(since).toBe(0);
    since = nextEmptySince(since, "hi", 2_000);
    expect(since).toBeNull();
    expect(idleDelay(since, 2_000)).toBeNull();
    since = nextEmptySince(since, "", 3_000);
    expect(since).toBe(3_000);
    // Only spaces is still empty: the running countdown goes on
    since = nextEmptySince(since, "  ", 4_000);
    expect(since).toBe(3_000);
    expect(idleDelay(since, 4_000)).toBe(4_000);
  });

  it("is paused while the emoji picker is open", () => {
    expect(idleDelay(1_000, 2_000, { paused: true })).toBeNull();
    expect(idleDelay(null, 2_000, { paused: true })).toBeNull();
    expect(idleDelay(1_000, 2_000, { paused: false })).toBe(4_000);
  });

  it("closing the picker restarts it from now if empty, else keeps it off", () => {
    expect(emptySinceAfterPicker("", 7_000)).toBe(7_000);
    expect(emptySinceAfterPicker("   ", 7_000)).toBe(7_000);
    expect(idleDelay(emptySinceAfterPicker("", 7_000), 7_000)).toBe(
      QUICK_CHAT_IDLE_MS,
    );
    expect(emptySinceAfterPicker("🎉", 7_000)).toBeNull();
  });

  it("takes a custom idle time", () => {
    expect(idleDelay(0, 500, { idleMs: 1_000 })).toBe(500);
  });
});
