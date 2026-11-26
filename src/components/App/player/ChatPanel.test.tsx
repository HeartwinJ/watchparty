// The chat panel over the player: it opens with Shift+C (sidebar collapsed), renders inside the player (the
// fullscreen element), and the chat's popovers and emoji picker render inside it too, not in document.body.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: any[]) => void;
class FakeSocket {
  listeners = new Map<string, Listener[]>();
  emitted: [string, ...unknown[]][] = [];
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push([event, ...args]);
    return this;
  }
  disconnect() {
    return this;
  }
  receive(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
}
const sockets: FakeSocket[] = [];
vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }),
}));
vi.mock("../../../utils/generateName", () => ({
  generateName: async () => "Sam",
}));
vi.mock("../../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/api")>()),
  apiFetch: vi.fn(async () => new Response("[]")),
}));
vi.mock("../../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/utils")>()),
  testAutoplay: async () => true,
}));
// emoji-mart's web component fetches its data from a CDN; a plain element stands in for it
vi.mock("emoji-mart", () => ({
  Picker: class {
    constructor() {
      const el = document.createElement("div");
      el.setAttribute("data-testid", "emoji-mart");
      return el;
    }
  },
}));

const { App } = await import("../App");
const { AuthContext } = await import("../../AuthGate/AuthGate");

beforeEach(() => {
  sockets.length = 0;
  window.localStorage.clear();
  // The sidebar is collapsed, so the panel is available without fullscreen
  window.localStorage.setItem("wp-sidebar-collapsed", "1");
  // happy-dom has no layout: give elements (the player) a desktop size
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1280,
    bottom: 720,
    width: 1280,
    height: 720,
    toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// env="test" renders Mantine portals in place, which would hide where they really go
async function renderRoom(env: "test" | "default" = "test") {
  render(
    <MantineProvider env={env}>
      <AuthContext.Provider
        value={{
          authRequired: false,
          role: "owner",
          logout: async () => {},
          roomAccessLost: () => {},
        }}
      >
        <App urlRoomId="panel-room" />
      </AuthContext.Provider>
    </MantineProvider>,
  );
  await waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  await act(async () => socket.receive("connect"));
  const me = window.localStorage.getItem("watchparty-clientid") ?? "me";
  await act(async () => {
    socket.receive("roster", [{ id: me }, { id: "bob" }]);
    socket.receive("REC:nameMap", { [me]: "Sam", bob: "Bob" });
    socket.receive("chatinit", [
      {
        id: "bob",
        msg: "anyone there?",
        timestamp: "2026-01-01T10:00:00.000Z",
        reactions: { "👍": ["bob"] },
      },
    ]);
  });
  return socket;
}

const playerEl = () =>
  document.querySelector("[data-fullscreen]") as HTMLElement;
const panelEl = () =>
  document.querySelector("section[data-no-shortcuts]") as HTMLElement | null;
const pressShiftC = () =>
  act(async () => {
    fireEvent.keyDown(document.body, { key: "C", shiftKey: true });
  });

describe("chat panel over the player", () => {
  it("opens collapsed-by-default with Shift+C inside the player and focuses its input", async () => {
    await renderRoom();
    expect(panelEl()).toBeNull();
    await pressShiftC();
    const panel = panelEl();
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute("data-open")).toBe("true");
    expect(playerEl().contains(panel)).toBe(true);
    expect(within(panel!).getByText("anyone there?")).toBeTruthy();
    const input = within(panel!).getByPlaceholderText("Message everyone");
    expect(document.activeElement).toBe(input);

    // c focuses the panel's input rather than opening quick chat
    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "c" });
    });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByLabelText("Message everyone")).toBeNull();

    // The close button collapses it
    await act(async () => {
      fireEvent.click(within(panel!).getByLabelText("Close chat"));
    });
    expect(panel!.getAttribute("data-open")).toBe("false");
    // With the panel closed, c opens the one-line quick chat again
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "c" });
    });
    expect(screen.getByLabelText("Message everyone")).toBeTruthy();
  });

  it("sends from the panel through the room's chat command", async () => {
    const socket = await renderRoom();
    await pressShiftC();
    const input = within(panelEl()!).getByPlaceholderText("Message everyone");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(socket.emitted).toContainEqual(["CMD:chat", "hello"]);
  });

  it("portals the reaction hover card and renders the emoji picker inside the player", async () => {
    await renderRoom("default");
    await pressShiftC();
    const panel = panelEl()!;

    const chip = within(panel).getByRole("button", { pressed: false });
    await act(async () => {
      fireEvent.mouseEnter(chip);
    });
    const tip = await screen.findByText("Bob reacted.");
    expect(playerEl().contains(tip)).toBe(true);

    await act(async () => {
      fireEvent.click(within(panel).getByLabelText("Insert emoji"));
    });
    const picker = await within(panel).findByTestId("emoji-mart");
    expect(playerEl().contains(picker)).toBe(true);
  });

  it("Esc closes the emoji picker first, then the panel", async () => {
    await renderRoom();
    await pressShiftC();
    const panel = panelEl()!;
    const escape = (target: Element) =>
      act(async () => {
        fireEvent.keyDown(target, { key: "Escape" });
      });

    // Focus inside the panel (the picker's own search box sits there too)
    await act(async () => {
      fireEvent.click(within(panel).getByLabelText("Insert emoji"));
    });
    const input = within(panel).getByPlaceholderText("Message everyone");
    await within(panel).findByTestId("emoji-mart");
    await escape(input);
    expect(within(panel).queryByTestId("emoji-mart")).toBeNull();
    expect(panel.getAttribute("data-open")).toBe("true");

    // Focus outside the panel: the player's Esc still closes only the picker
    await act(async () => {
      fireEvent.click(within(panel).getByLabelText("Insert emoji"));
    });
    await within(panel).findByTestId("emoji-mart");
    await escape(document.body);
    expect(within(panel).queryByTestId("emoji-mart")).toBeNull();
    expect(panel.getAttribute("data-open")).toBe("true");

    // Nothing else open: Esc closes the panel
    await escape(document.body);
    expect(panel.getAttribute("data-open")).toBe("false");
  });

  it("clicking the video closes the panel without pausing", async () => {
    const socket = await renderRoom();
    await pressShiftC();
    const gestures = playerEl().querySelector(
      '[aria-hidden="true"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(gestures, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(gestures, { button: 0, pointerType: "mouse" });
    });
    expect(panelEl()!.getAttribute("data-open")).toBe("false");
    expect(socket.emitted.some(([e]) => e === "CMD:pause")).toBe(false);
  });
});
