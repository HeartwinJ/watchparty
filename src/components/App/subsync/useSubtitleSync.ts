import { useEffect, useMemo } from "react";
import type { RoomStore } from "../roomState";
import type { RoomCommands } from "../socketEvents";
import type { PlayerApi } from "../hooks/usePlayer";
import type { SubtitlesApi } from "../hooks/useSubtitles";
import type { ShareSession } from "../hooks/useShare";
import { toast } from "../ui/toast";
import {
  autoSyncAvailability,
  describeSyncOutcome,
  subtitleSyncKey,
  syncResultToTiming,
} from "./logic";
import { AutoSyncError, isAutoSyncSupported, runAutoSync } from "./run";
import type { Cue } from "./signal";

/** Fewer cues than this can't be aligned meaningfully */
const MIN_CUES = 5;
/** Room auto-sync: how long to keep waiting for a subtitle's cues to load (1 s polls) */
const CUE_WAIT_TRIES = 20;
/** Room auto-sync: random delay before claiming, so the first viewer ready usually wins without a race */
const CLAIM_JITTER_MS = 1500;
const TOAST_ID = "wp-subsync";

/**
 * Auto subtitle sync on this device (see "Subtitle auto-sync" in components/App/README.md):
 * - `syncNow()`: the wand in the subtitles menu. Aligns the selected track and applies offset + scale in the current
 *   scope (Everyone / Just me) through `subtitles.setTiming`.
 * - Room auto-sync (RoomSettings.autoSyncSubtitles): whenever a subtitle with cues is selected for a direct video,
 *   every viewer that *could* compute it asks the server (CMD:subtitleSync claim) after a short random delay; the
 *   server grants the first claim per (video, subtitle) and denies the rest, so exactly one device does the work. Its
 *   result goes back to the server, which applies it room-wide unless someone set the offset by hand. If that device
 *   fails or leaves, the server releases the job and the others try again.
 * `state.subtitleSyncJob` is this device's job (progress for the menu), `state.subtitleSyncRemote` who else is on it.
 */
