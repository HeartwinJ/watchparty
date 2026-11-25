import React, { useCallback, useRef, useState } from "react";
import { useViewportSize } from "@mantine/hooks";
import {
  clampSidebarWidth,
  dragSidebarWidth,
  effectiveSidebarWidth,
  readSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_STEP,
  writeSidebarWidth,
} from "./sidebarWidth";
import styles from "./Shell.module.css";

export interface SidebarWidthState {
  /** Width in use (the remembered width, shrunk on narrow viewports) */
  width: number;
  resizing: boolean;
  setWidth: (width: number) => void;
  startResize: (e: React.PointerEvent) => void;
}

/** The desktop sidebar's width (remembered per device) and pointer-drag resizing. */
export function useSidebarWidth(): SidebarWidthState {
  const [stored, setWidthState] = useState(() => readSidebarWidth());
  const [resizing, setResizing] = useState(false);
  const { width: viewportWidth } = useViewportSize();
  const width = viewportWidth
    ? effectiveSidebarWidth(stored, viewportWidth)
    : stored;
  const widthRef = useRef(width);
  widthRef.current = width;

  const setWidth = useCallback((next: number) => {
    setWidthState(writeSidebarWidth(next));
  }, []);

  const startResize = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startWidth = widthRef.current;
    let latest = startWidth;
    let moved = false;
    target.setPointerCapture?.(e.pointerId);
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      moved = true;
      latest = dragSidebarWidth(startWidth, startX, ev.clientX);
      setWidthState(latest);
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      setResizing(false);
      if (moved) {
        setWidthState(writeSidebarWidth(latest));
      }
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }, []);

  return { width, resizing, setWidth, startResize };
}

/** The drag handle on the sidebar's left edge. Also keyboard-operable (arrows, Home/End) as a separator. */
export const SidebarResizeHandle = ({
  sidebar,
  hidden,
}: {
  sidebar: SidebarWidthState;
  hidden?: boolean;
}) => {
  if (hidden) {
    return null;
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowLeft: sidebar.width + SIDEBAR_STEP,
      ArrowRight: sidebar.width - SIDEBAR_STEP,
      Home: SIDEBAR_MAX,
      End: SIDEBAR_MIN,
    };
    if (e.key in keys) {
      e.preventDefault();
      sidebar.setWidth(clampSidebarWidth(keys[e.key]));
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={sidebar.width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className={styles.resizeHandle}
      data-active={sidebar.resizing || undefined}
      onPointerDown={sidebar.startResize}
      onDoubleClick={() => sidebar.setWidth(SIDEBAR_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
};
