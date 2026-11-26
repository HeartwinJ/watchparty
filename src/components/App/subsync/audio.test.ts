import { describe, expect, it } from "vitest";
import { URL_READ_RETRIES, urlRetryDelay } from "./audio";

describe("urlRetryDelay", () => {
  it("retries a failed range request 3 times (mediabunny counts attempts from 1), then gives up", () => {
    expect(URL_READ_RETRIES).toBe(3);
    // Simulates mediabunny's retry loop: every failure calls getRetryDelay with the failures so far
    let retries = 0;
    for (let attempts = 1; urlRetryDelay(attempts) !== null; attempts++) {
      retries++;
    }
    expect(retries).toBe(3);
    expect([1, 2, 3, 4].map(urlRetryDelay)).toEqual([2, 3, 4, null]);
  });
});
