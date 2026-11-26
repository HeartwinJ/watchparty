import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRIP_POSITION,
  isDrag,
  parseStripPrefs,
  positionFromOffset,
  stripInsets,
  stripOffset,
  tileSize,
  tilesPerColumn,
} from "./tileLayout";

const player = { width: 1280, height: 720 };
const strip = { width: 160, height: 400 };

describe("stripInsets", () => {
  it("keeps clear of the fullscreen title bar and the control bar", () => {
    const windowed = stripInsets({
      fullscreen: false,
      phone: false,
      controls: true,
    });
    const full = stripInsets({
      fullscreen: true,
      phone: false,
      controls: true,
    });
    expect(full.top).toBeGreaterThan(windowed.top);
    expect(windowed.bottom).toBeGreaterThan(
      stripInsets({ fullscreen: false, phone: false, controls: false }).bottom,
    );
    // Room for a panel along an edge (e.g. fullscreen chat from the right)
    expect(
      stripInsets({
        fullscreen: true,
        phone: false,
        controls: true,
        reserve: { right: 360 },
      }).right,
    ).toBe(full.right + 360);
  });
});

describe("strip position", () => {
  const insets = stripInsets({
    fullscreen: false,
    phone: false,
    controls: true,
  });

  it("defaults to the top-left corner, away from the right edge", () => {
    expect(DEFAULT_STRIP_POSITION).toEqual({ fx: 0, fy: 0 });
    expect(stripOffset(DEFAULT_STRIP_POSITION, strip, player, insets)).toEqual({
      x: insets.left,
      y: insets.top,
    });
  });

  it("round-trips a drop and clamps it into the safe area", () => {
    const pos = positionFromOffset({ x: 600, y: 100 }, strip, player, insets);
    expect(stripOffset(pos, strip, player, insets)).toEqual({ x: 600, y: 100 });
    // Dragged past the bottom-right corner: pinned to it
    const far = positionFromOffset({ x: 5000, y: 5000 }, strip, player, insets);
    expect(far).toEqual({ fx: 1, fy: 1 });
    expect(stripOffset(far, strip, player, insets)).toEqual({
      x: player.width - insets.right - strip.width,
      y: player.height - insets.bottom - strip.height,
    });
    expect(
      positionFromOffset({ x: -50, y: -50 }, strip, player, insets),
    ).toEqual({ fx: 0, fy: 0 });
  });

  it("keeps its corner when the player resizes (fractions, not pixels)", () => {
    const pos = { fx: 1, fy: 0 };
    const small = { width: 640, height: 360 };
    expect(stripOffset(pos, strip, small, insets).x).toBe(
      small.width - insets.right - strip.width,
    );
  });

  it("sticks to the top-left when the strip is bigger than the space", () => {
    expect(
      stripOffset(
        { fx: 1, fy: 1 },
        { width: 2000, height: 2000 },
        player,
        insets,
      ),
    ).toEqual({ x: insets.left, y: insets.top });
  });
});

describe("tileSize", () => {
  it("is small, 4:3, and bigger when enlarged", () => {
    const s = tileSize(player, { phone: false });
    expect(s.width).toBeGreaterThanOrEqual(112);
    expect(s.width).toBeLessThanOrEqual(200);
    expect(s.width / s.height).toBeCloseTo(4 / 3, 1);
    const big = tileSize(player, { phone: false, enlarged: true });
    expect(big.width).toBeGreaterThan(s.width * 2);
    expect(big.width).toBeLessThanOrEqual(480);
  });

  it("is smaller on phones, also in landscape fullscreen", () => {
    const phone = tileSize({ width: 390, height: 220 }, { phone: true });
    expect(phone.width).toBe(84);
    const landscape = tileSize({ width: 844, height: 390 }, { phone: true });
    expect(landscape.width).toBeLessThanOrEqual(112);
  });

  it("never gets taller than the available height", () => {
    const s = tileSize(player, {
      phone: false,
      enlarged: true,
      availableHeight: 150,
    });
    expect(s.height).toBe(150);
    expect(s.width).toBe(200);
  });
});

describe("tilesPerColumn", () => {
  it("wraps into more columns when the column is full", () => {
    expect(tilesPerColumn(120, 600)).toBe(4);
    expect(tilesPerColumn(120, 50)).toBe(1);
  });
});

describe("drag vs click", () => {
  it("needs a few pixels of travel to count as a drag", () => {
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(4, 4)).toBe(true);
  });
});

describe("parseStripPrefs", () => {
  it("reads saved prefs and survives junk", () => {
    expect(parseStripPrefs('{"fx":0.5,"fy":2,"collapsed":true}')).toEqual({
      fx: 0.5,
      fy: 1,
      collapsed: true,
    });
    for (const bad of [null, "", "nope", "[]", '{"fx":"x"}']) {
      expect(parseStripPrefs(bad)).toEqual({ fx: 0, fy: 0, collapsed: false });
    }
  });
});
