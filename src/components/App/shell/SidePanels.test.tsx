// Chat / Queue / People tabs: selection, keyboard, counts, and the currentTab that drives unread counting.
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidePanels } from "./SidePanels";
import { NowPlayingStrip } from "./NowPlayingStrip";
import { fakeRoom, renderUi } from "../../../test/renderRoom";
import { useRoomUi } from "../ui/RoomUi";

afterEach(() => cleanup());

const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe("SidePanels", () => {
  it("starts on the stored tab and reports the visible tab to the store", () => {
    const room = fakeRoom({ currentTab: "people" });
    const onTabSelect = vi.fn();
    renderUi(<SidePanels room={room} visible onTabSelect={onTabSelect} />);
    expect(tab(/People/).getAttribute("aria-selected")).toBe("true");
    expect(room.store.get().currentTab).toBe("people");
    fireEvent.click(tab(/Chat/));
    expect(onTabSelect).toHaveBeenCalledWith("chat");
    expect(room.store.set).toHaveBeenLastCalledWith({
      currentTab: "chat",
      unreadCount: 0,
    });
  });

  it("falls back to chat for an unknown tab, and reports none while hidden", () => {
    const room = fakeRoom({ currentTab: "bogus" });
    renderUi(<SidePanels room={room} visible={false} />);
    expect(tab(/Chat/).getAttribute("aria-selected")).toBe("true");
    expect(room.store.get().currentTab).toBe("none");
  });

  it("arrow keys, Home and End move between tabs and focus them", () => {
    const room = fakeRoom();
    renderUi(<SidePanels room={room} visible />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(tab(/Queue/).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab(/Queue/));
    expect(screen.getByText("The queue is empty")).toBeTruthy();
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(tab(/People/).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "Home" });
    expect(tab(/Chat/).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "End" });
    expect(tab(/People/).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "x" });
    expect(tab(/People/).getAttribute("aria-selected")).toBe("true");
  });

  it("shows unread (capped at 99+), queue and people counts", () => {
    const room = fakeRoom({
      unreadCount: 150,
      currentTab: "queue",
      playlist: [{ url: "u", name: "n", duration: 0, type: "file" }],
      participants: [{ id: "me" }, { id: "b" }],
    });
    renderUi(<SidePanels room={room} visible />);
    expect(screen.getByLabelText("150 unread").textContent).toBe("99+");
    expect(tab(/Queue/).textContent).toBe("Queue1");
    expect(tab(/People/).textContent).toBe("People2");
  });
});

const PickerProbe = () => (
  <div data-testid="picker">{useRoomUi().pickerOpen ? "open" : "closed"}</div>
);

describe("NowPlayingStrip", () => {
  it("asks to pick something when nothing plays", () => {
    renderUi(
      <>
        <NowPlayingStrip room={fakeRoom()} />
        <PickerProbe />
      </>,
    );
    expect(screen.getByText("Nothing playing")).toBeTruthy();
    expect(screen.getByText("Pick a video for everyone")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick" }));
    expect(screen.getByTestId("picker").textContent).toBe("open");
  });

  it("shows the title and Change while something plays", () => {
    const room = fakeRoom({
      roomMedia: "https://cdn.example.com/Big.Movie.mp4",
    });
    room.getMediaDisplayName.mockReturnValue("Big Movie");
    renderUi(<NowPlayingStrip room={room} />);
    expect(screen.getByText("Big Movie")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });
});
