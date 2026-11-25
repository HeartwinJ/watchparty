import { useEffect, useState } from "react";
import type { Room } from "../hooks/useRoom";
import type { SubtitleTrackInfo } from "../HTML";

/**
 * The <video>'s subtitle tracks and which one is showing, kept current via TextTrackList events (tracks are added by
 * the room subtitle, hls.js/dash.js, or the media itself). Also returns the active TextTrack for the cue renderer.
 */
export function useTextTracks(room: Room) {
  const html = room.player.html();
  const read = () => ({
    tracks: html.getSubtitleTracks(),
    selected: html.getSelectedSubtitleTrack(),
    active: html.getActiveSubtitleTrack(),
  });
  const [value, setValue] = useState(read);
  useEffect(() => {
    const list = html.getVideoEl()?.textTracks;
    const update = () => setValue(read());
    update();
    if (!list) {
      return;
    }
    list.addEventListener("addtrack", update);
    list.addEventListener("removetrack", update);
    // Fires whenever a track's mode changes (we switch modes when selecting)
    list.addEventListener("change", update);
    return () => {
      list.removeEventListener("addtrack", update);
      list.removeEventListener("removetrack", update);
      list.removeEventListener("change", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, room.state.roomMedia, room.state.roomSubtitle]);
  return { ...value, refresh: () => setValue(read()) };
}

export type { SubtitleTrackInfo };
