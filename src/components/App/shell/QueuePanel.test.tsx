// The Queue tab: now playing, the playlist with its menu actions and drag to reorder, and "Add to queue".
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QueuePanel } from "./QueuePanel";
import { fakeRoom, renderUi } from "../../../test/renderRoom";
import { useRoomUi } from "../ui/RoomUi";

afterEach(() => cleanup());

const item = (url: string, over: Partial<PlaylistVideo> = {}) =>
  ({
    url,
    name: "",
    channel: "Video URL",
    duration: 0,
    ...over,
  }) as PlaylistVideo;

const PickerProbe = () => {
  const ui = useRoomUi();
  return (
    <div data-testid="picker">{ui.pickerOpen ? ui.pickerMode : "closed"}</div>
  );
};

function setup(over: Parameters<typeof fakeRoom>[0] = {}) {
  const room = fakeRoom(over);
  renderUi(
    <>
      <QueuePanel room={room} />
      <PickerProbe />
    </>,
  );
  return room;
}

const options = (title: string) =>
  fireEvent.click(screen.getByRole("button", { name: `Options for ${title}` }));
const menuItem = (name: string) =>
  screen.getByRole("menuitem", { name }) as HTMLButtonElement;

describe("QueuePanel", () => {
  it("shows the empty state, and Add to queue opens the picker in queue mode", () => {
    setup();
    expect(screen.getByText("The queue is empty")).toBeTruthy();
    expect(screen.queryByText("Now playing")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(screen.getByTestId("picker").textContent).toBe("queue");
  });

  it("shows what's playing (paused or playing) with its type", () => {
    const room = setup({
      roomMedia: "https://cdn.example.com/movie.mp4",
      roomPaused: true,
    });
    expect(screen.getByText("Now playing")).toBeTruthy();
    expect(screen.getByText(/Paused ·/)).toBeTruthy();
    expect(room.getMediaDisplayName).toHaveBeenCalledWith(
      "https://cdn.example.com/movie.mp4",
    );
    cleanup();
    setup({ roomMedia: "https://cdn.example.com/movie.mp4" });
    expect(screen.getByText(/Playing ·/)).toBeTruthy();
  });

  it("lists items with names, channel, type and duration", () => {
    setup({
      playlist: [
        item("https://www.youtube.com/watch?v=abc", {
          name: "Tom &amp; Jerry",
          channel: "Cartoons",
          type: "youtube",
          duration: 125,
          img: "https://i.ytimg.com/x.jpg",
        }),
        item("https://cdn.example.com/b.mp4"),
      ],
    });
    const list = screen.getByRole("list", { name: "Up next" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Tom & Jerry")).toBeTruthy();
    expect(
      within(rows[0]).getByText("Cartoons · YouTube · 02:05"),
    ).toBeTruthy();
    expect(rows[0].querySelector("img")?.getAttribute("src")).toBe(
      "https://i.ytimg.com/x.jpg",
    );
    // The server's "Video URL" channel isn't repeated
    expect(within(rows[1]).queryByText(/Video URL/)).toBeNull();
  });

  it("menu: play now, play next, move up/down, remove (with disabled ends)", () => {
    const room = setup({
      playlist: [
        item("https://a.example.com/1.mp4", { name: "One" }),
        item("https://a.example.com/2.mp4", { name: "Two" }),
        item("https://a.example.com/3.mp4", { name: "Three" }),
      ],
    });
    options("One");
    expect(menuItem("Play next").disabled).toBe(true);
    expect(menuItem("Move up").disabled).toBe(true);
    fireEvent.click(menuItem("Play now"));
    expect(room.playlist.play).toHaveBeenCalledWith(0);

    options("Three");
    expect(menuItem("Move down").disabled).toBe(true);
    fireEvent.click(menuItem("Play next"));
    expect(room.playlist.move).toHaveBeenLastCalledWith(2, 0);

    options("Two");
    fireEvent.click(menuItem("Move up"));
    expect(room.playlist.move).toHaveBeenLastCalledWith(1, 0);
    options("Two");
    fireEvent.click(menuItem("Move down"));
    expect(room.playlist.move).toHaveBeenLastCalledWith(1, 2);
    options("Two");
    fireEvent.click(menuItem("Remove"));
    expect(room.playlist.remove).toHaveBeenLastCalledWith(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Three from the queue" }),
    );
    expect(room.playlist.remove).toHaveBeenLastCalledWith(2);
  });

  it("drag and drop reorders; dropping on itself or without a drag does nothing", () => {
    const room = setup({
      playlist: [
        item("https://a.example.com/1.mp4", { name: "One" }),
        item("https://a.example.com/2.mp4", { name: "Two" }),
      ],
    });
    const [one, two] = screen.getAllByRole("listitem");
    const dataTransfer = { setData: () => {}, effectAllowed: "" };
    // A dragover without a drag from this list is ignored
    fireEvent.dragOver(two, { dataTransfer });
    expect(two.dataset.over).toBeUndefined();

    fireEvent.dragStart(one, { dataTransfer });
    expect(one.dataset.dragging).toBe("true");
    fireEvent.dragOver(two, { dataTransfer });
    expect(two.dataset.over).toBe("true");
    fireEvent.dragLeave(two);
    expect(two.dataset.over).toBeUndefined();
    fireEvent.dragOver(two, { dataTransfer });
    fireEvent.drop(two, { dataTransfer });
    expect(room.playlist.move).toHaveBeenCalledWith(0, 1);
    expect(one.dataset.dragging).toBeUndefined();

    fireEvent.dragStart(one, { dataTransfer });
    fireEvent.drop(one, { dataTransfer });
    expect(room.playlist.move).toHaveBeenCalledTimes(1);
    fireEvent.dragStart(two, { dataTransfer });
    fireEvent.dragEnd(two);
    expect(two.dataset.dragging).toBeUndefined();
  });
});
