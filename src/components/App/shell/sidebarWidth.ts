// Desktop sidebar width: clamped, remembered per device. Pure helpers (tested) plus storage access.

export const SIDEBAR_MIN = 280;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_DEFAULT = 360;
/** Arrow-key step on the resize handle */
export const SIDEBAR_STEP = 16;
export const SIDEBAR_WIDTH_KEY = "wp-sidebar-width";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Clamps to [SIDEBAR_MIN, SIDEBAR_MAX] and rounds; anything that isn't a finite number gives the default. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SIDEBAR_DEFAULT;
  }
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

/**
 * Width while dragging the handle on the sidebar's left edge: moving the pointer left (smaller x)
 * widens the sidebar.
 */
export function dragSidebarWidth(
  startWidth: number,
  startX: number,
  currentX: number,
): number {
  return clampSidebarWidth(startWidth + (startX - currentX));
}

/** The stage keeps at least this much width next to the sidebar */
export const STAGE_MIN = 400;

/**
 * The width actually used on a given viewport: the remembered width, shrunk (down to SIDEBAR_MIN) so the
 * video keeps STAGE_MIN. The remembered width itself is unchanged.
 */
export function effectiveSidebarWidth(
  width: number,
  viewportWidth: number,
): number {
  const room = Math.max(SIDEBAR_MIN, viewportWidth - STAGE_MIN);
  return Math.min(clampSidebarWidth(width), room);
}

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSidebarWidth(
  storage: StorageLike | null = defaultStorage(),
): number {
  try {
    const raw = storage?.getItem(SIDEBAR_WIDTH_KEY);
    return raw == null || raw === ""
      ? SIDEBAR_DEFAULT
      : clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

/** Saves the clamped width and returns it. */
export function writeSidebarWidth(
  width: number,
  storage: StorageLike | null = defaultStorage(),
): number {
  const clamped = clampSidebarWidth(width);
  try {
    storage?.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  } catch {
    // Unavailable storage: the width just isn't remembered
  }
  return clamped;
}
