import { describe, expect, it, vi } from "vitest";
import {
  autoSyncAvailability,
  describeSyncOutcome,
  subtitleSyncKey,
  syncProgressLabel,
  syncResultToTiming,
} from "./logic";
import {
  AutoSyncError,
  createSyncWorker,
  isAutoSyncSupported,
  runAutoSync,
  type SyncRequest,
  type SyncWorker,
  type SyncWorkerMessage,
} from "./run";

const base = {
  isLiveStream: false,
  sharedFile: undefined,
  supported: true,
};

describe("autoSyncAvailability", () => {
  it("reads direct links from their URL", () => {
    expect(
      autoSyncAvailability({ ...base, media: "https://cdn.example.com/a.mkv" }),
    ).toEqual({ ok: true, source: "https://cdn.example.com/a.mkv" });
  });

  it.each([
    ["", "Nothing is playing"],
    ["https://www.youtube.com/watch?v=abc", "Not available for YouTube videos"],
    ["screenshare://bob", "Not available for screen shares"],
    [
      "https://cdn.example.com/live.m3u8",
      "Not available for streams (HLS/DASH)",
    ],
    ["https://cdn.example.com/a.mpd", "Not available for streams (HLS/DASH)"],
  ])("%s → %s", (media, reason) => {
    expect(autoSyncAvailability({ ...base, media })).toEqual({
      ok: false,
      reason,
    });
  });

  it("refuses live streams and browsers without audio decoding", () => {
    const media = "https://cdn.example.com/a.mkv";
    expect(
      autoSyncAvailability({ ...base, media, isLiveStream: true }),
    ).toMatchObject({ reason: "Not available for live streams" });
    expect(
      autoSyncAvailability({ ...base, media, supported: false }),
    ).toMatchObject({ reason: "This browser can't decode audio for syncing" });
  });

  it("only the sharer can sync a file share", () => {
    const file = new File(["x"], "a.mkv");
    expect(
      autoSyncAvailability({
        ...base,
        media: "fileshare://me",
        sharedFile: file,
      }),
    ).toEqual({ ok: true, source: file });
    expect(
      autoSyncAvailability({ ...base, media: "fileshare://bob" }),
    ).toMatchObject({
      reason: "Only the person sharing the file can auto-sync it",
    });
  });
});

describe("subtitleSyncKey", () => {
  it("names the room subtitle by URL and other tracks by position", () => {
    const track = { index: 2, label: "English", language: "en" };
    expect(
      subtitleSyncKey(
        { ...track, fromRoom: true },
        "https://s.example.com/a.srt",
      ),
    ).toBe("room:https://s.example.com/a.srt");
    expect(subtitleSyncKey({ ...track, fromRoom: false }, "x")).toBe(
      "track:2:en:English",
    );
  });
});

describe("messages", () => {
  it("describes outcomes", () => {
    expect(describeSyncOutcome(2.35)).toBe("Subtitles synced: +2.35 s");
    expect(describeSyncOutcome(0)).toBe("Subtitles synced: already in sync");
    expect(describeSyncOutcome(null)).toBe(
      "Couldn't find a confident match, offset unchanged",
    );
    expect(describeSyncOutcome(-1, { auto: true })).toBe(
      "Subtitles auto-synced: −1.0 s",
    );
    expect(describeSyncOutcome(1.5, { auto: true, by: "Bob" })).toBe(
      "Subtitles auto-synced by Bob: +1.5 s",
    );
  });

  it("labels progress", () => {
    expect(syncProgressLabel(0.4)).toBe("Listening… 40%");
    expect(syncProgressLabel(1)).toBe("Matching…");
    expect(syncProgressLabel(-1)).toBe("Listening… 0%");
  });

  it("turns results into timing (offset now, scale later)", () => {
    const r = {
      offset: 1.2,
      scale: 1,
      confidence: 0.5,
      peakZ: 9,
      candidate: 1.2,
    };
    expect(syncResultToTiming(r)).toEqual({ offset: 1.2, scale: 1 });
    expect(syncResultToTiming({ ...r, offset: null })).toBeNull();
  });
});

