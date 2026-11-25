import { describe, expect, it } from "vitest";
import { openSubtitlesError, openSubtitlesHeaders } from "./opensubtitles.ts";

describe("openSubtitlesHeaders", () => {
  it("always sends a User-Agent and merges extra headers", () => {
    const h = openSubtitlesHeaders({ Accept: "application/json" });
    expect(h["User-Agent"]).toBeTruthy();
    expect(h.Accept).toBe("application/json");
    expect("Api-Key" in h).toBe(true);
  });
});

describe("openSubtitlesError", () => {
  it("explains the bad-key 403", async () => {
    const err = await openSubtitlesError(
      new Response(
        JSON.stringify({ message: "You cannot consume this service" }),
        { status: 403 },
      ),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/cannot consume/);
    expect(err.message).toMatch(/OPENSUBTITLES_KEY/);
  });

  it("passes through quota messages", async () => {
    const err = await openSubtitlesError(
      new Response(
        JSON.stringify({
          message: "You have downloaded your allowed 5 subtitles for 24h",
        }),
        { status: 406 },
      ),
    );
    expect(err).toEqual({
      error: "opensubtitles_error",
      status: 406,
      message: "You have downloaded your allowed 5 subtitles for 24h",
    });
  });

  it("handles non-JSON and empty bodies", async () => {
    expect(
      (
        await openSubtitlesError(
          new Response("<html>nope</html>", { status: 503 }),
        )
      ).message,
    ).toBe("<html>nope</html>");
    expect(
      (await openSubtitlesError(new Response("", { status: 500 }))).message,
    ).toBe("HTTP 500");
  });
});
