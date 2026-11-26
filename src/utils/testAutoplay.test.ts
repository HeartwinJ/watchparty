import { describe, expect, it, vi } from "vitest";

const video = vi.hoisted(() => vi.fn());
vi.mock("can-autoplay", () => ({ default: { video } }));

import { AUTOPLAY_TEST_TIMEOUT_MS, testAutoplay } from "./utils";

describe("testAutoplay", () => {
  it("gives a slow device more than the library's 250 ms before calling autoplay blocked", async () => {
    video.mockResolvedValueOnce({ result: true });
    await expect(testAutoplay()).resolves.toBe(true);
    expect(video).toHaveBeenCalledWith({ timeout: AUTOPLAY_TEST_TIMEOUT_MS });
    expect(AUTOPLAY_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  });

  it("reports a blocked autoplay", async () => {
    video.mockResolvedValueOnce({ result: false, error: new Error("blocked") });
    await expect(testAutoplay()).resolves.toBe(false);
  });
});
