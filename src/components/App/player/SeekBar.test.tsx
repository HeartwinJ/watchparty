import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeekBar } from "./SeekBar";
import { setElementSize } from "../../../test/browserFakes";

afterEach(cleanup);

function setup(
  props: Partial<React.ComponentProps<typeof SeekBar>> = {},
  width = 1000,
) {
  const onSeek = vi.fn();
  render(
    <SeekBar
      currentTime={60}
      duration={600}
      buffered={[{ start: 0, end: 300 }]}
      onSeek={onSeek}
      {...props}
    />,
  );
  const slider = screen.getByRole("slider", { name: "Seek" });
  // happy-dom has no layout: the bar is 1000 px wide starting at x = 100
  setElementSize(slider, width, 8, 100, 0);
  // jsdom/happy-dom don't implement pointer capture
  slider.setPointerCapture = vi.fn();
  return { slider, onSeek };
}

describe("SeekBar", () => {
  it("describes the position for screen readers", () => {
    const { slider } = setup();
    expect(slider.getAttribute("aria-valuenow")).toBe("60");
    expect(slider.getAttribute("aria-valuemax")).toBe("600");
    expect(slider.getAttribute("aria-valuetext")).toBe("01:00 of 10:00");
    expect(slider.tabIndex).toBe(0);
  });

  it("is disabled without a known duration", () => {
    const { slider, onSeek } = setup({ duration: NaN });
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    expect(slider.getAttribute("aria-valuetext")).toBe("Unknown duration");
    expect(slider.tabIndex).toBe(-1);
    fireEvent.pointerDown(slider, { button: 0, clientX: 600 });
    fireEvent.pointerUp(slider, { clientX: 600 });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSeek).not.toHaveBeenCalled();
    // Buffered ranges are only drawn with a duration
    expect(slider.querySelectorAll("[style*='calc']")).toHaveLength(0);
  });

  it("is disabled when the prop says so", () => {
    const { slider, onSeek } = setup({ disabled: true });
    fireEvent.pointerMove(slider, { clientX: 600, pointerType: "mouse" });
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onSeek).not.toHaveBeenCalled();
    expect(slider.textContent).toBe("");
  });

  it("drags and seeks on release, showing the drag position meanwhile", () => {
    const { slider, onSeek } = setup();
    fireEvent.pointerDown(slider, { button: 0, clientX: 350, pointerId: 1 });
    expect(slider.setPointerCapture).toHaveBeenCalledWith(1);
    expect(slider.getAttribute("data-drag")).toBe("true");
    // 25% of 600 s
    expect(slider.getAttribute("aria-valuenow")).toBe("150");
    fireEvent.pointerMove(slider, { clientX: 600, pointerType: "touch" });
    expect(slider.getAttribute("aria-valuenow")).toBe("300");
    expect(screen.getByText("05:00")).toBeTruthy();
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider, { clientX: 1100 });
    expect(onSeek).toHaveBeenCalledWith(600);
    expect(slider.getAttribute("data-drag")).toBe("false");
    // Back to the real time
    expect(slider.getAttribute("aria-valuenow")).toBe("60");
  });

  it("clamps outside the bar", () => {
    const { slider, onSeek } = setup();
    fireEvent.pointerDown(slider, { button: 0, clientX: 0 });
    fireEvent.pointerUp(slider, { clientX: -50 });
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("ignores right clicks and a cancelled drag doesn't seek", () => {
    const { slider, onSeek } = setup();
    fireEvent.pointerDown(slider, { button: 2, clientX: 600 });
    expect(slider.getAttribute("data-drag")).toBe("false");
    fireEvent.pointerDown(slider, { button: 0, clientX: 600 });
    fireEvent.pointerCancel(slider);
    fireEvent.pointerUp(slider, { clientX: 600 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("shows a hover time for the mouse only, cleared on leave", () => {
    const { slider } = setup();
    fireEvent.pointerMove(slider, { clientX: 400, pointerType: "touch" });
    expect(screen.queryByText("03:00")).toBeNull();
    fireEvent.pointerMove(slider, { clientX: 400, pointerType: "mouse" });
    expect(screen.getByText("03:00")).toBeTruthy();
    fireEvent.pointerLeave(slider);
    expect(screen.queryByText("03:00")).toBeNull();
  });

  it("a zero-width bar seeks to 0 rather than NaN", () => {
    const { slider, onSeek } = setup({}, 0);
    fireEvent.pointerDown(slider, { button: 0, clientX: 500 });
    fireEvent.pointerUp(slider, { clientX: 500 });
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("supports the keyboard", () => {
    const { slider, onSeek } = setup({ currentTime: 3 });
    const press = (key: string) => {
      onSeek.mockClear();
      fireEvent.keyDown(slider, { key });
      return onSeek.mock.calls[0]?.[0];
    };
    expect(press("ArrowRight")).toBe(8);
    // Never before 0
    expect(press("ArrowLeft")).toBe(0);
    expect(press("PageUp")).toBe(33);
    expect(press("PageDown")).toBe(0);
    expect(press("Home")).toBe(0);
    expect(press("End")).toBe(599);
    expect(press("a")).toBeUndefined();
  });

  it("formats live times from the wall-clock base", () => {
    const zero = new Date("2026-01-01T10:00:00").getTime() / 1000;
    const { slider } = setup({ zeroTime: zero });
    expect(slider.getAttribute("aria-valuetext")).not.toBe("01:00 of 10:00");
  });
});
