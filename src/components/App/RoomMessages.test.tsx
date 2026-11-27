// Room overlays and messages: joining spinner, reconnecting banner, the error card, toasts and the share modals.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.fn();
vi.mock("./ui/toast", () => ({ toast: (...a: unknown[]) => toastMock(...a) }));
const navigate = vi.fn();
vi.mock("../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../router")>()),
  navigate: (to: string) => navigate(to),
}));

const { RoomMessages } = await import("./RoomMessages");
const { fakeRoom, renderUi } = await import("../../test/renderRoom");

beforeEach(() => {
  toastMock.mockClear();
  navigate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(over: Parameters<typeof fakeRoom>[0] = {}) {
  const room = fakeRoom({ connection: "connected" as any, ...over });
  room.player.current.mockReturnValue({
    setSubtitleMode: vi.fn(),
    getSubtitleMode: () => "hidden",
  } as any);
  const r = renderUi(<RoomMessages room={room} />);
  return { room, ...r };
}

describe("RoomMessages", () => {
  it("shows Joining the room… while starting", () => {
    setup({ connection: "starting" });
    expect(screen.getByText("Joining the room…")).toBeTruthy();
  });

  it("shows the reconnecting banner", () => {
    setup({ warningMessage: "Reconnecting…" });
    expect(screen.getByRole("status").textContent).toContain("Reconnecting…");
  });

  it("shows the error card instead of the banner/spinner, with Try again and Go home", () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      setup({
        connection: "starting",
        warningMessage: "Reconnecting…",
        overlayMsg: "Can't reach the room",
      });
      expect(screen.queryByText("Joining the room…")).toBeNull();
      expect(screen.queryByText("Reconnecting…")).toBeNull();
      expect(
        screen.getByRole("alertdialog", { name: "Can't reach the room" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(reload).toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Go home" }));
      expect(navigate).toHaveBeenCalledWith("/");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  });

  it("toasts the server's error and success messages", () => {
    setup({ errorMessage: "Nope", successMessage: "Done!" });
    expect(toastMock).toHaveBeenCalledWith("Nope", { tone: "danger" });
    expect(toastMock).toHaveBeenCalledWith("Done!", { tone: "success" });
  });

  it("opens the share and subtitle modals and closes them through the store", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    const { room } = setup({
      isScreenShareModalOpen: true,
      isFileShareModalOpen: true,
      isSubtitleModalOpen: true,
    });
    expect(screen.getByText("Share your screen")).toBeTruthy();
    expect(screen.getByText("Share a file")).toBeTruthy();
    // The OpenSubtitles file-name search; Back returns to the title search
    expect(
      screen.getByRole("searchbox", { name: "File or release name" }),
    ).toBeTruthy();
    fireEvent.click(
      within(
        screen.getByRole("dialog", {
          name: "Search OpenSubtitles by file name",
        }),
      ).getByRole("button", { name: "Back" }),
    );
    expect(room.store.set).toHaveBeenCalledWith({
      isSubtitleModalOpen: false,
      isSubtitleSearchOpen: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    expect(room.share.startScreenShare).toHaveBeenCalled();
    expect(room.store.set).toHaveBeenCalledWith({
      isScreenShareModalOpen: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(room.share.startFileShare).toHaveBeenCalledWith({ convert: false });
    expect(room.store.set).toHaveBeenCalledWith({
      isFileShareModalOpen: false,
    });
  });
});
