// Sharing a found subtitle: download it (other origin, no credentials), store it with POST /subtitle, return the URL.
// Also the once-per-page OpenSubtitles status probe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverPath } from "../../../utils/api";
import {
  MAX_SUBTITLE_BYTES,
  ShareSubtitleError,
  shareSubtitleFromUrl,
  uploadSubtitleText,
} from "./shareSubtitle";
import {
  isOpenSubtitlesConfigured,
  resetOpenSubtitlesProbe,
} from "./openSubtitlesStatus";

const HASH = "a".repeat(64);
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("uploadSubtitleText", () => {
  it("stores the text and returns its /subtitle URL", async () => {
    fetchMock.mockResolvedValueOnce(json({ hash: HASH }));
    await expect(uploadSubtitleText(SRT)).resolves.toBe(
      `${serverPath}/subtitle/${HASH}`,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${serverPath}/subtitle`);
    expect(init).toMatchObject({
      method: "POST",
      body: SRT,
      credentials: "include",
      headers: { "Content-Type": "text/plain" },
    });
  });

  it("refuses empty and oversized files without uploading", async () => {
    await expect(uploadSubtitleText("  \n")).rejects.toMatchObject({
      code: "empty",
      message: "The subtitle file is empty",
    });
    await expect(
      uploadSubtitleText("x".repeat(MAX_SUBTITLE_BYTES + 1)),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a server error", () => new Response("no", { status: 500 })],
    ["a network error", () => Promise.reject(new TypeError("offline"))],
    ["no hash", () => json({})],
    ["a malformed hash", () => json({ hash: "../../etc" })],
    ["a non-JSON body", () => new Response("<html>")],
  ])("reports an upload failure for %s", async (_name, reply) => {
    fetchMock.mockImplementationOnce(async () => reply());
    const err = await uploadSubtitleText(SRT).catch((e) => e);
    expect(err).toBeInstanceOf(ShareSubtitleError);
    expect(err).toMatchObject({
      name: "ShareSubtitleError",
      code: "upload",
      message: "Couldn't share the subtitles with the room",
    });
  });
});

describe("shareSubtitleFromUrl", () => {
  const SRT_URL = "https://subs.example.com/file/123.srt";

  it("downloads without credentials, then uploads", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(SRT))
      .mockResolvedValueOnce(json({ hash: HASH }));
    const ctrl = new AbortController();
    await expect(shareSubtitleFromUrl(SRT_URL, ctrl.signal)).resolves.toBe(
      `${serverPath}/subtitle/${HASH}`,
    );
    expect(fetchMock.mock.calls[0]).toEqual([SRT_URL, { signal: ctrl.signal }]);
    expect(fetchMock.mock.calls[1][1].body).toBe(SRT);
  });

  it("reports download failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(shareSubtitleFromUrl(SRT_URL)).rejects.toMatchObject({
      code: "download",
      message: "Couldn't download the subtitle file",
    });
    fetchMock.mockRejectedValueOnce(new TypeError("CORS"));
    await expect(shareSubtitleFromUrl(SRT_URL)).rejects.toMatchObject({
      code: "download",
    });
  });

  it("lets an abort through as-is", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abort);
    await expect(shareSubtitleFromUrl(SRT_URL)).rejects.toBe(abort);
  });

  it("reports an empty download", async () => {
    fetchMock.mockResolvedValueOnce(new Response(""));
    await expect(shareSubtitleFromUrl(SRT_URL)).rejects.toMatchObject({
      code: "empty",
    });
  });
});

describe("isOpenSubtitlesConfigured", () => {
  beforeEach(() => resetOpenSubtitlesProbe());

  it("asks once per page load", async () => {
    fetchMock.mockResolvedValue(json({ configured: false }));
    await expect(isOpenSubtitlesConfigured()).resolves.toBe(false);
    await expect(isOpenSubtitlesConfigured()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${serverPath}/searchSubtitles/status`,
    );
  });

  it("assumes configured when the status route fails or is missing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(isOpenSubtitlesConfigured()).resolves.toBe(true);
    resetOpenSubtitlesProbe();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(isOpenSubtitlesConfigured()).resolves.toBe(true);
    resetOpenSubtitlesProbe();
    fetchMock.mockResolvedValueOnce(json({ configured: true }));
    await expect(isOpenSubtitlesConfigured()).resolves.toBe(true);
  });
});
