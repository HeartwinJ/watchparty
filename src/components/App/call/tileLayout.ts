// Where the floating video tile strip sits over the player and how big its tiles are. Pure; VideoTiles measures the
// player and the strip and asks these.
//
// The strip is a column of small tiles (wrapping into more columns when they don't fit). Its position is stored as
// fractions of the free space inside the safe area, so it stays in the same corner when the player resizes or goes
// fullscreen. To move the default, change DEFAULT_STRIP_POSITION; to keep room for something along an edge (e.g. the
// chat panel sliding in from the right), pass a bigger inset for that edge to `stripInsets`.

export interface Size {
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 0 = left/top edge of the safe area, 1 = right/bottom edge */
export interface StripPosition {
  fx: number;
  fy: number;
}

/**
 * Top-left: away from the right edge (where the chat panel slides in), the subtitles and the controls
 * (bottom), the ready check pill (top centre) and the next-episode card (bottom right).
 */
export const DEFAULT_STRIP_POSITION: StripPosition = { fx: 0, fy: 0 };

/** Tiles are 4:3 (faces fit; wider cameras are cropped at the sides) */
export const TILE_ASPECT = 4 / 3;

/** Gap between tiles and around the strip's edges, px */
export const TILE_GAP = 6;

/**
 * Keeps the strip clear of the player's own UI: the fullscreen title bar (top), the control bar (bottom), and a
 * margin elsewhere. `reserve` adds space along any edge (the open chat panel reserves the right one).
 */
export function stripInsets(opts: {
  fullscreen: boolean;
  phone: boolean;
  controls: boolean;
  reserve?: Partial<Insets>;
}): Insets {
  const margin = opts.phone ? 8 : 12;
  const r = opts.reserve ?? {};
  return {
    // The fullscreen top overlay (title + exit button) is ~56 px
    top: (opts.fullscreen ? (opts.phone ? 48 : 60) : margin) + (r.top ?? 0),
    right: margin + (r.right ?? 0),
    // The control bar (with its progress bar) is ~80 px; phones' is shorter
    bottom: (opts.controls ? (opts.phone ? 64 : 84) : margin) + (r.bottom ?? 0),
    left: margin + (r.left ?? 0),
  };
}

/**
 * The size of one tile: small (about an eighth of the player's width, 112–200 px wide; 84–112 on phones), or
 * enlarged (a bit over a third of the width, up to 480 px). Never taller than the safe area allows.
 */
export function tileSize(
  player: Size,
  opts: { phone: boolean; enlarged?: boolean; availableHeight?: number },
): Size {
  let width: number;
  if (opts.enlarged) {
    width = clamp(player.width * (opts.phone ? 0.45 : 0.36), 160, 480);
  } else if (opts.phone) {
    width = clamp(player.width * 0.16, 84, 112);
  } else {
    width = clamp(player.width * 0.12, 112, 200);
  }
  let height = width / TILE_ASPECT;
  const maxH = opts.availableHeight;
  if (maxH !== undefined && maxH > 0 && height > maxH) {
    height = Math.max(40, maxH);
    width = height * TILE_ASPECT;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Rows in the tile grid: as many tiles as fit in one column of the safe area, but no more than there are tiles
 * (empty rows would still take up height and make the strip too tall to drag). At least one.
 */
export function tilesPerColumn(
  tileHeight: number,
  availableHeight: number,
  count: number,
) {
  const fit = Math.floor(
    (availableHeight + TILE_GAP) / (tileHeight + TILE_GAP),
  );
  return Math.max(1, Math.min(fit, count));
}

/** The strip's top-left corner in px (relative to the player) for a stored position */
export function stripOffset(
  pos: StripPosition,
  strip: Size,
  player: Size,
  insets: Insets,
): { x: number; y: number } {
  const freeX = player.width - insets.left - insets.right - strip.width;
  const freeY = player.height - insets.top - insets.bottom - strip.height;
  return {
    // A strip bigger than the safe area sticks to the top/left edge of it
    x: Math.round(insets.left + Math.max(0, freeX) * clamp(pos.fx, 0, 1)),
    y: Math.round(insets.top + Math.max(0, freeY) * clamp(pos.fy, 0, 1)),
  };
}

/** The stored position for a strip dropped with its top-left corner at (x, y) (clamped into the safe area) */
export function positionFromOffset(
  offset: { x: number; y: number },
  strip: Size,
  player: Size,
  insets: Insets,
): StripPosition {
  const freeX = player.width - insets.left - insets.right - strip.width;
  const freeY = player.height - insets.top - insets.bottom - strip.height;
  return {
    fx: freeX > 0 ? clamp((offset.x - insets.left) / freeX, 0, 1) : 0,
    fy: freeY > 0 ? clamp((offset.y - insets.top) / freeY, 0, 1) : 0,
  };
}

/** Pointer travel (px) below which a press on a tile is a click (enlarge), not a drag */
export const DRAG_THRESHOLD = 5;

export const isDrag = (dx: number, dy: number) =>
  Math.hypot(dx, dy) >= DRAG_THRESHOLD;

/** The strip's saved state (per device), tolerant of junk */
export interface StripPrefs extends StripPosition {
  collapsed: boolean;
}

export function parseStripPrefs(raw: string | null): StripPrefs {
  const fallback = { ...DEFAULT_STRIP_POSITION, collapsed: false };
  if (!raw) {
    return fallback;
  }
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const num = (x: unknown, d: number) =>
      typeof x === "number" && Number.isFinite(x) ? clamp(x, 0, 1) : d;
    return {
      fx: num(v?.fx, fallback.fx),
      fy: num(v?.fy, fallback.fy),
      collapsed: v?.collapsed === true,
    };
  } catch {
    return fallback;
  }
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
