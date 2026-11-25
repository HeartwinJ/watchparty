import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverPath } from "./api";
import {
  FALLBACK_ICE_SERVERS,
  getIceServers,
  resetIceServersCache,
} from "./iceServers";

const servers: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  {
    urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
    username: "u",
    credential: "c",
  },
];

const mockFetch = (status: number, body: unknown = null) => {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === null ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
};

beforeEach(() => {
  resetIceServersCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getIceServers", () => {
  it("fetches /iceServers with credentials", async () => {
    const fetch = mockFetch(200, servers);
    expect(await getIceServers()).toEqual(servers);
    expect(fetch).toHaveBeenCalledWith(serverPath + "/iceServers", {
      credentials: "include",
    });
  });

  it("fetches once and caches the result", async () => {
    const fetch = mockFetch(200, servers);
    const [a, b] = await Promise.all([getIceServers(), getIceServers()]);
    await getIceServers();
    expect(a).toEqual(servers);
    expect(b).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches again after the cache expires", async () => {
    const fetch = mockFetch(200, servers);
    const now = Date.now();
    await getIceServers(now);
    await getIceServers(now + 30 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await getIceServers(now + 2 * 60 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an error status", () => mockFetch(500)],
    ["a 404 (old server)", () => mockFetch(404)],
    ["an empty list", () => mockFetch(200, [])],
    ["an invalid body", () => mockFetch(200, { urls: "stun:x" })],
    [
      "a network error",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new TypeError("Failed to fetch");
          }),
        ),
    ],
  ])("falls back to Cloudflare STUN on %s", async (_name, setup) => {
    setup();
    expect(await getIceServers()).toEqual(FALLBACK_ICE_SERVERS);
  });

  it("doesn't cache the fallback, so the next share retries", async () => {
    mockFetch(500);
    expect(await getIceServers()).toEqual(FALLBACK_ICE_SERVERS);
    // let the cache-clearing callback run
    await Promise.resolve();
    const fetch = mockFetch(200, servers);
    expect(await getIceServers()).toEqual(servers);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
