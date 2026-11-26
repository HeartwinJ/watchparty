// Home: starting rooms (button, pasted link, menu), link validation, recent rooms (open, delete, failures).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../router")>()),
  navigate: (...args: unknown[]) => navigate(...args),
}));
const toastMock = vi.fn();
vi.mock("../App/ui/toast", () => ({
  toast: (...a: unknown[]) => toastMock(...a),
}));

type Handler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;
let handler: Handler;
const apiFetch = vi.fn((url: string, init?: RequestInit) => handler(url, init));
vi.mock("../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/api")>()),
  apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
}));

const { Home } = await import("./Home");
const { AuthContext } = await import("../AuthGate/AuthGate");
const { RECENT_ROOMS_KEY } = await import("../../utils/recentRooms");

const logout = vi.fn(async () => {});
const renderHome = () =>
  render(
    <MantineProvider env="test">
      <AuthContext.Provider
        value={{
          authRequired: true,
          role: "owner",
          logout,
          roomAccessLost: () => {},
        }}
      >
        <Home />
      </AuthContext.Provider>
    </MantineProvider>,
  );

const defaultHandler: Handler = (url, init) => {
  if (url.startsWith("/history")) return new Response("[]");
  if (url === "/createRoom")
    return new Response(JSON.stringify({ name: "/new-room" }));
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
  return new Response("{}");
};

beforeEach(() => {
  window.localStorage.clear();
  navigate.mockClear();
  toastMock.mockClear();
  apiFetch.mockClear();
  logout.mockClear();
  handler = defaultHandler;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pasteInput = () =>
  screen.getByPlaceholderText("YouTube, .m3u8 or video URL");
const createCalls = () =>
  apiFetch.mock.calls.filter(([u]) => u === "/createRoom");

describe("starting a room", () => {
  it("Start a room creates one and goes there", async () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Start a room" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/watch/new-room", {
        replace: undefined,
      }),
    );
    expect(JSON.parse(createCalls()[0][1]!.body as string)).toEqual({
      video: "",
    });
  });

  it("toasts when the server can't create a room, and lets you try again", async () => {
    handler = (url, init) =>
      url === "/createRoom"
        ? new Response("", { status: 500 })
        : defaultHandler(url, init);
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Start a room" }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Couldn't create a room. Try again in a moment.",
        { tone: "danger" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start a room" }));
    await waitFor(() => expect(createCalls()).toHaveLength(2));
  });

  it("validates a pasted link before starting a room with it", async () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByText("Paste a link first.")).toBeTruthy();
    fireEvent.change(pasteInput(), { target: { value: "cats" } });
    expect(screen.queryByText("Paste a link first.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByText(/doesn't look like a link/)).toBeTruthy();
    expect(createCalls()).toHaveLength(0);

    fireEvent.change(pasteInput(), {
      target: { value: " https://cdn.example.com/live.m3u8 " },
    });
    expect(screen.getByText("HLS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(JSON.parse(createCalls()[0][1]!.body as string)).toEqual({
      video: "https://cdn.example.com/live.m3u8",
    });
  });

  it("Try chips fill in example links", () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "YouTube" }));
    expect((pasteInput() as HTMLInputElement).value).toMatch(
      /youtube\.com|youtu\.be/,
    );
  });

  it("the menu starts a room and logs out", async () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Start a room" }),
    );
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
    expect(logout).toHaveBeenCalled();
  });
});

describe("recent rooms", () => {
  const store = (rooms: object[]) =>
    window.localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(rooms));

  it("explains the empty list", () => {
    renderHome();
    expect(screen.getByText(/Rooms you join show up here/)).toBeTruthy();
  });

  it("lists rooms with their title or name and opens them client-side (not with modifier keys)", () => {
    store([
      {
        roomId: "brave-otter",
        lastTitle: "",
        roomTitle: "Movie night",
        visitedAt: Date.now(),
      },
      {
        roomId: "calm-fox",
        lastTitle: "Big Movie",
        roomTitle: "",
        visitedAt: Date.now(),
      },
    ]);
    renderHome();
    expect(screen.getByText("Nothing played yet")).toBeTruthy();
    expect(screen.getByText("Big Movie")).toBeTruthy();
    const link = screen.getByText("Movie night").closest("a")!;
    expect(link.getAttribute("href")).toBe("/watch/brave-otter");
    fireEvent.click(link, { ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith("/watch/brave-otter");
    expect(screen.getByText("Calm fox")).toBeTruthy();
  });

  it("keeps the room and toasts when deleting fails; Cancel closes the dialog", async () => {
    store([
      {
        roomId: "calm-fox",
        lastTitle: "",
        roomTitle: "",
        visitedAt: Date.now(),
      },
    ]);
    handler = (url, init) =>
      init?.method === "DELETE"
        ? new Response("", { status: 500 })
        : defaultHandler(url, init);
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Delete Calm fox" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Delete Calm fox?")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Calm fox" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete room" }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Couldn't delete the room. Try again in a moment.",
        { tone: "danger" },
      ),
    );
    expect(screen.getByText("Calm fox")).toBeTruthy();
    expect(window.localStorage.getItem(RECENT_ROOMS_KEY)).toContain("calm-fox");
  });
});
