// Auto subtitle sync, main-thread side: starts the worker (worker.ts), relays progress, cancels by terminating it.
import type { Cue, SyncResult } from "./signal";

/** How much audio to listen to: 4 windows × 90 s (≈ 6 min of the video, spread over the dialogue) */
export const AUTO_SYNC_WINDOWS = 4;
export const AUTO_SYNC_WINDOW_SECONDS = 90;
/** Search ±10 min */
export const AUTO_SYNC_MAX_OFFSET = 600;
/** Fail when no audio arrived for this long */
export const AUTO_SYNC_STALL_MS = 20_000;

export interface SyncRequest {
  source: string | File;
  trackId?: number;
  cues: Cue[];
  windowCount: number;
  windowSeconds: number;
  maxOffset: number;
  stallTimeoutMs: number;
}

export type SyncWorkerMessage =
  | { type: "progress"; fraction: number }
  | {
      type: "result";
      result: SyncResult;
      timing: { readMs: number; alignMs: number };
    }
  | { type: "error"; message: string };

export interface AutoSyncOptions {
  source: string | File;
  cues: Cue[];
  trackId?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  windowCount?: number;
  windowSeconds?: number;
  maxOffset?: number;
}

/** Thrown for anything that isn't a (possibly unconfident) result: unreadable video, no decoder, cancelled */
export class AutoSyncError extends Error {
  readonly cancelled: boolean;
  constructor(message: string, cancelled = false) {
    super(message);
    this.cancelled = cancelled;
  }
}

/** Minimal Worker surface, so tests can pass a fake */
export interface SyncWorker {
  postMessage(msg: SyncRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<SyncWorkerMessage>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export const createSyncWorker = (): SyncWorker =>
  new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "subtitle-sync",
  }) as SyncWorker;

/** Whether this browser can run auto-sync at all (a worker with WebCodecs audio decoding) */
export const isAutoSyncSupported = () =>
  typeof Worker !== "undefined" && typeof AudioDecoder !== "undefined";

/**
 * Aligns the cues to the media's audio in a worker. Resolves with the result (offset null = not confident); rejects
 * with AutoSyncError when the audio can't be read or the signal aborts.
 */
export function runAutoSync(
  opts: AutoSyncOptions,
  createWorker: () => SyncWorker = createSyncWorker,
): Promise<SyncResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AutoSyncError("Cancelled", true));
      return;
    }
    const worker = createWorker();
    const done = () => {
      worker.terminate();
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      done();
      reject(new AutoSyncError("Cancelled", true));
    };
    opts.signal?.addEventListener("abort", onAbort);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        opts.onProgress?.(msg.fraction);
      } else if (msg.type === "result") {
        done();
        // Never log the source: AIOStreams playback URLs carry a credential
        console.info(
          "[subsync] offset %s (candidate %s, confidence %s, z %s) read %d ms, align %d ms",
          msg.result.offset,
          msg.result.candidate,
          msg.result.confidence.toFixed(2),
          msg.result.peakZ.toFixed(1),
          msg.timing.readMs,
          msg.timing.alignMs,
        );
        resolve(msg.result);
      } else {
        done();
        reject(new AutoSyncError(msg.message));
      }
    };
    worker.onerror = () => {
      done();
      reject(new AutoSyncError("Subtitle sync stopped unexpectedly"));
    };
    worker.postMessage({
      source: opts.source,
      trackId: opts.trackId,
      cues: opts.cues,
      windowCount: opts.windowCount ?? AUTO_SYNC_WINDOWS,
      windowSeconds: opts.windowSeconds ?? AUTO_SYNC_WINDOW_SECONDS,
      maxOffset: opts.maxOffset ?? AUTO_SYNC_MAX_OFFSET,
      stallTimeoutMs: AUTO_SYNC_STALL_MS,
    });
  });
}
