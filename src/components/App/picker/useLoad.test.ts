// The picker's loader: caching with a TTL and size cap, errors and retry, aborts, and null keys.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPickerCache, getCached, setCached, useLoad } from "./useLoad";

beforeEach(() => clearPickerCache());
afterEach(() => vi.useRealTimers());

describe("cache", () => {
  it("expires entries after 5 minutes", () => {
    vi.useFakeTimers();
    setCached("a", 1);
    expect(getCached("a")).toBe(1);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getCached("a")).toBeUndefined();
  });

  it("keeps at most 100 entries, dropping the oldest", () => {
    for (let i = 0; i <= 100; i++) setCached(`k${i}`, i);
    expect(getCached("k0")).toBeUndefined();
    expect(getCached("k1")).toBe(1);
    expect(getCached("k100")).toBe(100);
  });
});

describe("useLoad", () => {
  it("loads, caches and serves the cache on the next mount", async () => {
    const fn = vi.fn(async () => "data");
    const { result, unmount } = renderHook(() => useLoad("k", fn));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("data"));
    expect(result.current.loading).toBe(false);
    unmount();
    const again = renderHook(() => useLoad("k", fn));
    expect(again.result.current.data).toBe("data");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("loads nothing for a null key", () => {
    const fn = vi.fn(async () => "x");
    const { result } = renderHook(() => useLoad(null, fn));
    expect(result.current).toMatchObject({ data: undefined, loading: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it("reports errors and retries without the cache", async () => {
    const fn = vi
      .fn<(s: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const { result } = renderHook(() => useLoad("k", fn));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.loading).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data).toBe("ok"));
    expect(result.current.error).toBeUndefined();
  });

  it("ignores aborts and results for an old key", async () => {
    let resolveOld!: (v: string) => void;
    const fn = vi.fn((signal: AbortSignal) =>
      fn.mock.calls.length === 1
        ? new Promise<string>((r) => {
            resolveOld = r;
          })
        : new Promise<string>((_r, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
    );
    const { result, rerender } = renderHook(({ k }) => useLoad(k, fn), {
      initialProps: { k: "a" as string | null },
    });
    rerender({ k: "b" });
    resolveOld("old");
    await Promise.resolve();
    expect(result.current.data).toBeUndefined();
    expect(getCached("a")).toBeUndefined();
    // Switching to a cached key shows it right away; switching to null clears
    setCached("c", "cached");
    rerender({ k: "c" });
    expect(result.current.data).toBe("cached");
    rerender({ k: null });
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });
});
