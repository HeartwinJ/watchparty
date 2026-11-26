// Small pages and chrome: /create, not found, room deleted, the brand link, the home AppBar menu, avatars.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

const navigate = vi.fn();
vi.mock("../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../router")>()),
  navigate: (...a: unknown[]) => navigate(...a),
}));
const createRoom = vi.fn();
vi.mock("../../utils/rooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/rooms")>()),
  createRoom: (...a: unknown[]) => createRoom(...a),
}));

const { Create } = await import("../Create/Create");
const { NotFound } = await import("./NotFound");
const { RoomDeleted } = await import("./RoomDeleted");
const { Brand } = await import("../Brand/Brand");
const { AppBar } = await import("../AppBar/AppBar");
const { UserAvatar, AvatarStack } = await import("../Avatar/Avatar");
const { AuthContext } = await import("../AuthGate/AuthGate");

const wrap = (ui: React.ReactElement, authRequired = true) =>
  render(
    <MantineProvider env="test">
      <AuthContext.Provider
        value={{
          authRequired,
          role: "owner",
          logout: async () => {},
          roomAccessLost: () => {},
        }}
      >
        {ui}
      </AuthContext.Provider>
    </MantineProvider>,
  );

beforeEach(() => {
  navigate.mockClear();
  createRoom.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("Create", () => {
  it("creates a room with ?video= and replaces the page", async () => {
    window.history.replaceState(
      null,
      "",
      "/create?video=https%3A%2F%2Fv.example.com%2Fa.mp4",
    );
    createRoom.mockResolvedValue("x");
    wrap(<Create />);
    expect(screen.getByText("Creating your room…")).toBeTruthy();
    await waitFor(() =>
      expect(createRoom).toHaveBeenCalledWith({
        video: "https://v.example.com/a.mp4",
        replace: true,
      }),
    );
  });

  it("shows an error with Try again and Go home", async () => {
    createRoom.mockRejectedValueOnce(new Error("down"));
    wrap(<Create />);
    await screen.findByText("Couldn't create a room");
    expect(createRoom).toHaveBeenCalledWith({
      video: undefined,
      replace: true,
    });
    createRoom.mockResolvedValueOnce("x");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(createRoom).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Creating your room…")).toBeTruthy();

    cleanup();
    createRoom.mockRejectedValueOnce(new Error("down"));
    wrap(<Create />);
    fireEvent.click(await screen.findByRole("button", { name: "Go home" }));
    expect(navigate).toHaveBeenCalledWith("/");
  });
});

describe("status pages", () => {
  it("NotFound goes home", () => {
    wrap(<NotFound />);
    expect(screen.getByText("Page not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("RoomDeleted names who deleted it; only owners get Go home", () => {
    wrap(<RoomDeleted by="Alex" canGoHome />);
    expect(screen.getByText(/Alex deleted this room/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    expect(navigate).toHaveBeenCalledWith("/");
    cleanup();
    wrap(<RoomDeleted by={null} canGoHome={false} />);
    expect(screen.getByText(/An owner deleted this room/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Brand", () => {
  it("links home client-side, except for modified clicks", () => {
    wrap(<Brand />);
    const link = screen.getByRole("link", { name: "WatchParty home" });
    fireEvent.click(link, { metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("is just the logo for guests, optionally without the word", () => {
    wrap(<Brand link={false} showWord={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("WatchParty")).toBeNull();
  });
});

describe("AppBar", () => {
  it("offers Home when there's no new-room action, and no Log out without auth", async () => {
    wrap(<AppBar />, false);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Home" }));
    expect(navigate).toHaveBeenCalledWith("/");
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    await screen.findByRole("menuitem", { name: "Home" });
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull();
  });
});

describe("Avatar", () => {
  it("shows a picture or initials, presence and speaking", () => {
    const { container } = wrap(
      <>
        <UserAvatar id="a" name="Sam Smith" presence speaking />
        <UserAvatar id="b" picture="https://img.example.com/b.png" />
      </>,
    );
    const [a, b] =
      container.querySelectorAll<HTMLElement>("[aria-hidden=true]");
    expect(a.textContent).toBe("SS");
    expect(a.dataset.speaking).toBe("true");
    expect(b.querySelector("img")?.getAttribute("src")).toBe(
      "https://img.example.com/b.png",
    );
  });

  it("stacks up to max and counts the rest", () => {
    const users = ["a", "b", "c", "d", "e", "f"].map((id) => ({
      id,
      name: id.toUpperCase(),
    }));
    const { container } = wrap(
      <AvatarStack users={users} max={4} speaking={["b"]} />,
    );
    expect(container.textContent).toContain("+2");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      "A, B, C, D, E, F",
    );
  });
});