export function useSubtitleSync(opts: {
  store: RoomStore;
  player: PlayerApi;
  cmd: RoomCommands;
  clientId: string;
  subtitles: SubtitlesApi;
  share: ShareSession;
  run?: typeof runAutoSync;
  supported?: () => boolean;
}) {
  const { store, player, cmd, clientId, subtitles, share } = opts;
  const run = opts.run ?? runAutoSync;
  const supported = opts.supported ?? isAutoSyncSupported;

  const api = useMemo(() => {
    let job: {
      controller: AbortController;
      auto: boolean;
      video: string;
    } | null = null;
    /** video + key pairs this device already claimed or saw handled */
    const handled = new Set<string>();
    /** Claims sent and not answered yet */
    const pending = new Set<string>();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let claimTimer: ReturnType<typeof setTimeout> | undefined;
    const pairKey = (video: string, key: string) => `${video}\n${key}`;

    const availability = () => {
      const s = store.get();
      return autoSyncAvailability({
        media: s.roomMedia,
        isLiveStream: s.isLiveStream,
        sharedFile: share.isFile ? share.file : undefined,
        supported: supported(),
      });
    };

    /** The selected track, its key and its cues (empty until loaded) */
    const selection = () => {
      const html = player.html();
      const index = html.getSelectedSubtitleTrack();
      if (index < 0) {
        return undefined;
      }
      const info = html.getSubtitleTracks().find((t) => t.index === index);
      if (!info) {
        return undefined;
      }
      return {
        key: subtitleSyncKey(info, store.get().roomSubtitle),
        cues: html.getOriginalCues(index) as Cue[],
      };
    };

    const setJob = (progress: number) => {
      if (!job) {
        return;
      }
      // 5% steps: progress goes through the room store, so keep re-renders few
      const p = Math.floor(progress * 20) / 20;
      const current = store.get().subtitleSyncJob;
      if (!current || current.progress !== p || current.auto !== job.auto) {
        store.set({ subtitleSyncJob: { auto: job.auto, progress: p } });
      }
    };

    const startJob = (auto: boolean, cues: Cue[], source: string | File) => {
      const s = store.get();
      const controller = new AbortController();
      job = { controller, auto, video: s.roomMedia };
      const mine = job;
      setJob(0);
      const promise = run({
        source,
        cues,
        // While converting, listen to the audio track this device plays
        trackId: s.playback?.mode === "convert" ? s.audioTrackId : undefined,
        signal: controller.signal,
        onProgress: (p) => job === mine && setJob(p),
      });
      const finish = () => {
        if (job === mine) {
          job = null;
          store.set({ subtitleSyncJob: null });
        }
      };
      promise.then(finish, finish);
      return promise;
    };

    /** The wand: align the selected track now and apply it in the current scope */
    const syncNow = async () => {
      if (job) {
        return;
      }
      const avail = availability();
      if (!avail.ok) {
        toast(avail.reason, { id: TOAST_ID, tone: "warning" });
        return;
      }
      const sel = selection();
      if (!sel || sel.cues.length < MIN_CUES) {
        toast("Pick a subtitle track first", { id: TOAST_ID });
        return;
      }
      try {
        const result = await startJob(false, sel.cues, avail.source);
        const timing = syncResultToTiming(result);
        if (timing) {
          subtitles.setTiming(timing.offset, timing.scale);
        }
        toast(describeSyncOutcome(timing?.offset ?? null, timing ?? {}), {
          id: TOAST_ID,
          tone: timing ? "success" : "warning",
        });
      } catch (err) {
        if (!(err instanceof AutoSyncError && err.cancelled)) {
          toast(
            err instanceof Error ? err.message : "Couldn't sync subtitles",
            { id: TOAST_ID, tone: "danger" },
          );
        }
      }
    };

    /** Stops this device's job (the menu closing stops a manual one; a new video stops any) */
    const cancel = (which: "manual" | "any" = "any") => {
      if (job && (which === "any" || !job.auto)) {
        job.controller.abort();
      }
    };

    /** Room auto-sync: claim the selected subtitle if this device can compute it and nobody handled it yet */
    const evaluate = (tries = 0) => {
      clearTimeout(retryTimer);
      const s = store.get();
      if (!s.roomSettings.autoSyncSubtitles || !availability().ok) {
        return;
      }
      const sel = selection();
      if (!sel || sel.cues.length < MIN_CUES) {
        // The room subtitle is still downloading/parsing
        if (tries < CUE_WAIT_TRIES) {
          retryTimer = setTimeout(() => evaluate(tries + 1), 1000);
        }
        return;
      }
      const video = s.roomMedia;
      const pk = pairKey(video, sel.key);
      if (handled.has(pk)) {
        return;
      }
      handled.add(pk);
      clearTimeout(claimTimer);
      claimTimer = setTimeout(() => {
        if (store.get().roomMedia !== video) {
          return;
        }
        pending.add(pk);
        cmd.subtitleSync({ action: "claim", video, key: sel.key });
      }, Math.random() * CLAIM_JITTER_MS);
    };

    /** The server granted us the room's auto-sync for (video, key) */
    const runRoomJob = async (video: string, key: string) => {
      const avail = availability();
      const sel = selection();
      if (
        job ||
        !avail.ok ||
        !sel ||
        sel.key !== key ||
        store.get().roomMedia !== video
      ) {
        cmd.subtitleSync({ action: "failed", video, key });
        return;
      }
      try {
        const result = await startJob(true, sel.cues, avail.source);
        const timing = syncResultToTiming(result);
        cmd.subtitleSync({
          action: "result",
          video,
          key,
          offset: timing?.offset ?? null,
          ...(timing && timing.scale !== 1 ? { scale: timing.scale } : {}),
          confidence: result.confidence,
        });
      } catch (err) {
        if (store.get().roomMedia !== video) {
          // The video changed: the server already forgot this job
          return;
        }
        console.warn("[subsync] room auto-sync failed:", err);
        cmd.subtitleSync({ action: "failed", video, key });
      }
    };

    const nameOf = (by: PlaybackActor | undefined) =>
      (by && (store.get().nameMap[by.id] || by.name)) || "Someone";

    /** REC:subtitleSync */
    const onEvent = (e: SubtitleSyncEvent) => {
      if (!e || typeof e.video !== "string" || typeof e.key !== "string") {
        return;
      }
      const pk = pairKey(e.video, e.key);
      const current = e.video === store.get().roomMedia;
      switch (e.status) {
        case "running":
          handled.add(pk);
          if (e.by?.id === clientId) {
            if (pending.delete(pk) && current) {
              runRoomJob(e.video, e.key);
            }
          } else if (current) {
            store.set({ subtitleSyncRemote: { by: nameOf(e.by) } });
          }
          break;
        case "done":
          handled.add(pk);
          pending.delete(pk);
          if (current) {
            store.set({ subtitleSyncRemote: null });
            const mine = e.by?.id === clientId;
            if (mine || (e.offset !== null && e.offset !== undefined)) {
              toast(
                describeSyncOutcome(e.offset ?? null, {
                  auto: true,
                  by: mine ? undefined : nameOf(e.by),
                  scale: e.scale,
                }),
                {
                  id: TOAST_ID,
                  tone: e.offset == null ? "warning" : "success",
                },
              );
            }
          }
          break;
        case "released":
          pending.delete(pk);
          if (current) {
            store.set({ subtitleSyncRemote: null });
            handled.delete(pk);
            evaluate();
          }
          break;
        case "denied":
          pending.delete(pk);
          handled.add(pk);
          break;
      }
    };

    /** REC:host: a new video (or a reconnect) stops any job and forgets what was pending */
    const onVideoChange = () => {
      cancel("any");
      clearTimeout(retryTimer);
      clearTimeout(claimTimer);
      pending.clear();
      store.set({ subtitleSyncRemote: null });
    };

    return {
      syncNow,
      cancel,
      evaluate: () => evaluate(),
      onEvent,
      onVideoChange,
      /** Why the wand is unavailable (its tooltip), or null when it can run */
      unavailableReason: () => {
        const avail = availability();
        return avail.ok ? null : avail.reason;
      },
    };
  }, [store, player, cmd, clientId, subtitles, share, run, supported]);

  useEffect(() => () => api.onVideoChange(), [api]);
  return api;
}

export type SubtitleSyncApi = ReturnType<typeof useSubtitleSync>;
