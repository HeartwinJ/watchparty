// The auto-sync worker's message handling: read windows → align (early stop on a clear match) → result/error.
// The worker script sets `self.onmessage` on import; here `self` is the test window and postMessage is spied.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityWindow, SyncResult } from "./signal";
import type { SyncRequest, SyncWorkerMessage } from "./run";

const readActivityWindows = vi.fn();
vi.mock("./audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audio")>()),
  readActivityWindows: (o: unknown) => readActivityWindows(o),
}));
const alignWithDrift = vi.fn();
const isClearMatch = vi.fn();
vi.mock("./signal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signal")>()),
  alignWithDrift: (...a: unknown[]) => alignWithDrift(...a),
  isClearMatch: (...a: unknown[]) => isClearMatch(...a),
}));

const posted: SyncWorkerMessage[] = [];
const postSpy = vi
  .spyOn(self, "postMessage")
  .mockImplementation(((m: SyncWorkerMessage) => posted.push(m)) as any);

await import("./worker");
const { AudioReadError } = await import("./audio");

const req: SyncRequest = {
  source: "https://cdn.example.com/movie.mkv",
  trackId: 3,
  cues: [{ start: 1, end: 2 }],
  windowCount: 4,
  windowSeconds: 90,
  maxOffset: 600,
  stallTimeoutMs: 20000,
};
const result = (offset: number | null): SyncResult =>
  ({
    offset,
    candidate: offset ?? 0,
    confidence: 0.5,
    peakZ: 10,
    scale: 1,
  }) as unknown as SyncResult;
const win = (start: number): ActivityWindow =>
  ({ start, activity: new Float32Array(10) }) as ActivityWindow;

const send = async (data: SyncRequest) => {
  await (self.onmessage as (e: MessageEvent) => Promise<void>)({
    data,
  } as MessageEvent);
};

beforeEach(() => {
  posted.length = 0;
  readActivityWindows.mockReset();
  alignWithDrift.mockReset();
  isClearMatch.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("subtitle sync worker", () => {
  it("passes the request on, relays progress and aligns everything that was read", async () => {
    readActivityWindows.mockImplementation(async (o: any) => {
      o.onProgress(0.25);
      expect(o.onWindow([win(0)])).toBe(false); // fewer than 3 windows: keep reading
      return { windows: [win(0), win(100)], duration: 600 };
    });
    alignWithDrift.mockReturnValue(result(1.5));
    await send(req);
    expect(readActivityWindows).toHaveBeenCalledWith(
      expect.objectContaining({
        source: req.source,
        trackId: 3,
        cues: req.cues,
        windowCount: 4,
        windowSeconds: 90,
        stallTimeoutMs: 20000,
      }),
    );
    expect(alignWithDrift).toHaveBeenCalledWith([win(0), win(100)], req.cues, {
      maxOffset: 600,
    });
    expect(posted[0]).toEqual({ type: "progress", fraction: 0.25 });
    expect(posted[1]).toMatchObject({
      type: "result",
      result: result(1.5),
      timing: { readMs: expect.any(Number), alignMs: expect.any(Number) },
    });
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  it("reuses the early alignment when a clear match stopped the reading", async () => {
    const early = result(-3);
    alignWithDrift.mockReturnValue(early);
    isClearMatch.mockReturnValue(true);
    readActivityWindows.mockImplementation(async (o: any) => {
      const sofar = [win(0), win(100), win(200)];
      expect(o.onWindow(sofar)).toBe(true);
      return { windows: sofar, duration: 600 };
    });
    await send(req);
    expect(alignWithDrift).toHaveBeenCalledTimes(1);
    expect(isClearMatch).toHaveBeenCalledWith(early, 3);
    expect(posted.at(-1)).toMatchObject({ type: "result", result: early });
  });

  it("aligns again when more windows were read after the last check", async () => {
    alignWithDrift
      .mockReturnValueOnce(result(5))
      .mockReturnValueOnce(result(6));
    isClearMatch.mockReturnValue(false);
    readActivityWindows.mockImplementation(async (o: any) => {
      o.onWindow([win(0), win(1), win(2)]);
      return { windows: [win(0), win(1), win(2), win(3)], duration: 600 };
    });
    await send(req);
    expect(alignWithDrift).toHaveBeenCalledTimes(2);
    expect(posted.at(-1)).toMatchObject({ result: result(6) });
  });

  it("posts readable errors, and a generic one for anything unexpected", async () => {
    readActivityWindows.mockRejectedValueOnce(
      new AudioReadError("This video has no audio track"),
    );
    await send(req);
    expect(posted.at(-1)).toEqual({
      type: "error",
      message: "This video has no audio track",
    });
    readActivityWindows.mockRejectedValueOnce(new TypeError("boom"));
    await send(req);
    expect(posted.at(-1)).toEqual({
      type: "error",
      message: "Couldn't read the video's audio",
    });
  });
});
