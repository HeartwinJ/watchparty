import { useEffect, useRef } from "react";
import type { Room } from "../hooks/useRoom";
import { useRoomUi } from "../ui/RoomUi";
import { toast } from "../ui/toast";
import {
  OFFER_RESEND_MS,
  nextEpisodeNotice,
  nextEpisodeOffset,
  shouldOfferNextEpisode,
} from "./logic";

/**
 * Client half of the next-episode card: tells the server when this player is near the end of an episode, and shows
 * the room-wide outcomes (cancelled by someone, starting, couldn't find it) as toasts + the player's OSD.
 */
export function useNextEpisode(room: Room) {
  const { store, player, cmd, clientId } = room;
  const { roomMedia, videoMeta, nextEpisode } = room.state;
  const ui = useRoomUi();
  const uiRef = useRef(ui);
  uiRef.current = ui;

  // Report "near the end" once a second while an episode plays (the server keeps the first offer per video)
  const hasEpisode = Boolean(videoMeta && videoMeta.episode !== null);
  useEffect(() => {
    if (!roomMedia || !hasEpisode) {
      return;
    }
    let lastSent = 0;
    const id = window.setInterval(() => {
      const s = store.get();
      if (s.roomMedia !== roomMedia || player.usingYoutube()) {
        return;
      }
      const p = player.current();
      const offer = shouldOfferNextEpisode({
        videoMeta: s.videoMeta,
        playlistLength: s.playlist.length,
        loop: s.roomLoop,
        nextState: s.nextEpisode.state,
        currentTime: p.getCurrentTime(),
        duration: p.getDuration(),
        offset: nextEpisodeOffset(s),
      });
      const now = Date.now();
      if (offer && now - lastSent >= OFFER_RESEND_MS) {
        lastSent = now;
        cmd.nextEpisode({
          action: "offer",
          url: roomMedia,
          time: p.getCurrentTime(),
          duration: p.getDuration(),
        });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [roomMedia, hasEpisode, store, player, cmd]);

  // Room-wide outcomes (once per event; not for an event that arrived before this mounted)
  const seenAt = useRef(nextEpisode.at);
  useEffect(() => {
    const s = store.get().nextEpisode;
    if (s.at === seenAt.current) {
      return;
    }
    seenAt.current = s.at;
    const text = nextEpisodeNotice(s, {
      clientId,
      nameMap: store.get().nameMap,
    });
    if (!text) {
      return;
    }
    // Toasts aren't visible in fullscreen, so the player's on-screen display says it too
    store.set({ playerNotice: { text, at: Date.now() } });
    if (s.state === "failed") {
      const next = s.next;
      toast(text, {
        id: "wp-next-episode",
        tone: "warning",
        action: {
          label: "Open picker",
          onClick: () =>
            next
              ? uiRef.current.openPickerAt({
                  kind: "streams",
                  videoMeta: next.meta,
                })
              : uiRef.current.openPicker(),
        },
      });
    } else {
      toast(text, { id: "wp-next-episode" });
    }
    // Runs once per REC:nextEpisode (`at` changes on every event)
  }, [nextEpisode.at, store, clientId]);

  return {
    offered: nextEpisode.state === "offered" && roomMedia ? nextEpisode : null,
    playNow: () => cmd.nextEpisode({ action: "playNow" }),
    cancel: () => cmd.nextEpisode({ action: "cancel" }),
  };
}
