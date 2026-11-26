// The People tab: invite box (with/without the room password), roster states, call icons, rename, owner menus.
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateName = vi.fn(async () => "Lucky Llama");
vi.mock("../../../utils/generateName", () => ({
  generateName: () => generateName(),
}));

const { PeoplePanel } = await import("./PeoplePanel");
const { fakeRoom, renderUi } = await import("../../../test/renderRoom");
const { initialCallState } = await import("../call/callReducer");

const writeText = vi.fn(async (_t: string) => {});
beforeEach(() => {
  writeText.mockClear();
  generateName.mockReset().mockResolvedValue("Lucky Llama");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(() => cleanup());

const member = (clientId: string, over = {}) => ({
  clientId,
  session: "s",
  muted: false,
  camera: false,
  joinedAt: 1,
  reconnecting: false,
  ...over,
});

function setup(
  role: "owner" | "guest",
  over: Parameters<typeof fakeRoom>[0] = {},
  player: { hasDuration?: boolean; leader?: number } = {},
) {
  const room = fakeRoom({
    participants: [{ id: "bob" }, { id: "me" }],
    nameMap: { me: "Sam", bob: "Bob" },
    myName: "Sam",
    ...over,
  });
  room.player.hasDuration.mockReturnValue(player.hasDuration ?? false);
  room.player.getLeaderTime.mockReturnValue(player.leader ?? 0);
  renderUi(<PeoplePanel room={room} />, { role });
  return room;
}

describe("invite box", () => {
  it("guests copy the plain link (the password isn't theirs to share)", async () => {
    setup("guest", { roomAccess: { enabled: true } });
    expect(
      screen.getByText("They'll need the room password once."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with password/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith(
      window.location.origin + window.location.pathname,
    );
  });

  it("owners also copy the link with the password while it's required", async () => {
    setup("owner", { roomAccess: { enabled: true, password: "otter-42" } });
    expect(
      screen.getByText(
        "With the plain link, they type the room password once.",
      ),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy with password" }),
      );
    });
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringMatching(/#pw=otter-42$/),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(writeText).toHaveBeenLastCalledWith(
      expect.not.stringContaining("#pw="),
    );
  });

  it("says anyone can join while the password is off", () => {
    setup("owner", { roomAccess: { enabled: false } });
    expect(screen.getByText("Anyone with the link can join.")).toBeTruthy();
  });
});

describe("roster", () => {
  it("lists you first, with playback states", () => {
    setup(
      "guest",
      {
        roomMedia: "https://cdn.example.com/a.mp4",
        tsMap: { me: 100, bob: 80 },
      },
      { hasDuration: true, leader: 100 },
    );
    expect(screen.getByText("In the room · 2")).toBeTruthy();
    const names = [...document.querySelectorAll("li")].map(
      (li) => li.querySelector("span[class*=ellipsis]")?.textContent,
    );
    expect(names).toEqual(["Sam", "Bob"]);
    expect(screen.getByText("(you)")).toBeTruthy();
    expect(screen.getByText(/In sync · 01:40/)).toBeTruthy();
    expect(screen.getByText(/20 s behind · 01:20/)).toBeTruthy();
  });

  it("shows Idle without media, Buffering… while the ready check waits, and unknown names", () => {
    setup("guest", {
      participants: [{ id: "me" }, { id: "x" }],
      nameMap: { me: "Sam" },
    });
    expect(screen.getAllByText("Idle")).toHaveLength(2);
    expect(screen.getByText("Someone")).toBeTruthy();
    cleanup();
    setup("guest", {
      roomMedia: "https://cdn.example.com/a.mp4",
      readyCheck: {
        active: true,
        waitingFor: ["bob"],
        deadline: 0,
        reason: "buffering",
      } as any,
    });
    expect(screen.getByText("Buffering…")).toBeTruthy();
  });

  it("shows screen and file sharing", () => {
    setup("guest", {
      participants: [{ id: "me" }, { id: "bob", isScreenShare: true }],
      roomMedia: "screenshare://bob",
    });
    expect(screen.getByLabelText("Sharing their screen")).toBeTruthy();
    cleanup();
    setup("guest", {
      participants: [{ id: "me" }, { id: "bob", isScreenShare: true }],
      roomMedia: "fileshare://bob",
    });
    expect(screen.getByLabelText("Sharing a file")).toBeTruthy();
  });

  it("shows call icons: in call, muted, reconnecting; your own mute follows push-to-talk", () => {
    const call = {
      ...initialCallState({ pushToTalk: false, ducking: true }),
      members: [member("bob", { muted: true }), member("me", { muted: false })],
    };
    setup("guest", { call });
    expect(screen.getByLabelText("In the voice call, muted")).toBeTruthy();
    expect(screen.getByLabelText("In the voice call")).toBeTruthy();
    cleanup();
    setup("guest", {
      call: {
        ...call,
        status: "joined",
        pushToTalk: true,
        pttHeld: false,
        members: [member("me"), member("bob", { reconnecting: true })],
      } as any,
    });
    // Push-to-talk not held: you're muted; Bob is reconnecting
    expect(screen.getByLabelText("In the voice call, muted")).toBeTruthy();
    expect(
      document.querySelector("[data-reconnecting]")?.getAttribute("aria-label"),
    ).toBe("In the voice call");
  });
});

describe("owners", () => {
  it("can remove someone from the room, and moderate them in the call", () => {
    const room = setup("owner", {
      call: {
        ...initialCallState({ pushToTalk: false, ducking: true }),
        members: [member("bob", { camera: true })],
      },
    });
    const open = () =>
      fireEvent.click(screen.getByRole("button", { name: "Options for Bob" }));
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Mute in call/ }));
    expect(room.call.moderate).toHaveBeenLastCalledWith("bob", "mute");
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Turn off camera/ }));
    expect(room.call.moderate).toHaveBeenLastCalledWith("bob", "camera");
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from call/ }));
    expect(room.call.moderate).toHaveBeenLastCalledWith("bob", "remove");
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from room/ }));
    expect(room.cmd.kickUser).toHaveBeenCalledWith("bob");
  });

  it("don't get call actions for people outside the call, and have no menu on themselves", () => {
    setup("owner");
    fireEvent.click(screen.getByRole("button", { name: "Options for Bob" }));
    expect(screen.queryByRole("menuitem", { name: /in call/ })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: /Remove from room/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Options for Sam" }),
    ).toBeNull();
  });

  it("guests get no person menu", () => {
    setup("guest");
    expect(
      screen.queryByRole("button", { name: "Options for Bob" }),
    ).toBeNull();
  });
});

describe("rename", () => {
  it("saves a trimmed new name, not an unchanged one", async () => {
    const room = setup("guest");
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    const input = (await screen.findByLabelText(
      "Your name",
    )) as HTMLInputElement;
    expect(input.value).toBe("Sam");
    fireEvent.submit(input.closest("form")!);
    expect(room.updateName).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    fireEvent.change(await screen.findByLabelText("Your name"), {
      target: { value: "  Alex  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(room.updateName).toHaveBeenCalledWith("Alex");
  });

  it("picks a random name, keeps the draft if that fails, and Cancel closes", async () => {
    const room = setup("guest");
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    const input = (await screen.findByLabelText(
      "Your name",
    )) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Random name" }));
    await waitFor(() => expect(input.value).toBe("Lucky Llama"));
    generateName.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Random name" }));
    await waitFor(() => expect(generateName).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("Lucky Llama");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Your name")).toBeNull(),
    );
    expect(room.updateName).not.toHaveBeenCalled();
    // The pencil toggles it
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    await screen.findByLabelText("Your name");
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Your name")).toBeNull(),
    );
  });
});
