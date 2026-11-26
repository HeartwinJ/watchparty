import { describe, expect, it, vi } from "vitest";
import { AddonError, createRedactor, fetchJson, type FetchFn } from "./http.ts";

const SECRET_URL =
  "https://aio.example.com/stremio/00000000-1111-2222-3333-444444444444/eyFAKEconfigBLOBthatIsLong/manifest.json";

const opts = { label: "test", timeoutMs: 1000 };
const asErr = (e: unknown) => e as AddonError;
const unexpected = (): never => {
  throw new Error("expected a rejection");
};

describe("fetchJson", () => {
  it("parses JSON", async () => {
    const fetchFn = vi.fn(async () => Response.json({ a: 1 }));
    expect(await fetchJson(fetchFn, "https://x.example/a.json", opts)).toEqual({
      a: 1,
    });
  });

  it("maps HTTP errors without the URL", async () => {
    const fetchFn: FetchFn = async () => new Response("nope", { status: 500 });
    const err = await fetchJson(fetchFn, SECRET_URL, opts).then(
      unexpected,
      asErr,
    );
    expect(err).toBeInstanceOf(AddonError);
    expect(err.kind).toBe("http");
    expect(err.upstreamStatus).toBe(500);
    expect(err.message).toBe("test: http 500");
  });

  it("maps safeFetch-style 'HTTP 404' errors", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("HTTP 404");
    };
    const err = await fetchJson(fetchFn, "https://x.example", opts).then(
      unexpected,
      asErr,
    );
    expect(err.kind).toBe("http");
    expect(err.upstreamStatus).toBe(404);
  });

  it("times out", async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      });
    const err = await fetchJson(fetchFn, SECRET_URL, {
      ...opts,
      timeoutMs: 20,
    }).then(unexpected, asErr);
    expect(err).toBeInstanceOf(AddonError);
    expect(err.kind).toBe("timeout");
    expect(err.message).not.toContain("aio.example.com");
  });

  it("hides network error details (which can include the URL)", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError(`fetch failed for ${SECRET_URL}`);
    };
    const err = await fetchJson(fetchFn, SECRET_URL, opts).then(
      unexpected,
      asErr,
    );
    expect(err.kind).toBe("network");
    expect(err.message).toBe("test: network");
  });

  it("rejects invalid JSON", async () => {
    const fetchFn: FetchFn = async () => new Response("<html>");
    const err = await fetchJson(fetchFn, "https://x.example", opts).then(
      unexpected,
      asErr,
    );
    expect(err.kind).toBe("invalid_json");
  });

  it("enforces the size limit by Content-Length and while streaming", async () => {
    const big = JSON.stringify({ a: "x".repeat(2000) });
    const withLength: FetchFn = async () =>
      new Response(big, { headers: { "content-length": String(big.length) } });
    expect(
      (
        await fetchJson(withLength, "https://x.example", {
          ...opts,
          maxBytes: 100,
        }).then(unexpected, asErr)
      ).kind,
    ).toBe("too_large");
    const chunked: FetchFn = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(big));
            c.close();
          },
        }),
      );
    expect(
      (
        await fetchJson(chunked, "https://x.example", {
          ...opts,
          maxBytes: 100,
        }).then(unexpected, asErr)
      ).kind,
    ).toBe("too_large");
  });
});

describe("createRedactor", () => {
  const redact = createRedactor(SECRET_URL);

  it("removes the full URL and its secret path segments", () => {
    expect(redact(`GET ${SECRET_URL} failed`)).toBe("GET [redacted] failed");
    expect(
      redact(
        "x/stream/movie/tt1.json via 00000000-1111-2222-3333-444444444444",
      ),
    ).toBe("x/stream/movie/tt1.json via [redacted]");
    expect(redact("cfg=eyFAKEconfigBLOBthatIsLong")).toBe("cfg=[redacted]");
    expect(redact("https://aio.example.com/stremio/x/manifest.json")).toBe(
      "https://aio.example.com/stremio/x/manifest.json",
    );
  });

  it("is a no-op without a secret", () => {
    expect(createRedactor("")("anything")).toBe("anything");
  });
});

describe("fetchJson edge cases", () => {
  it("treats an empty body as invalid JSON", async () => {
    const fetchFn: FetchFn = async () => new Response(null, { status: 200 });
    const e = await fetchJson(fetchFn, "https://x.example.com", opts).then(
      unexpected,
      asErr,
    );
    expect(e.kind).toBe("invalid_json");
  });

  it("maps a body that fails mid-stream to a network error", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("reset"));
      },
    });
    const fetchFn: FetchFn = async () => new Response(body);
    const e = await fetchJson(fetchFn, "https://x.example.com", opts).then(
      unexpected,
      asErr,
    );
    expect(e).toBeInstanceOf(AddonError);
    expect(e.kind).toBe("network");
  });
});

describe("createRedactor edge cases", () => {
  it("redacts URL passwords and whole non-URL secrets", () => {
    const redact = createRedactor("https://user:hunter2pass@aio.example.com/x");
    expect(redact("auth hunter2pass here")).toBe("auth [redacted] here");
    const raw = createRedactor("not a url at all");
    expect(raw("log: not a url at all!")).toBe("log: [redacted]!");
    expect(createRedactor("")("unchanged")).toBe("unchanged");
  });
});
