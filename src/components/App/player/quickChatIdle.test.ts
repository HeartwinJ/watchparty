import { describe, expect, it } from "vitest";
import { idleDelay, nextEmptySince, QUICK_CHAT_IDLE_MS } from "./quickChatIdle";

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
});
