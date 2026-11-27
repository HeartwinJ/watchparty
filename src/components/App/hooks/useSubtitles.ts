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
import {
  CARRY_MS,
  captureCarry,
  pickCarry,
  sameShow,
  type SubtitleCarry,
} from "../logic/subtitleCarry";

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
    /** This device's subtitles from before the last video change, kept on (or off) for the next one */
    let carry: SubtitleCarry | null = null;
    /** REC:videoMeta arrived since the video changed (until then store.videoMeta is the old video's) */
    let metaSeen = false;

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
        if (url && url === store.get().roomSubtitle && !player.usingYoutube()) {
          // The same subtitle again (e.g. several viewers kept it on for the next episode): no reload, just show it
          const html = player.html();
          const loaded = html.getSubtitleTracks().find((t) => t.fromRoom);
          if (loaded) {
            html.selectSubtitleTrack(loaded.index);
            return;
          }
        }
        store.set({ roomSubtitle: url });
        player.current().loadSubtitles(url);
      },
      /**
       * REC:host, before the old video is cleared: remember whether this device was showing subtitles, and in which
       * language, so the next episode gets them too (applyCarry). Not when joining.
       */
      captureCarry: () => {
        metaSeen = false;
        const s = store.get();
        const html = player.html();
        carry =
          s.roomMedia && !player.usingYoutube()
            ? captureCarry({
                selected: html.getSelectedSubtitleTrack(),
                tracks: html.getSubtitleTracks(),
                roomSubtitle: s.roomSubtitle,
                autoTracks:
                  s.subtitleTracksFor === s.videoMeta?.id
                    ? s.subtitleTracks
                    : undefined,
                meta: s.videoMeta,
                now: Date.now(),
              })
            : null;
      },
      /** REC:videoMeta: the new video's metadata is known */
      onVideoMeta: () => {
        metaSeen = true;
      },
      /** Applies a carried choice once the new video's subtitles are known (called as tracks and state change) */
      applyCarry: () => {
        if (!carry || !metaSeen) {
          return;
        }
        if (Date.now() - carry.at > CARRY_MS || player.usingYoutube()) {
          carry = null;
          return;
        }
        const s = store.get();
        const meta = s.videoMeta;
        if (!sameShow(carry.prevMeta, meta)) {
          // A pick sends the stream first and its metadata right after: wait for it
          if (!meta) {
            return;
          }
          carry = null;
          return;
        }
        const html = player.html();
        const selected = html.getSelectedSubtitleTrack();
        if (carry.on && selected >= 0) {
          // Something is showing already (e.g. someone else's pick of the room subtitle)
          carry = null;
          return;
        }
        const pick = pickCarry(carry, {
          selected,
          tracks: html.getSubtitleTracks(),
          roomSubtitle: s.roomSubtitle,
          autoTracks: !meta
            ? []
            : s.subtitleTracksFor === meta.id
              ? s.subtitleTracks
              : undefined,
          mediaReady: !s.loading,
        });
        if (!pick) {
          return;
        }
        carry = null;
        if (pick.action === "room") {
          cmd.setSubtitle(pick.url);
        } else if (pick.action === "track") {
          html.selectSubtitleTrack(pick.index);
        } else {
          html.selectSubtitleTrack(-1);
        }
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
