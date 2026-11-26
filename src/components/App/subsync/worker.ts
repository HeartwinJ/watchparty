// Auto subtitle sync worker: decode audio windows → speech activity → alignment. Started by runAutoSync (run.ts),
// which terminates it to cancel.
import { AudioReadError, readActivityWindows } from "./audio";
import { alignWindows, isClearMatch, type SyncResult } from "./signal";
import type { SyncRequest, SyncWorkerMessage } from "./run";

const post = (msg: SyncWorkerMessage) => self.postMessage(msg);

self.onmessage = async (e: MessageEvent<SyncRequest>) => {
  const req = e.data;
  const t0 = performance.now();
  // Aligning after each window lets a clear match stop the download early
  let last: { result: SyncResult; windows: number } | null = null;
  try {
    const { windows } = await readActivityWindows({
      source: req.source,
      trackId: req.trackId,
      cues: req.cues,
      windowCount: req.windowCount,
      windowSeconds: req.windowSeconds,
      stallTimeoutMs: req.stallTimeoutMs,
      onProgress: (fraction) => post({ type: "progress", fraction }),
      onWindow: (sofar) => {
        if (sofar.length < 3) {
          return false;
        }
        const result = alignWindows(sofar, req.cues, {
          maxOffset: req.maxOffset,
        });
        last = { result, windows: sofar.length };
        return isClearMatch(result, sofar.length);
      },
    });
    const t1 = performance.now();
    const done = last as { result: SyncResult; windows: number } | null;
    const result =
      done && done.windows === windows.length
        ? done.result
        : alignWindows(windows, req.cues, { maxOffset: req.maxOffset });
    post({
      type: "result",
      result,
      timing: {
        readMs: Math.round(t1 - t0),
        alignMs: Math.round(performance.now() - t1),
      },
    });
  } catch (err) {
    post({
      type: "error",
      message:
        err instanceof AudioReadError
          ? err.message
          : "Couldn't read the video's audio",
    });
  }
};