class FakeWorker implements SyncWorker {
  onmessage: ((e: MessageEvent<SyncWorkerMessage>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: SyncRequest[] = [];
  terminated = false;
  postMessage(msg: SyncRequest) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  send(msg: SyncWorkerMessage) {
    this.onmessage?.({ data: msg } as MessageEvent<SyncWorkerMessage>);
  }
}

describe("runAutoSync", () => {
  const cues = [{ start: 1, end: 2 }];
  const result = {
    offset: 2,
    scale: 1,
    confidence: 0.5,
    peakZ: 9,
    candidate: 2,
  };

  it("sends the request, relays progress and resolves with the result", async () => {
    const w = new FakeWorker();
    const onProgress = vi.fn();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const p = runAutoSync(
      { source: "https://cdn.example.com/a.mkv", cues, onProgress },
      () => w,
    );
    expect(w.posted[0]).toMatchObject({
      source: "https://cdn.example.com/a.mkv",
      cues,
      windowCount: 4,
      windowSeconds: 90,
      maxOffset: 600,
    });
    w.send({ type: "progress", fraction: 0.5 });
    expect(onProgress).toHaveBeenCalledWith(0.5);
    w.send({ type: "result", result, timing: { readMs: 1, alignMs: 1 } });
    await expect(p).resolves.toEqual(result);
    expect(w.terminated).toBe(true);
    // The source URL is never logged
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      "cdn.example.com",
    );
  });

  it("rejects with the worker's error, and when cancelled", async () => {
    const w = new FakeWorker();
    const p = runAutoSync(
      { source: "https://x.example.com/a.mp4", cues },
      () => w,
    );
    w.send({ type: "error", message: "Timed out reading the video's audio" });
    await expect(p).rejects.toThrow("Timed out reading the video's audio");

    const w2 = new FakeWorker();
    const ctl = new AbortController();
    const p2 = runAutoSync(
      { source: "https://x.example.com/a.mp4", cues, signal: ctl.signal },
      () => w2,
    );
    ctl.abort();
    await expect(p2).rejects.toMatchObject({ cancelled: true });
    expect(w2.terminated).toBe(true);
    expect(new AutoSyncError("x").cancelled).toBe(false);
  });
});

describe("runAutoSync edge cases", () => {
  const cues = [{ start: 1, end: 2 }];

  it("rejects at once (without a worker) when already cancelled", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const create = vi.fn(() => new FakeWorker());
    await expect(
      runAutoSync(
        { source: "https://x.example.com/a.mp4", cues, signal: ctl.signal },
        create,
      ),
    ).rejects.toMatchObject({ cancelled: true, message: "Cancelled" });
    expect(create).not.toHaveBeenCalled();
  });

  it("passes options through and rejects when the worker crashes", async () => {
    const w = new FakeWorker();
    const p = runAutoSync(
      {
        source: "https://x.example.com/a.mp4",
        cues,
        trackId: 4,
        windowCount: 2,
        windowSeconds: 30,
        maxOffset: 60,
      },
      () => w,
    );
    expect(w.posted[0]).toMatchObject({
      trackId: 4,
      windowCount: 2,
      windowSeconds: 30,
      maxOffset: 60,
      stallTimeoutMs: 20000,
    });
    // Progress without a listener is fine
    w.send({ type: "progress", fraction: 0.1 });
    w.onerror?.({} as ErrorEvent);
    await expect(p).rejects.toThrow("Subtitle sync stopped unexpectedly");
    expect(w.terminated).toBe(true);
  });
});

describe("autoSyncAvailability edge cases", () => {
  it("explains every unsupported kind of media", () => {
    const why = (media: string, extra: object = {}) => {
      const r = autoSyncAvailability({ ...base, media, ...extra });
      return r.ok ? "ok" : r.reason;
    };
    expect(why("")).toBe("Nothing is playing");
    expect(why("https://cdn.example.com/live.m3u8")).toBe(
      "Not available for streams (HLS/DASH)",
    );
    expect(why("https://www.twitch.tv/somechannel")).toBe(
      "Not available for this kind of link",
    );
    expect(why("https://cdn.example.com/a.mp4", { isLiveStream: true })).toBe(
      "Not available for live streams",
    );
  });
});

describe("worker support", () => {
  it("needs Worker and WebCodecs audio decoding", () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("AudioDecoder", undefined);
    expect(isAutoSyncSupported()).toBe(false);
    vi.stubGlobal("AudioDecoder", class {});
    expect(isAutoSyncSupported()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("starts the module worker", () => {
    const created: unknown[][] = [];
    vi.stubGlobal(
      "Worker",
      class {
        constructor(...args: unknown[]) {
          created.push(args);
        }
      },
    );
    createSyncWorker();
    expect(String(created[0][0])).toMatch(/worker\.ts/);
    expect(created[0][1]).toEqual({ type: "module", name: "subtitle-sync" });
    vi.unstubAllGlobals();
  });
});
