// Auto subtitle sync worker: decode audio windows → speech activity → alignment. Started by runAutoSync (run.ts),
// which terminates it to cancel.
import { AudioReadError, readActivityWindows } from "./audio";
import { alignWithDrift, isClearMatch, type SyncResult } from "./signal";
import type { SyncRequest, SyncWorkerMessage } from "./run";

const post = (msg: SyncWorkerMessage) => self.postMessage(msg);

self.onmessage = async (e: MessageEvent<SyncRequest>) => {
  const req = e.data;
  const t0 = performance.now();
  // Aligning after each round lets a clear match that held still since the previous round stop the download early
  let last: { result: SyncResult; windows: number } | null = null;
  let roundsRead = 0;
  try {
    const { windows } = await readActivityWindows({
      source: req.source,
      trackId: req.trackId,
      cues: req.cues,
      windowCount: req.windowCount,
      windowSeconds: req.windowSeconds,
      rounds: req.rounds,
      stallTimeoutMs: req.stallTimeoutMs,
      onProgress: (fraction) => post({ type: "progress", fraction }),
      onRound: (sofar, round) => {
        roundsRead = round;
        const previous = (last as { result: SyncResult } | null)?.result;
        const result = alignWithDrift(sofar, req.cues, {
          maxOffset: req.maxOffset,
        });
        last = { result, windows: sofar.length };
        return (
          round < req.rounds &&
          isClearMatch(result, sofar.length, previous ?? null)
        );
      },
    });
    // Reading stops early on a clear match: show the bar complete, not stuck part-way
    post({ type: "progress", fraction: 1 });
    const t1 = performance.now();
    const done = last as { result: SyncResult; windows: number } | null;
    const result =
      done && done.windows === windows.length
        ? done.result
        : alignWithDrift(windows, req.cues, { maxOffset: req.maxOffset });
    post({
      type: "result",
      result,
      timing: {
        readMs: Math.round(t1 - t0),
        alignMs: Math.round(performance.now() - t1),
        rounds: roundsRead,
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
