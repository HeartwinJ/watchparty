import { useMemo } from "react";
import type { RoomStore } from "../roomState";
import type { RoomCommands } from "../socketEvents";

/** Playlist actions. The playlist itself lives on the server and arrives via the "playlist" event. */
export function usePlaylist(opts: { store: RoomStore; cmd: RoomCommands }) {
  const { store, cmd } = opts;
  return useMemo(() => {
    const remove = (index: number) => cmd.playlistDelete(index);
    return {
      /** Plays an item now and removes it from the playlist */
      play: (index: number) => {
        cmd.setMedia(store.get().playlist[index]?.url);
        remove(index);
      },
      add: (url: string) => cmd.playlistAdd(url),
      move: (index: number, toIndex: number) =>
        cmd.playlistMove(index, toIndex),
      remove,
    };
  }, [store, cmd]);
}
