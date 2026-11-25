import { describe, expect, it, vi } from "vitest";
import { STUN_ONLY, createIceServerProvider } from "./iceServers.ts";

const cfResponse = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "user",
      credential: "cred",
    },
  ],
};

describe("createIceServerProvider", () => {
  it("returns STUN only when not configured", async () => {
    const fetchFn = vi.fn();
    const provider = createIceServerProvider({
      keyId: "",
      apiToken: "",
      fetchFn,
    });
    expect(await provider.get()).toEqual(STUN_ONLY);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("requests Cloudflare credentials, drops port 53 and caches", async () => {
    let now = 0;
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify(cfResponse), { status: 201 }),
    );
    const provider = createIceServerProvider({
      keyId: "key123",
      apiToken: "secret-token",
      ttlSeconds: 3600,
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });
    const servers = await provider.get();
    expect(servers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "user",
        credential: "cred",
      },
    ]);
    expect(JSON.stringify(servers)).not.toContain("secret-token");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 3600 });

    // Cached until shortly before expiry
    now = 2000 * 1000;
    await provider.get();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 3600 * 1000;
    await provider.get();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent requests", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify(cfResponse), { status: 201 }),
    );
    const provider = createIceServerProvider({
      keyId: "k",
      apiToken: "t",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to STUN on API errors and retries later", async () => {
    let now = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("nope", { status: 403 }));
    const provider = createIceServerProvider({
      keyId: "k",
      apiToken: "t",
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });
    expect(await provider.get()).toEqual(STUN_ONLY);
    expect(await provider.get()).toEqual(STUN_ONLY);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 61 * 1000;
    await provider.get();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
