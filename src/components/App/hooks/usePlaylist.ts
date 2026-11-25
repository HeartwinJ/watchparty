import { useMemo } from "react";
import type { RoomStore } from "../roomState";
import type { PlaylistAddItem, RoomCommands } from "../socketEvents";

/** Playlist actions. The playlist itself lives on the server and arrives via the "playlist" event. */
export function usePlaylist(opts: { store: RoomStore; cmd: RoomCommands }) {
  const { store, cmd } = opts;
  return useMemo(() => {
    const remove = (index: number) => cmd.playlistDelete(index);
    return {
      /** Plays an item now and removes it from the playlist */
      play: (index: number) => {
        const item = store.get().playlist[index];
        if (!item) {
          return;
        }
        cmd.setMedia(item.url);
        if (item.meta) {
          // Queued AIOStreams items keep their metadata (next episode, "Pick another", ...)
          cmd.setVideoMeta(item.url, item.meta);
        }
        remove(index);
      },
      add: (url: string) => cmd.playlistAdd(url),
      /** Adds an item with a readable name (and AIOStreams metadata) */
      addItem: (item: PlaylistAddItem) => cmd.playlistAddItem(item),
      move: (index: number, toIndex: number) =>
        cmd.playlistMove(index, toIndex),
      remove,
    };
  }, [store, cmd]);
}
