import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiUrl, onUnauthorized, serverPath } from "./api";

const mockFetch = (status: number, body: unknown = null) => {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === null ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  it("resolves paths against serverPath and leaves absolute URLs alone", () => {
    expect(apiUrl("/youtube?q=a")).toBe(serverPath + "/youtube?q=a");
    expect(apiUrl("https://example.com/sub.srt")).toBe(
      "https://example.com/sub.srt",
    );
  });
});

describe("apiFetch", () => {
  it("sends credentials to our server", async () => {
    const fetch = mockFetch(200, {});
    await apiFetch("/ping", { method: "POST" });
    expect(fetch).toHaveBeenCalledWith(serverPath + "/ping", {
      credentials: "include",
      method: "POST",
    });
  });

  it("doesn't send credentials to other origins", async () => {
    const fetch = mockFetch(200);
    await apiFetch("https://example.com/sub.srt");
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/sub.srt",
      undefined,
    );
  });

  it("notifies listeners on 401", async () => {
    mockFetch(401, { error: "unauthorized" });
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    const response = await apiFetch("/youtube?q=a");
    expect(response.status).toBe(401);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await apiFetch("/youtube?q=a");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("can ignore 401 (e.g. a wrong password on /login)", async () => {
    mockFetch(401, { error: "invalid_password" });
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await apiFetch("/login", undefined, { ignoreUnauthorized: true });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("doesn't treat a 401 from another origin as our session expiring", async () => {
    mockFetch(401);
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await apiFetch("https://example.com/private.srt");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("doesn't notify on other errors", async () => {
    mockFetch(500);
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await apiFetch("/youtube?q=a");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
