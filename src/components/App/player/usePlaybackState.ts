import { useEffect, useState } from "react";
import type { Room } from "../hooks/useRoom";

export interface PlaybackState {
  currentTime: number;
  duration: number;
  buffered: { start: number; end: number }[];
  /** The element is paused (or the room is), so the play button shows "play" */
  paused: boolean;
  muted: boolean;
  volume: number;
  rate: number;
}

const MEDIA_EVENTS = [
  "timeupdate",
  "progress",
  "play",
  "pause",
  "playing",
  "volumechange",
  "ratechange",
  "durationchange",
  "loadedmetadata",
  "seeking",
  "seeked",
  "emptied",
  "ended",
];

/**
 * Live player state for the controls. Subscribes to <video> events; the
 * YouTube iframe has no such events, so it's polled 4× a second while YouTube is the active player.
 */
export function usePlaybackState(room: Room): PlaybackState {
  const { player, state } = room;
  const read = (): PlaybackState => {
    const p = player.current();
    return {
      currentTime: p.getCurrentTime(),
      duration: player.getDuration(),
      buffered: p.getTimeRanges(),
      paused: state.roomPaused || p.shouldPlay(),
      muted: p.isMuted(),
      volume: p.getVolume(),
      rate: p.getPlaybackRate(),
    };
  };
  const [snapshot, setSnapshot] = useState<PlaybackState>(read);
  const usingYoutube = player.usingYoutube();

  useEffect(() => {
    const update = () => setSnapshot(read());
    update();
    if (usingYoutube) {
      const id = window.setInterval(update, 250);
      return () => window.clearInterval(id);
    }
    const video = player.html().getVideoEl();
    if (!video) {
      return;
    }
    MEDIA_EVENTS.forEach((e) => video.addEventListener(e, update));
    return () =>
      MEDIA_EVENTS.forEach((e) => video.removeEventListener(e, update));
    // read() closes over the room; re-subscribe when the source or room pause state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, usingYoutube, state.roomMedia, state.roomPaused, state.loading]);

  return snapshot;
}
