import React, { useEffect, useRef } from "react";
import { SUBTITLE_SIZE_SCALE } from "../logic/subtitles";
import type { SubtitleStyle } from "./useSubtitleStyle";
import styles from "./Player.module.css";

/**
 * Renders the active cues of the selected TextTrack (kept in "hidden" mode, see HTML.ts) so size and background follow
 * the player's style and the text moves up while the controls show. Cue markup comes from getCueAsHTML(), which only
 * produces WebVTT's inline elements (no script), and is inserted as DOM nodes.
 */
export function SubtitleCues(props: {
  track: TextTrack | undefined;
  style: SubtitleStyle;
  /** Lift above the control bar while it's visible */
  lift: boolean;
}) {
  const { track } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = ref.current;
    if (!box) {
      return;
    }
    const render = () => {
      const cues = Array.from(track?.activeCues ?? []);
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
    return () => {
      track.removeEventListener("cuechange", render);
      box.replaceChildren();
    };
  }, [track]);

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
