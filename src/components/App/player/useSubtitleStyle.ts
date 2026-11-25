import { useCallback, useState } from "react";
import type { SubtitleBackground, SubtitleSize } from "../logic/subtitles";

const KEY = "wp-subtitle-style";

export interface SubtitleStyle {
  size: SubtitleSize;
  background: SubtitleBackground;
}

const DEFAULT: SubtitleStyle = { size: "m", background: "shadow" };

function load(): SubtitleStyle {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    return {
      size: ["s", "m", "l", "xl"].includes(raw?.size) ? raw.size : DEFAULT.size,
      background: ["none", "shadow", "box"].includes(raw?.background)
        ? raw.background
        : DEFAULT.background,
    };
  } catch {
    return DEFAULT;
  }
}

/** Subtitle size/background, remembered per device (localStorage) */
export function useSubtitleStyle() {
  const [style, setStyle] = useState<SubtitleStyle>(load);
  const update = useCallback((patch: Partial<SubtitleStyle>) => {
    setStyle((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable (private mode): the style just won't persist
      }
      return next;
    });
  }, []);
  return [style, update] as const;
}
