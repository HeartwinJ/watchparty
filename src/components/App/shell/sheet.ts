// Phone bottom sheet (Chat / Queue / People): snap points and drag logic. Pure, tested.

export type SheetSnap = "min" | "docked" | "full";

export interface SheetHeights {
  min: number;
  docked: number;
  full: number;
}

/** Tabs only */
export const SHEET_MIN_HEIGHT = 100;
/** The full sheet leaves this much of the video visible under the top bar */
export const SHEET_FULL_GAP = 64;
/** A flick faster than this (px/ms) moves one snap point in its direction regardless of distance */
export const SHEET_FLICK_VELOCITY = 0.5;
/** Pointer movement below this (px) counts as a tap on the handle */
export const SHEET_TAP_SLOP = 6;

const ORDER: SheetSnap[] = ["min", "docked", "full"];

/**
 * Heights of each snap point.
 * - min: the tabs only
 * - docked: fills the space under the now-playing strip (`dockedTop` = its bottom edge)
 * - full: up to SHEET_FULL_GAP below the top bar
 * Docked is kept between min and full on very short screens.
 */
export function sheetHeights(opts: {
  viewportHeight: number;
  dockedTop: number;
  topbarHeight: number;
}): SheetHeights {
  const full = Math.max(
    SHEET_MIN_HEIGHT,
    opts.viewportHeight - opts.topbarHeight - SHEET_FULL_GAP,
  );
  const docked = Math.min(
    full,
    Math.max(SHEET_MIN_HEIGHT, opts.viewportHeight - opts.dockedTop),
  );
  return { min: SHEET_MIN_HEIGHT, docked, full };
}

/** Height while dragging: dragging up (negative dy) grows the sheet, clamped to [min, full]. */
export function dragSheetHeight(
  startHeight: number,
  dy: number,
  heights: SheetHeights,
): number {
  return Math.min(heights.full, Math.max(heights.min, startHeight - dy));
}

/**
 * Where the sheet settles after a drag. A quick flick (velocity in px/ms, negative = upwards) moves
 * one step from where the drag started; otherwise it snaps to the nearest point.
 */
export function settleSheet(opts: {
  from: SheetSnap;
  height: number;
  velocity: number;
  heights: SheetHeights;
}): SheetSnap {
  const { from, height, velocity, heights } = opts;
  if (Math.abs(velocity) >= SHEET_FLICK_VELOCITY) {
    const i = ORDER.indexOf(from);
    const next = velocity < 0 ? Math.min(2, i + 1) : Math.max(0, i - 1);
    return ORDER[next];
  }
  let best: SheetSnap = "docked";
  let bestDist = Infinity;
  for (const snap of ORDER) {
    const dist = Math.abs(heights[snap] - height);
    if (dist < bestDist) {
      best = snap;
      bestDist = dist;
    }
  }
  return best;
}

/** Tapping the handle: docked <-> full, and min opens to docked. */
export function tapSheet(from: SheetSnap): SheetSnap {
  return from === "docked" ? "full" : "docked";
}
