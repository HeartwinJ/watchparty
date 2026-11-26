// The room top bar: desktop vs phone, owner vs guest menus, deleting the room, invite, sidebar toggle.
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../PlayerArea", () => ({ SyncIndicator: () => <span>sync</span> }));
vi.mock("../picker/ConvertStatus", () => ({ ConvertStatus: () => null }));
vi.mock("../call/CallControl", () => ({ CallControl: () => null }));
const navigate = vi.fn();
vi.mock("../../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../router")>()),
  navigate: (to: string) => navigate(to),
}));

const { RoomTopBar } = await import("./RoomTopBar");
const { fakeRoom, renderUi } = await import("../../../test/renderRoom");
const { useRoomUi } = await import("../ui/RoomUi");

const writeText = vi.fn(async (_t: string) => {});
beforeEach(() => {
  navigate.mockClear();
  writeText.mockClear();
  window.localStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(() => cleanup());

let ui: ReturnType<typeof useRoomUi>;
const Grab = () => {
  ui = useRoomUi();
  return null;
};

function setup(
  opts: {
    role?: "owner" | "guest";
    isPhone?: boolean;
    authRequired?: boolean;
  } = {},
  over: Parameters<typeof fakeRoom>[0] = {},
) {
  const room = fakeRoom({
    participants: [{ id: "me" }, { id: "bob" }],
    nameMap: { me: "Sam", bob: "Bob" },
    ...over,
  });
  const logout = vi.fn(async () => {});
  renderUi(
    <>
      <RoomTopBar room={room} roomId="brave-otter" isPhone={!!opts.isPhone} />
      <Grab />
    </>,
    {
      role: opts.role ?? "owner",
      authRequired: opts.authRequired ?? true,
      logout,
    },
  );
  return { room, logout };
}

const more = () =>
  fireEvent.click(screen.getByRole("button", { name: "More options" }));

describe("RoomTopBar", () => {
  it("desktop: room name, picker trigger with what's playing, avatars, sidebar toggle", () => {
    const { room } = setup(
      {},
      {
        roomMedia: "https://v.example.com/a.mp4",
        roomSettings: {
          title: "Movie night",
          readyCheck: true,
          nextEpisodeOffset: 25,
          autoSyncSubtitles: false,
          skipIntro: 0,
        },
      },
    );
    room.getMediaDisplayName.mockReturnValue("A movie");
    expect(screen.getByText("Movie night")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Change what's playing/ }),
    );
    expect(ui.pickerOpen).toBe(true);
    expect(screen.getByRole("link", { name: "WatchParty home" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Hide sidebar" });
    fireEvent.click(toggle);
    expect(ui.sidebarCollapsed).toBe(true);
  });

  it("shows unread messages on the collapsed sidebar toggle", () => {
    setup({}, { unreadCount: 3 });
    act(() => ui.toggleSidebar());
    expect(
      screen.getByRole("button", { name: "Show sidebar, 3 unread messages" }),
    ).toBeTruthy();
  });

  it("phone: no logo, picker trigger, avatars or sidebar toggle; invite is an icon", async () => {
    setup({ isPhone: true });
    expect(screen.queryByRole("link", { name: "WatchParty home" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Choose something/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /sidebar/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));
    });
    expect(writeText).toHaveBeenCalledWith(
      window.location.origin + window.location.pathname,
    );
  });

  it("owners with a password get an invite menu with and without it", async () => {
    setup({}, { roomAccess: { enabled: true, password: "otter-42" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: /Copy link with password/,
        }),
      );
    });
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringMatching(/#pw=otter-42$/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("menuitem", { name: /^Copy invite link/ }),
      );
    });
    expect(writeText).toHaveBeenLastCalledWith(
      expect.not.stringContaining("#pw"),
    );
  });

  it("the menu opens the picker, settings and the shortcuts overlay", async () => {
    setup();
    const shortcuts = vi.fn();
    window.addEventListener("wp:show-shortcuts", shortcuts);
    more();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Change video/ }),
    );
    expect(ui.pickerOpen).toBe(true);
    more();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Room settings/ }),
    );
    expect(ui.settingsOpen).toBe(true);
    more();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Keyboard shortcuts/ }),
    );
    expect(shortcuts).toHaveBeenCalled();
    window.removeEventListener("wp:show-shortcuts", shortcuts);
  });

  it("owners can leave, log out, and delete the room after confirming", async () => {
    const { room, logout } = setup();
    more();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Leave room" }),
    );
    expect(navigate).toHaveBeenCalledWith("/");
    more();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
    expect(logout).toHaveBeenCalled();
    more();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete room" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Delete Brave otter?")).toBeNull(),
    );
    expect(room.cmd.deleteRoom).not.toHaveBeenCalled();
    more();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete room" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete room" }));
    expect(room.cmd.deleteRoom).toHaveBeenCalled();
  });

  it("guests get no Home link, no room management and no log out", async () => {
    setup({ role: "guest" }, { roomAccess: { enabled: true } });
    expect(screen.queryByRole("link", { name: "WatchParty home" })).toBeNull();
    more();
    await screen.findByRole("menuitem", { name: /Room settings/ });
    for (const name of ["Leave room", "Delete room", "Log out"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
    expect(
      screen.getByRole("button", { name: "Copy invite link" }),
    ).toBeTruthy();
  });

  it("owners without auth have no Log out", async () => {
    setup({ authRequired: false });
    more();
    await screen.findByRole("menuitem", { name: "Leave room" });
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull();
  });
});
