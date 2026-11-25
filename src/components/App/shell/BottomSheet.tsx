import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  dragSheetHeight,
  settleSheet,
  SHEET_TAP_SLOP,
  sheetHeights,
  tapSheet,
  type SheetHeights,
  type SheetSnap,
} from "./sheet";
import styles from "./Shell.module.css";

const PHONE_TOPBAR_H = 48;

export interface BottomSheetState {
  snap: SheetSnap;
  setSnap: (snap: SheetSnap) => void;
  dragging: boolean;
  style: React.CSSProperties;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  onHandleKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * The phone bottom sheet's snap point and drag handling. `dockedEdgeRef` is the element the docked
 * sheet starts under (the now-playing strip).
 */
export function useBottomSheet(opts: {
  enabled: boolean;
  dockedEdgeRef: React.RefObject<HTMLElement | null>;
}): BottomSheetState {
  const { enabled, dockedEdgeRef } = opts;
  const [snap, setSnap] = useState<SheetSnap>("docked");
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [heights, setHeights] = useState<SheetHeights>(() => measure(null));
  const heightsRef = useRef(heights);
  heightsRef.current = heights;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const update = () => setHeights(measure(dockedEdgeRef.current));
    update();
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (dockedEdgeRef.current) {
      observer?.observe(dockedEdgeRef.current);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [enabled, dockedEdgeRef]);

  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) {
      return;
    }
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const startY = e.clientY;
    const startHeight = heightsRef.current[snapRef.current];
    let moved = false;
    let lastY = startY;
    let lastT = performance.now();
    let velocity = 0;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < SHEET_TAP_SLOP) {
        return;
      }
      moved = true;
      const now = performance.now();
      const dt = now - lastT;
      if (dt > 0) {
        velocity = 0.8 * ((ev.clientY - lastY) / dt) + 0.2 * velocity;
      }
      lastY = ev.clientY;
      lastT = now;
      setDragHeight(dragSheetHeight(startHeight, dy, heightsRef.current));
    };
    const onUp = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      if (!moved) {
        setSnap(tapSheet(snapRef.current));
      } else {
        // A drag that paused before release isn't a flick
        const stale = performance.now() - lastT > 120;
        setSnap(
          settleSheet({
            from: snapRef.current,
            height: dragSheetHeight(
              startHeight,
              ev.clientY - startY,
              heightsRef.current,
            ),
            velocity: stale ? 0 : velocity,
            heights: heightsRef.current,
          }),
        );
      }
      setDragHeight(null);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }, []);

  const onHandleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const order: SheetSnap[] = ["min", "docked", "full"];
    const i = order.indexOf(snapRef.current);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSnap(order[Math.min(2, i + 1)]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSnap(order[Math.max(0, i - 1)]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSnap(tapSheet(snapRef.current));
    }
  }, []);

  return {
    snap,
    setSnap,
    dragging: dragHeight !== null,
    style: { height: dragHeight ?? heights[snap] },
    onHandlePointerDown,
    onHandleKeyDown,
  };
}

function measure(edge: HTMLElement | null): SheetHeights {
  const viewportHeight =
    typeof window === "undefined" ? 844 : window.innerHeight;
  const dockedTop = edge
    ? edge.getBoundingClientRect().bottom
    : PHONE_TOPBAR_H + (window.innerWidth * 9) / 16;
  return sheetHeights({
    viewportHeight,
    dockedTop,
    topbarHeight: PHONE_TOPBAR_H,
  });
}

const SNAP_LABEL: Record<SheetSnap, string> = {
  min: "minimised",
  docked: "docked",
  full: "expanded",
};

/** The grab bar at the top of the sheet: drag between snap points, tap to toggle docked/full. */
export const BottomSheetHandle = ({ sheet }: { sheet: BottomSheetState }) => (
  <div
    role="button"
    tabIndex={0}
    aria-label={`Resize panel (${SNAP_LABEL[sheet.snap]}). Tap to ${
      sheet.snap === "docked" ? "expand" : "dock"
    }, or use the up and down arrow keys.`}
    className={styles.sheetHandle}
    onPointerDown={sheet.onHandlePointerDown}
    onKeyDown={sheet.onHandleKeyDown}
  />
);
