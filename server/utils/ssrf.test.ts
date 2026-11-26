import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, isPrivateIP, safeFetch } from "./ssrf.ts";

describe("isPrivateIP", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])("blocks %s", (ip) => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isPrivateIP(ip)).toBe(false);
    },
  );

  it("fails closed for non-IP input", () => {
    expect(isPrivateIP("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("accepts public http(s) URLs", () => {
    expect(assertPublicUrl("https://example.com/video.mp4").hostname).toBe(
      "example.com",
    );
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "http://localhost:8080/",
    "http://foo.localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data",
  ])("rejects %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });
});

describe("safeFetch", () => {
  const fetchMock =
    vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>();
  let lookup: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    lookup = vi
      .spyOn(dns.promises, "lookup")
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches a public URL without following redirects automatically", async () => {
    fetchMock.mockResolvedValue(new Response("ok"));
    const resp = await safeFetch("https://cdn.example.com/a.m3u8", {
      headers: { A: "1" },
    });
    expect(await resp.text()).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cdn.example.com/a.m3u8");
    expect(init).toMatchObject({ redirect: "manual", headers: { A: "1" } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(lookup).toHaveBeenCalledWith("cdn.example.com", { all: true });
  });

  it("refuses hostnames that resolve to a private address", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);
    await expect(safeFetch("https://evil.example.com/")).rejects.toThrow(
      "Blocked address 10.0.0.5",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doesn't resolve IP literals", async () => {
    fetchMock.mockResolvedValue(new Response("ok"));
    await safeFetch("https://93.184.216.34/");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("follows up to 3 redirects, re-checking each target", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/b" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://other.example.com/c" },
        }),
      )
      .mockResolvedValueOnce(new Response("done"));
    const resp = await safeFetch("https://cdn.example.com/a");
    expect(await resp.text()).toBe("done");
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      "https://cdn.example.com/a",
      "https://cdn.example.com/b",
      "https://other.example.com/c",
    ]);
  });

  it("refuses a redirect to a private address", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      }),
    );
    await expect(safeFetch("https://cdn.example.com/a")).rejects.toThrow(
      "Blocked address",
    );
  });

  it("gives up after too many redirects", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: "/loop" } }),
    );
    await expect(safeFetch("https://cdn.example.com/a")).rejects.toThrow(
      "Too many redirects",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws on HTTP errors and oversized responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 404 }));
    await expect(safeFetch("https://cdn.example.com/a")).rejects.toThrow(
      "HTTP 404",
    );
    // A 3xx without a Location is an error too
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(safeFetch("https://cdn.example.com/a")).rejects.toThrow(
      "HTTP 304",
    );
    fetchMock.mockResolvedValueOnce(
      new Response("x", {
        headers: { "content-length": String(51 * 1024 * 1024) },
      }),
    );
    await expect(safeFetch("https://cdn.example.com/a")).rejects.toThrow(
      "Response too large",
    );
  });

  it("keeps a caller's abort signal", async () => {
    fetchMock.mockResolvedValue(new Response("ok"));
    const signal = new AbortController().signal;
    await safeFetch("https://cdn.example.com/a", { signal });
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(signal);
  });

  it("refuses non-public URLs before any lookup", async () => {
    await expect(safeFetch("http://127.0.0.1/")).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
});
