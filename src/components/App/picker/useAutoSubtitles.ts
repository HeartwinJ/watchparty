import { useEffect } from "react";
import { getSubtitles, type Subtitle } from "../../../api/addons";
import type { RoomStore, SubtitleTrackOption } from "../roomState";

const MAX_TRACKS = 30;

export function toSubtitleTracks(subs: Subtitle[]): SubtitleTrackOption[] {
  return subs.slice(0, MAX_TRACKS).map((s) => ({
    id: `auto-${s.id}`,
    label: s.label,
    lang: s.lang,
    url: s.url,
    detail: "OpenSubtitles",
    source: "auto",
  }));
}

/**
 * Auto subtitles: when the room's video has AIOStreams metadata, list the title's subtitles
 * (/addon/subtitles, OpenSubtitles v3) in the player's subtitle menu (`state.subtitleTracks`). Cleared otherwise.
 */
export function useAutoSubtitles(
  videoMeta: VideoMeta | null,
  store: Pick<RoomStore, "set">,
) {
  const type = videoMeta?.type;
  const id = videoMeta?.id;
  useEffect(() => {
    store.set({ subtitleTracks: undefined });
    if (!type || !id) {
      return;
    }
    const controller = new AbortController();
    getSubtitles(type, id, controller.signal).then(
      (subs) => {
        if (!controller.signal.aborted) {
          store.set({ subtitleTracks: toSubtitleTracks(subs) });
        }
      },
      () => {
        // No subtitles is fine; the manual options still work
      },
    );
    return () => controller.abort();
  }, [type, id, store]);
}
