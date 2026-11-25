import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  dragSidebarWidth,
  effectiveSidebarWidth,
  readSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_WIDTH_KEY,
  writeSidebarWidth,
} from "./sidebarWidth";
import {
  dragSheetHeight,
  settleSheet,
  SHEET_MIN_HEIGHT,
  sheetHeights,
  tapSheet,
} from "./sheet";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
};

describe("sidebar width", () => {
  it("clamps to 280-560 and rounds", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(400.6)).toBe(401);
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT);
  });

  it("widens when dragging left and narrows when dragging right", () => {
    expect(dragSidebarWidth(360, 1000, 940)).toBe(420);
    expect(dragSidebarWidth(360, 1000, 1050)).toBe(310);
    expect(dragSidebarWidth(360, 1000, 0)).toBe(SIDEBAR_MAX);
    expect(dragSidebarWidth(360, 1000, 2000)).toBe(SIDEBAR_MIN);
  });

  it("shrinks on narrow viewports so the video keeps some width", () => {
    expect(effectiveSidebarWidth(500, 1440)).toBe(500);
    expect(effectiveSidebarWidth(500, 860)).toBe(460);
    expect(effectiveSidebarWidth(500, 700)).toBe(300);
    expect(effectiveSidebarWidth(500, 600)).toBe(SIDEBAR_MIN);
    expect(effectiveSidebarWidth(9999, 3000)).toBe(SIDEBAR_MAX);
  });

  it("defaults to 360 and remembers the clamped width", () => {
    const storage = memoryStorage();
    expect(readSidebarWidth(storage)).toBe(SIDEBAR_DEFAULT);
    expect(writeSidebarWidth(1000, storage)).toBe(SIDEBAR_MAX);
    expect(storage.data.get(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_MAX));
    expect(readSidebarWidth(storage)).toBe(SIDEBAR_MAX);
    writeSidebarWidth(300, storage);
    expect(readSidebarWidth(storage)).toBe(300);
  });

  it("ignores garbage and unavailable storage", () => {
    const storage = memoryStorage();
    storage.setItem(SIDEBAR_WIDTH_KEY, "wide");
    expect(readSidebarWidth(storage)).toBe(SIDEBAR_DEFAULT);
    storage.setItem(SIDEBAR_WIDTH_KEY, "50");
    expect(readSidebarWidth(storage)).toBe(SIDEBAR_MIN);
    expect(readSidebarWidth(null)).toBe(SIDEBAR_DEFAULT);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSidebarWidth(throwing)).toBe(SIDEBAR_DEFAULT);
    expect(writeSidebarWidth(400, throwing)).toBe(400);
  });
});

describe("bottom sheet", () => {
  // 390x844 phone: 48px top bar, 219px video, 52px now-playing strip
  const heights = sheetHeights({
    viewportHeight: 844,
    dockedTop: 48 + 219 + 52,
    topbarHeight: 48,
  });

  it("computes the snap heights", () => {
    expect(heights).toEqual({
      min: SHEET_MIN_HEIGHT,
      docked: 844 - 319,
      full: 844 - 48 - 64,
    });
  });

  it("keeps docked between min and full on short screens", () => {
    const short = sheetHeights({
      viewportHeight: 300,
      dockedTop: 290,
      topbarHeight: 48,
    });
    expect(short.docked).toBe(SHEET_MIN_HEIGHT);
    expect(short.full).toBeGreaterThanOrEqual(short.docked);
  });

  it("follows the finger within [min, full]", () => {
    expect(dragSheetHeight(heights.docked, -50, heights)).toBe(
      heights.docked + 50,
    );
    expect(dragSheetHeight(heights.docked, -5000, heights)).toBe(heights.full);
    expect(dragSheetHeight(heights.docked, 5000, heights)).toBe(heights.min);
  });

  it("settles on the nearest snap point after a slow drag", () => {
    const settle = (height: number) =>
      settleSheet({ from: "docked", height, velocity: 0, heights });
    expect(settle(heights.docked + 20)).toBe("docked");
    expect(settle(heights.full - 30)).toBe("full");
    expect(settle(heights.min + 40)).toBe("min");
  });

  it("moves one step on a flick, whatever the distance", () => {
    const flick = (from: "min" | "docked" | "full", velocity: number) =>
      settleSheet({ from, height: heights.docked, velocity, heights });
    expect(flick("docked", -1)).toBe("full");
    expect(flick("docked", 1)).toBe("min");
    expect(flick("min", -1)).toBe("docked");
    expect(flick("full", 1)).toBe("docked");
    expect(flick("full", -1)).toBe("full");
    expect(flick("min", 1)).toBe("min");
  });

  it("toggles docked and full on tap (min opens to docked)", () => {
    expect(tapSheet("docked")).toBe("full");
    expect(tapSheet("full")).toBe("docked");
    expect(tapSheet("min")).toBe("docked");
  });
});
