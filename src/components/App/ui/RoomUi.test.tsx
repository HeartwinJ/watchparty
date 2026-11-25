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
