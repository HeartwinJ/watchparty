import { useMemo } from "react";
import type { RoomStore } from "../roomState";
import type { RoomCommands } from "../socketEvents";
import type { PlayerApi } from "./usePlayer";
import { findSharer } from "../logic/media";
import {
  effectiveOffset,
  normalizeOffset,
  normalizeScale,
  stepOffset,
  type SubtitleScope,
} from "../logic/subtitles";

/**
 * Room subtitles: REC:subtitle, keeping them in sync with a screen sharer, the subtitle modal, and the subtitle timing.
 * The timing is an offset plus a time scale (frame-rate drift; cues show at original × scale + offset). It's
 * room-wide by default ("Everyone": CMD:subtitleOffset / CMD:subtitleTiming, saved per video by the server), or a
 * local override ("Just me") that wins until it's reset. It's applied by re-timing the cues (HTML.ts).
 */
export function useSubtitles(opts: {
  store: RoomStore;
  player: PlayerApi;
  clientId: string;
  cmd: RoomCommands;
}) {
  const { store, player, clientId, cmd } = opts;
  return useMemo(() => {
    /** The timing in effect on this device: the "Just me" override, else the room's */
    const getTiming = () => {
      const s = store.get();
      return s.localSubtitleOffset !== null
        ? {
            offset: s.localSubtitleOffset,
            scale: s.localSubtitleScale ?? 1,
          }
        : { offset: s.roomSubtitleOffset, scale: s.roomSubtitleScale };
    };

    /** Applies the effective timing to the player */
    const applyOffset = () => {
      const { offset, scale } = getTiming();
      player.html().setSubtitleOffset(offset, scale);
    };

    const getOffset = () => {
      const { roomSubtitleOffset, localSubtitleOffset } = store.get();
      return effectiveOffset(roomSubtitleOffset, localSubtitleOffset);
    };

    /** Sets the offset in the current scope, keeping the time scale (±0.1 s nudges, typing, the slider) */
    const setOffset = (value: number) => {
      const offset = normalizeOffset(value);
      if (store.get().subtitleScope === "me") {
        store.set({
          localSubtitleOffset: offset,
          localSubtitleScale: getTiming().scale,
        });
      } else {
        store.set({ roomSubtitleOffset: offset });
        cmd.setSubtitleOffset(offset);
      }
      applyOffset();
      return offset;
    };

    /**
     * Sets offset and time scale together in the current scope (auto-sync results, Reset). `auto`: an auto-sync wand
     * result, so the room's chat line says it was auto-synced.
     */
    const setTiming = (
      offsetValue: number,
      scaleValue: number,
      opts: { auto?: boolean } = {},
    ) => {
      const offset = normalizeOffset(offsetValue);
      const scale = normalizeScale(scaleValue);
      if (store.get().subtitleScope === "me") {
        store.set({ localSubtitleOffset: offset, localSubtitleScale: scale });
      } else {
        store.set({ roomSubtitleOffset: offset, roomSubtitleScale: scale });
        cmd.setSubtitleTiming({
          offset,
          scale,
          ...(opts.auto ? { auto: true } : {}),
        });
      }
      applyOffset();
      return { offset, scale };
    };

    return {
      onSubtitle: (url: string) => {
        store.set({ roomSubtitle: url });
        player.current().loadSubtitles(url);
      },
      /** When someone else shares their screen, follow their subtitle timing (called on every REC:tsMap) */
      syncToSharer: () => {
        const { roomSubtitle, participants, tsMap } = store.get();
        if (!roomSubtitle) {
          return;
        }
        const sharer = findSharer(participants);
        if (sharer && sharer.id !== clientId) {
          player.current().syncSubtitles(tsMap[sharer.id]);
        }
      },
      /** Opens the OpenSubtitles API (file name) search / URL modal (native player only) */
      openModal: () => {
        if (player.usingNative()) {
          store.set({ isSubtitleModalOpen: true, isSubtitleSearchOpen: false });
        }
      },
      /** Opens "Search subtitles…" (keyless title search; not for YouTube) */
      openSearch: () => {
        if (!player.usingYoutube()) {
          store.set({ isSubtitleSearchOpen: true });
        }
      },
      getOffset,
      getTiming,
      setOffset,
      setTiming,
      /** `[` / `]` and the ±0.1 buttons (the time scale stays) */
      nudgeOffset: (delta: number) => setOffset(stepOffset(getOffset(), delta)),
      /** Reset: "Everyone" sets the room timing to offset 0, scale 1; "Just me" drops the override */
      resetOffset: () => {
        if (store.get().subtitleScope === "me") {
          store.set({ localSubtitleOffset: null, localSubtitleScale: null });
          applyOffset();
        } else {
          setTiming(0, 1);
        }
      },
      setScope: (subtitleScope: SubtitleScope) => {
        const s = store.get();
        if (subtitleScope === s.subtitleScope) {
          return;
        }
        const me = subtitleScope === "me";
        store.set({
          subtitleScope,
          // "Just me" starts from what's showing now; back to "Everyone" follows the room again
          localSubtitleOffset: me ? s.roomSubtitleOffset : null,
          localSubtitleScale: me ? s.roomSubtitleScale : null,
        });
        applyOffset();
      },
      /** REC:host: a new video brings its saved room timing and drops any local override */
      onHostOffset: (offset: number | undefined, scale?: number) => {
        store.set({
          roomSubtitleOffset: normalizeOffset(offset ?? 0),
          roomSubtitleScale: normalizeScale(scale ?? 1),
          localSubtitleOffset: null,
          localSubtitleScale: null,
          subtitleScope: "everyone",
        });
        applyOffset();
      },
      /** REC:subtitleOffset from someone else (or the room's auto-sync); older servers send no scale */
      onRemoteOffset: (offset: number, scale?: number) => {
        store.set({
          roomSubtitleOffset: normalizeOffset(offset),
          roomSubtitleScale: normalizeScale(
            scale ?? store.get().roomSubtitleScale,
          ),
        });
        applyOffset();
      },
      applyOffset,
    };
  }, [store, player, clientId, cmd]);
}

export type SubtitlesApi = ReturnType<typeof useSubtitles>;
