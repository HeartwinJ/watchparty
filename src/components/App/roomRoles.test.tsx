// Owners vs room guests on the room page: guests don't get room management (settings, room password, removing
// people) or Home links, and never see the room password.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
vi.mock("../../utils/generateName", () => ({
  generateName: async () => "Sam",
}));
vi.mock("../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/api")>()),
  apiFetch: vi.fn(async () => new Response("[]")),
}));
vi.mock("../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/utils")>()),
  testAutoplay: async () => true,
}));

const { App } = await import("./App");
const { AuthContext } = await import("../AuthGate/AuthGate");

const PASSWORD = "otter-maple-42";

beforeEach(() => {
  sockets.length = 0;
  window.localStorage.clear();
});
afterEach(() => cleanup());

async function renderRoom(role: "owner" | "guest") {
  render(
    <MantineProvider env="test">
      <AuthContext.Provider
        value={{
          authRequired: true,
          role,
          logout: async () => {},
          roomAccessLost: () => {},
        }}
      >
        <App urlRoomId="roles-room" />
      </AuthContext.Provider>
    </MantineProvider>,
  );
  await waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  await act(async () => socket.receive("connect"));
  // useRoom stores its client id in localStorage (getOrCreateClientId)
  const me = window.localStorage.getItem("watchparty-clientid") ?? "me";
  await act(async () => {
    socket.receive("roster", [{ id: me }, { id: "bob" }]);
    socket.receive("REC:nameMap", { [me]: "Sam", bob: "Bob" });
    // What the server sends each role
    socket.receive(
      "REC:roomAccess",
      role === "owner"
        ? { enabled: true, password: PASSWORD }
        : { enabled: true },
    );
  });
  return socket;
}

const openPeople = async () => {
  const tab = screen
    .getAllByRole("tab")
    .find((t) => /People/.test(t.textContent ?? ""));
  await act(async () => {
    fireEvent.click(tab!);
  });
};
const openSettings = async () => {
  await act(async () => {
    fireEvent.click(screen.getAllByTitle("Room settings")[0]);
  });
};

describe("room page roles", () => {
  it("owners can remove people, copy links with the password and manage the room password", async () => {
    const socket = await renderRoom("owner");
    await openPeople();
    expect(
      screen.getByRole("button", { name: "Options for Bob" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy with password" }),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Options for Bob" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByText("Remove from room"));
    });
    expect(socket.emitted).toContainEqual([
      "CMD:kickUser",
      { userToBeKicked: "bob" },
    ]);

    await openSettings();
    expect(await screen.findByText("Require a password")).toBeTruthy();
    expect(screen.getByLabelText("Room password (hidden)")).toBeTruthy();
    expect(document.body.textContent).not.toContain(PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    });
    expect(screen.getByLabelText("Room password").textContent).toBe(PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    });
    expect(socket.emitted).toContainEqual([
      "CMD:roomPassword",
      { action: "regenerate" },
    ]);
  });

  it("guests get no room management, no Home link and never the password", async () => {
    await renderRoom("guest");
    await openPeople();
    expect(
      screen.queryByRole("button", { name: "Options for Bob" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy with password" }),
    ).toBeNull();
    expect(
      screen.getByText("They'll need the room password once."),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "WatchParty home" })).toBeNull();

    await openSettings();
    expect(
      await screen.findByText(/Only the room's owner can change/),
    ).toBeTruthy();
    expect(screen.queryByText("Require a password")).toBeNull();
    expect(screen.queryByLabelText("Room title")).toBeNull();
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it("the ready check switch asks the server and follows its REC:roomSettings", async () => {
    const socket = await renderRoom("owner");
    await openSettings();
    const toggle = (await screen.findByRole("switch", {
      name: /Ready check/,
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(socket.emitted).toContainEqual([
      "CMD:roomSettings",
      { readyCheck: true },
    ]);
    await act(async () => {
      socket.receive("REC:roomSettings", {
        title: "",
        readyCheck: true,
        nextEpisodeOffset: 25,
      });
    });
    expect(
      (screen.getByRole("switch", { name: /Ready check/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("owners can delete the room after confirming; guests can't", async () => {
    const socket = await renderRoom("owner");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More options" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByText("Delete room"));
    });
    expect(
      await screen.findByText(/Everyone in it will be sent out/),
    ).toBeTruthy();
    expect(socket.emitted.some(([e]) => e === "CMD:deleteRoom")).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete room" }));
    });
    expect(socket.emitted).toContainEqual(["CMD:deleteRoom"]);

    cleanup();
    sockets.length = 0;
    await renderRoom("guest");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More options" }));
    });
    await screen.findByText("Room settings", { selector: "[role=menuitem] *" });
    expect(screen.queryByText("Delete room")).toBeNull();
  });

  it("shows everyone else that the room was deleted and forgets it", async () => {
    const socket = await renderRoom("guest");
    expect(window.localStorage.getItem("wp-recent-rooms")).toContain(
      "roles-room",
    );
    await act(async () => {
      socket.receive("REC:roomDeleted", { by: { id: "bob", name: "Bob" } });
    });
    expect(await screen.findByText("This room was deleted")).toBeTruthy();
    expect(screen.getByText(/Bob deleted this room/)).toBeTruthy();
    // Guests can't go Home
    expect(screen.queryByRole("button", { name: "Go home" })).toBeNull();
    expect(window.localStorage.getItem("wp-recent-rooms")).not.toContain(
      "roles-room",
    );
  });

  it("takes the owner who deleted it Home", async () => {
    window.history.replaceState(null, "", "/watch/roles-room");
    const socket = await renderRoom("owner");
    const me = window.localStorage.getItem("watchparty-clientid");
    await act(async () => {
      socket.receive("REC:roomDeleted", { by: { id: me, name: "Sam" } });
    });
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByText("This room was deleted")).toBeNull();
  });
});
