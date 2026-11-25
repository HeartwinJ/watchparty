import { useMemo } from "react";
import type { RoomStore } from "../roomState";
import type { RoomCommands } from "../socketEvents";
import type { PlayerApi } from "./usePlayer";
import { findSharer } from "../logic/media";
import {
  effectiveOffset,
  normalizeOffset,
  stepOffset,
  type SubtitleScope,
} from "../logic/subtitles";

/**
 * Room subtitles: REC:subtitle, keeping them in sync with a screen sharer, the subtitle modal, and the subtitle offset
 * (PLAN 6b). The offset is room-wide by default ("Everyone": CMD:subtitleOffset, saved per video by the server), or a
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
    /** Applies the effective offset to the player */
    const applyOffset = () => {
      const { roomSubtitleOffset, localSubtitleOffset } = store.get();
      player
        .html()
        .setSubtitleOffset(
          effectiveOffset(roomSubtitleOffset, localSubtitleOffset),
        );
    };

    const getOffset = () => {
      const { roomSubtitleOffset, localSubtitleOffset } = store.get();
      return effectiveOffset(roomSubtitleOffset, localSubtitleOffset);
    };

    /** Sets the offset in the current scope */
    const setOffset = (value: number) => {
      const offset = normalizeOffset(value);
      if (store.get().subtitleScope === "me") {
        store.set({ localSubtitleOffset: offset });
      } else {
        store.set({ roomSubtitleOffset: offset });
        cmd.setSubtitleOffset(offset);
      }
      applyOffset();
      return offset;
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
      /** Opens the OpenSubtitles search / URL modal (native player only) */
      openModal: () => {
        if (player.usingNative()) {
          store.set({ isSubtitleModalOpen: true });
        }
      },
      getOffset,
      setOffset,
      /** `[` / `]` and the ±0.1 buttons */
      nudgeOffset: (delta: number) => setOffset(stepOffset(getOffset(), delta)),
      /** Reset: "Everyone" sets the room offset to 0; "Just me" drops the override */
      resetOffset: () => {
        if (store.get().subtitleScope === "me") {
          store.set({ localSubtitleOffset: null });
          applyOffset();
        } else {
          setOffset(0);
        }
      },
      setScope: (subtitleScope: SubtitleScope) => {
        const s = store.get();
        if (subtitleScope === s.subtitleScope) {
          return;
        }
        store.set({
          subtitleScope,
          // "Just me" starts from what's showing now; back to "Everyone" follows the room again
          localSubtitleOffset:
            subtitleScope === "me" ? s.roomSubtitleOffset : null,
        });
        applyOffset();
      },
      /** REC:host: a new video brings its saved room offset and drops any local override */
      onHostOffset: (offset: number | undefined) => {
        store.set({
          roomSubtitleOffset: normalizeOffset(offset ?? 0),
          localSubtitleOffset: null,
          subtitleScope: "everyone",
        });
        applyOffset();
      },
      /** REC:subtitleOffset from someone else */
      onRemoteOffset: (offset: number) => {
        store.set({ roomSubtitleOffset: normalizeOffset(offset) });
        applyOffset();
      },
      applyOffset,
    };
  }, [store, player, clientId, cmd]);
}

export type SubtitlesApi = ReturnType<typeof useSubtitles>;
