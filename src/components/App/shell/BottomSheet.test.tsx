// The phone bottom sheet's handle: tap, keys and drags between the snap points.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { BottomSheetHandle, useBottomSheet } from "./BottomSheet";
import {
  installResizeObserver,
  setElementSize,
} from "../../../test/browserFakes";

let now = 0;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  // 1024 × 768: docked top = 48 + 1024 × 9/16 = 624 → docked 144, full 768 - 48 - 64 = 656, min 100
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 768,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const Harness = ({
  enabled = true,
  withEdge = false,
}: {
  enabled?: boolean;
  withEdge?: boolean;
}) => {
  const edge = useRef<HTMLDivElement | null>(null);
  const sheet = useBottomSheet({ enabled, dockedEdgeRef: edge });
  return (
    <>
      {withEdge && (
        <div
          data-testid="edge"
          ref={(el) => {
            if (el) setElementSize(el, 400, 40, 0, 500);
            edge.current = el;
          }}
        />
      )}
      <div
        data-testid="sheet"
        data-snap={sheet.snap}
        data-dragging={sheet.dragging}
        style={sheet.style}
      >
        <BottomSheetHandle sheet={sheet} />
      </div>
    </>
  );
};

const sheetEl = () => screen.getByTestId("sheet");
const handle = () => screen.getByRole("button", { name: /Resize panel/ });
const height = () => sheetEl().style.height;

describe("BottomSheet", () => {
  it("starts docked under the video and labels the handle", () => {
    render(<Harness />);
    expect(sheetEl().dataset.snap).toBe("docked");
    expect(height()).toBe("144px");
    expect(handle().getAttribute("aria-label")).toMatch(
      /docked\)\. Tap to expand/,
    );
  });

  it("measures the docked height from the now-playing strip and on resize", () => {
    const RO = installResizeObserver();
    render(<Harness withEdge />);
    // The strip's bottom is at 540
    expect(height()).toBe(`${768 - 540}px`);
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(height()).toBe(`${800 - 540}px`);
    expect(RO.instances[0].targets.size).toBe(1);
  });

  it("arrow keys step between snap points, Enter/Space toggle", () => {
    render(<Harness />);
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(sheetEl().dataset.snap).toBe("full");
    expect(height()).toBe("656px");
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(sheetEl().dataset.snap).toBe("full");
    expect(handle().getAttribute("aria-label")).toMatch(
      /expanded\)\. Tap to dock/,
    );
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(sheetEl().dataset.snap).toBe("min");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(sheetEl().dataset.snap).toBe("min");
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(sheetEl().dataset.snap).toBe("docked");
    fireEvent.keyDown(handle(), { key: " " });
    expect(sheetEl().dataset.snap).toBe("full");
    fireEvent.keyDown(handle(), { key: "x" });
    expect(sheetEl().dataset.snap).toBe("full");
  });

  it("a tap (movement under the slop) toggles docked/full", () => {
    render(<Harness />);
    fireEvent.pointerDown(handle(), { clientY: 600, pointerType: "touch" });
    fireEvent.pointerMove(handle(), { clientY: 603 });
    fireEvent.pointerUp(handle(), { clientY: 603 });
    expect(sheetEl().dataset.snap).toBe("full");
  });

  it("ignores right mouse buttons", () => {
    render(<Harness />);
    fireEvent.pointerDown(handle(), {
      clientY: 600,
      pointerType: "mouse",
      button: 2,
    });
    fireEvent.pointerUp(handle(), { clientY: 600 });
    expect(sheetEl().dataset.snap).toBe("docked");
  });

  it("follows a slow drag and snaps to the nearest point", () => {
    render(<Harness />);
    fireEvent.pointerDown(handle(), {
      clientY: 600,
      pointerType: "mouse",
      button: 0,
    });
    now += 100;
    fireEvent.pointerMove(handle(), { clientY: 300 });
    expect(sheetEl().dataset.dragging).toBe("true");
    // 144 + 300 = 444
    expect(height()).toBe("444px");
    // Pause before releasing: not a flick
    now += 500;
    fireEvent.pointerUp(handle(), { clientY: 150 });
    expect(sheetEl().dataset.dragging).toBe("false");
    // 144 + 450 = 594 → nearest is full (656)
    expect(sheetEl().dataset.snap).toBe("full");
  });

  it("a quick downward flick moves one step down", () => {
    render(<Harness />);
    fireEvent.pointerDown(handle(), { clientY: 600, pointerType: "touch" });
    now += 10;
    fireEvent.pointerMove(handle(), { clientY: 620 });
    now += 10;
    fireEvent.pointerMove(handle(), { clientY: 640 });
    fireEvent.pointerCancel(handle(), { clientY: 640 });
    expect(sheetEl().dataset.snap).toBe("min");
  });

  it("doesn't measure while disabled", () => {
    const RO = installResizeObserver();
    render(<Harness enabled={false} withEdge />);
    expect(RO.instances).toHaveLength(0);
    expect(height()).toBe("144px");
  });
});
