import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoomUiProvider, useRoomUi, type RoomUi } from "./RoomUi";

function capture() {
  const ref: { current: RoomUi | null } = { current: null };
  const Probe = () => {
    ref.current = useRoomUi();
    return null;
  };
  render(
    <RoomUiProvider>
      <Probe />
    </RoomUiProvider>,
  );
  return ref;
}

describe("RoomUi", () => {
  it("opens and closes the picker", () => {
    const ui = capture();
    expect(ui.current!.pickerOpen).toBe(false);
    act(() => ui.current!.openPicker());
    expect(ui.current!.pickerOpen).toBe(true);
    act(() => ui.current!.closePicker());
    expect(ui.current!.pickerOpen).toBe(false);
  });

  it("opens the picker in queue mode, or at a target; a click event means play", () => {
    const ui = capture();
    act(() => ui.current!.openPicker({ mode: "queue" }));
    expect(ui.current!.pickerMode).toBe("queue");
    act(() => ui.current!.closePicker());
    // e.g. onClick={ui.openPicker} passes the click event
    act(() =>
      (ui.current!.openPicker as (e: unknown) => void)({ type: "click" }),
    );
    expect(ui.current!.pickerMode).toBe("play");
    act(() => ui.current!.openPickerAt({ kind: "search", query: "x" }));
    expect(ui.current!.pickerTarget).toEqual({ kind: "search", query: "x" });
    act(() => ui.current!.closePicker());
    expect(ui.current!.pickerTarget).toBeNull();
  });

  it("toggles and persists the sidebar", () => {
    window.localStorage.clear();
    const ui = capture();
    expect(ui.current!.sidebarCollapsed).toBe(false);
    act(() => ui.current!.toggleSidebar());
    expect(ui.current!.sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem("wp-sidebar-collapsed")).toBe("1");
  });

  it("throws outside the provider", () => {
    const Bad = () => {
      useRoomUi();
      return null;
    };
    expect(() => render(<Bad />)).toThrow();
  });
});
