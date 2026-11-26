import React, { useEffect, useRef } from "react";
import { SUBTITLE_SIZE_SCALE, cuesAt } from "../logic/subtitles";
import type { SubtitleStyle } from "./useSubtitleStyle";
import styles from "./Player.module.css";

/**
 * Renders the active cues of the selected TextTrack (kept in "hidden" mode, see HTML.ts) so size and background follow
 * the player's style and the text moves up while the controls show. Cue markup comes from getCueAsHTML(), which only
 * produces WebVTT's inline elements (no script), and is inserted as DOM nodes.
 *
 * What's shown is worked out from the cue list and the video's current time (cuesAt), not TextTrack.activeCues:
 * browsers can leave cues whose times were changed in place (the subtitle offset) in activeCues after they end, which
 * made passed lines stay on screen above the current one. Re-rendered on cuechange, timeupdate and seeked, and only
 * when the set of lines actually changes.
 */
export function SubtitleCues(props: {
  track: TextTrack | undefined;
  /** The <video> the track belongs to (for its current time) */
  getMedia: () => HTMLMediaElement | null | undefined;
  style: SubtitleStyle;
  /** Lift above the control bar while it's visible */
  lift: boolean;
}) {
  const { track, getMedia } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = ref.current;
    if (!box) {
      return;
    }
    const media = getMedia();
    let shown: TextTrackCue[] = [];
    const render = () => {
      const cues = media
        ? cuesAt(track?.cues, media.currentTime)
        : Array.from(track?.activeCues ?? []);
      if (
        cues.length === shown.length &&
        cues.every((c, i) => c === shown[i])
      ) {
        return;
      }
      shown = cues;
      box.replaceChildren(
        ...cues.map((cue) => {
          const line = document.createElement("div");
          line.className = styles.cue;
          const vtt = cue as VTTCue;
          if (typeof vtt.getCueAsHTML === "function") {
            line.append(vtt.getCueAsHTML());
          } else {
            line.textContent = (vtt as { text?: string }).text ?? "";
          }
          return line;
        }),
      );
    };
    render();
    if (!track) {
      return;
    }
    track.addEventListener("cuechange", render);
    // cuechange alone isn't enough when activeCues goes stale; the time events catch every cue end
    media?.addEventListener("timeupdate", render);
    media?.addEventListener("seeked", render);
    return () => {
      track.removeEventListener("cuechange", render);
      media?.removeEventListener("timeupdate", render);
      media?.removeEventListener("seeked", render);
      box.replaceChildren();
    };
  }, [track, getMedia]);

  return (
    <div
      ref={ref}
      className={styles.cues}
      data-bg={props.style.background}
      data-lift={props.lift}
      style={
        {
          "--wp-sub-scale": SUBTITLE_SIZE_SCALE[props.style.size],
        } as React.CSSProperties
      }
      aria-live="off"
    />
  );
}
