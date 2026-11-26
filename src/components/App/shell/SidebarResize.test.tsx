// Resizing the desktop sidebar: pointer drag, keyboard, double-click reset, narrow windows.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidebarResizeHandle, useSidebarWidth } from "./SidebarResize";
import { SIDEBAR_WIDTH_KEY } from "./sidebarWidth";

const Harness = ({ hidden }: { hidden?: boolean }) => {
  const sidebar = useSidebarWidth();
  return (
    <div data-testid="w" data-width={sidebar.width}>
      <SidebarResizeHandle sidebar={sidebar} hidden={hidden} />
    </div>
  );
};
const renderHarness = (hidden?: boolean) =>
  render(
    <MantineProvider env="test">
      <Harness hidden={hidden} />
    </MantineProvider>,
  );
const width = () => Number(screen.getByTestId("w").dataset.width);
const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1600,
  });
});
afterEach(() => cleanup());

describe("SidebarResize", () => {
  it("uses the remembered width", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "420");
    renderHarness();
    expect(width()).toBe(420);
    expect(handle().getAttribute("aria-valuenow")).toBe("420");
  });

  it("renders nothing when hidden", () => {
    renderHarness(true);
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("keys step, Home/End jump to the limits, double-click resets", () => {
    renderHarness();
    expect(width()).toBe(360);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(width()).toBe(376);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(width()).toBe(344);
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(width()).toBe(560);
    fireEvent.keyDown(handle(), { key: "End" });
    expect(width()).toBe(280);
    fireEvent.keyDown(handle(), { key: "a" });
    expect(width()).toBe(280);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("280");
    fireEvent.doubleClick(handle());
    expect(width()).toBe(360);
  });

  it("drags (left = wider), and remembers the width on release", () => {
    renderHarness();
    fireEvent.pointerDown(handle(), { button: 0, clientX: 1000 });
    expect(handle().dataset.active).toBe("true");
    fireEvent.pointerMove(handle(), { clientX: 900 });
    expect(width()).toBe(460);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
    fireEvent.pointerUp(handle(), { clientX: 900 });
    expect(handle().dataset.active).toBeUndefined();
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("460");
  });

  it("a click without moving doesn't store anything; other buttons are ignored", () => {
    renderHarness();
    fireEvent.pointerDown(handle(), { button: 2, clientX: 1000 });
    expect(handle().dataset.active).toBeUndefined();
    fireEvent.pointerDown(handle(), { button: 0, clientX: 1000 });
    fireEvent.pointerCancel(handle());
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
  });

  it("shrinks on narrow windows so the video keeps 400px", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "560");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    renderHarness();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(width()).toBe(400);
  });
});
