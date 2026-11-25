import { useMemo } from "react";
import type { RoomStore } from "../roomState";
import type { PlayerApi } from "./usePlayer";
import { findSharer } from "../logic/media";

/** Room subtitles: REC:subtitle, keeping them in sync with a screen sharer, and the subtitle modal. */
export function useSubtitles(opts: {
  store: RoomStore;
  player: PlayerApi;
  clientId: string;
}) {
  const { store, player, clientId } = opts;
  return useMemo(
    () => ({
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
      /** Only the native player uses the subtitle modal */
      openModal: () => {
        if (player.usingNative()) {
          store.set({ isSubtitleModalOpen: true });
        }
      },
    }),
    [store, player, clientId],
  );
}
