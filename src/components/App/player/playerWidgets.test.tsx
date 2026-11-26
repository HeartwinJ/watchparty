// Small player pieces: menus, the sync pill, the ready check pill, the shortcuts overlay and the convert pill.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { PlayerMenu } from "./PlayerMenu";
import { SyncIndicator, describeSyncStatus } from "./SyncIndicator";
import { ReadyCheckPill } from "./ReadyCheckPill";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { ConvertStatus } from "../picker/ConvertStatus";
import { renderWithPlayerRoom } from "../../../test/playerRoom";

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<MantineProvider env="test">{ui}</MantineProvider>);

describe("PlayerMenu", () => {
  function setup(open = true, sheet = false, withTarget = true) {
    const onClose = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const trigger = createRef<HTMLButtonElement>();
    const r = render(
      <>
        <button ref={trigger}>Trigger</button>
        <button>Elsewhere</button>
        <PlayerMenu
          open={open}
          onClose={onClose}
          target={withTarget ? target : null}
          sheet={sheet}
          label="Speed"
          id="m"
          size="small"
          trigger={trigger}
        >
          <button aria-checked="false">One</button>
          <button aria-checked="true">Two</button>
        </PlayerMenu>
      </>,
    );
    return { ...r, onClose, target, trigger };
  }

  it("renders nothing while closed", () => {
    setup(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("portals into the target and focuses the checked option", () => {
    const { target } = setup();
    const menu = screen.getByRole("dialog", { name: "Speed" });
    expect(target.contains(menu)).toBe(true);
    expect(menu.getAttribute("data-size")).toBe("small");
    // Regression: the checked option, not the first button in the menu
    expect(document.activeElement?.textContent).toBe("Two");
  });

  it("focuses the first control when nothing is checked", () => {
    render(
      <PlayerMenu
        open
        onClose={() => {}}
        target={null}
        sheet={false}
        label="Subs"
        id="s"
      >
        <span>Label</span>
        <button>First</button>
        <button>Second</button>
      </PlayerMenu>,
    );
    expect(document.activeElement?.textContent).toBe("First");
  });

  it("renders in place without a target, and as a sheet in the body", () => {
    setup(true, false, false);
    expect(screen.getByRole("dialog")).toBeTruthy();
    cleanup();
    const { target } = setup(true, true);
    const menu = screen.getByRole("dialog");
    expect(menu.getAttribute("data-sheet")).toBe("true");
    expect(target.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it("closes on Escape (focus back on the trigger) and on a pointer down outside", () => {
    const { onClose, trigger } = setup();
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger.current);
    // Inside the menu or on the trigger: stays open
    fireEvent.pointerDown(screen.getByText("One"));
    fireEvent.pointerDown(trigger.current!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("describeSyncStatus", () => {
  it("describes every status", () => {
    expect(describeSyncStatus({ kind: "in-sync" })).toMatchObject({
      label: "In sync",
      tone: "success",
    });
    expect(
      describeSyncStatus({ kind: "catching-up", behind: 1.25 }),
    ).toMatchObject({ label: "Catching up · 1.3 s behind", tone: "warning" });
    expect(
      describeSyncStatus({ kind: "catching-up", behind: -0.5 }),
    ).toMatchObject({ short: "0.5 s ahead" });
    expect(describeSyncStatus({ kind: "buffering" })).toMatchObject({
      busy: true,
    });
    expect(describeSyncStatus({ kind: "reconnecting" })).toMatchObject({
      tone: "danger",
    });
  });
});

describe("SyncIndicator", () => {
  const participants = [{ id: "me" }, { id: "bob" }, { id: "eve" }] as any;

  it("renders nothing without media", () => {
    renderWithPlayerRoom((room) => <SyncIndicator room={room} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists everyone's drift against the leader and resyncs", () => {
    const r = renderWithPlayerRoom((room) => <SyncIndicator room={room} />, {
      state: {
        roomMedia: "https://example.com/a.mp4",
        participants,
        nameMap: { me: "Sam", bob: "Bob" },
        tsMap: { me: 100, bob: 100, eve: 96 },
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Playback sync: In sync" }),
    );
    expect(screen.getByText("Playback sync")).toBeTruthy();
    expect(screen.getByText("(you)")).toBeTruthy();
    // eve has no name
    expect(screen.getByText("Someone")).toBeTruthy();
    expect(screen.getByText("4.0 s behind")).toBeTruthy();
    fireEvent.click(screen.getByText("Resync me to the room"));
    expect(r.player.resync).toHaveBeenCalled();
  });

  it("live streams only say Watching for the others", () => {
    renderWithPlayerRoom((room) => <SyncIndicator room={room} />, {
      state: {
        roomMedia: "https://example.com/live.m3u8",
        isLiveStream: true,
        participants,
        tsMap: { me: 1, bob: 50 },
      },
    });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("Watching")).toHaveLength(2);
  });

  it("mini: the short label, a spinner while buffering and the nudge rate", () => {
    const { unmount } = renderWithPlayerRoom(
      (room) => <SyncIndicator room={room} variant="mini" />,
      {
        state: {
          roomMedia: "https://example.com/a.mp4",
          syncStatus: { kind: "catching-up", behind: 1.5 },
        },
        media: { rate: 1.05 },
      },
    );
    expect(screen.getByText("1.5 s behind")).toBeTruthy();
    expect(screen.getByText("1.05×")).toBeTruthy();
    unmount();
    renderWithPlayerRoom(
      (room) => <SyncIndicator room={room} variant="mini" />,
      {
        state: {
          roomMedia: "https://example.com/a.mp4",
          syncStatus: { kind: "buffering" },
        },
      },
    );
    expect(screen.getByText("Buffering…")).toBeTruthy();
    expect(screen.queryByText(/×$/)).toBeNull();
  });
});

describe("ReadyCheckPill", () => {
  it("renders nothing unless a check is active", () => {
    wrap(
      <ReadyCheckPill
        state={{ active: false, waitingFor: [] }}
        nameMap={{}}
        pictureMap={{}}
        clientId="me"
        onSkip={() => {}}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names who it waits for and resumes", () => {
    const onSkip = vi.fn();
    const outer = vi.fn();
    render(
      <MantineProvider env="test">
        <div onClick={outer}>
          <ReadyCheckPill
            state={{ active: true, waitingFor: ["bob", "me"] }}
            nameMap={{ bob: "Bob" }}
            pictureMap={{ bob: "https://example.com/b.png" }}
            clientId="me"
            onSkip={onSkip}
          />
        </div>
      </MantineProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain("Waiting for");
    expect(screen.getByRole("status").textContent).toContain("Bob");
    fireEvent.click(screen.getByRole("button", { name: "Resume now" }));
    expect(onSkip).toHaveBeenCalled();
    // The click doesn't reach the player underneath
    expect(outer).not.toHaveBeenCalled();
  });

  it("says Getting ready with nobody left", () => {
    wrap(
      <ReadyCheckPill
        state={{ active: true, waitingFor: [] }}
        nameMap={{}}
        pictureMap={{}}
        clientId="me"
        onSkip={() => {}}
      />,
    );
    expect(screen.getByText("Getting ready…")).toBeTruthy();
  });
});

describe("ShortcutsOverlay", () => {
  it("focuses close, lists the shortcuts and restores focus on unmount", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    const onClose = vi.fn();
    const { unmount } = render(<ShortcutsOverlay onClose={onClose} />);
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
    );
    expect(screen.getByText("Fullscreen")).toBeTruthy();
    unmount();
    expect(document.activeElement).toBe(before);
  });

  it("closes with the button, Esc and a click on the scrim (not inside)", () => {
    const onClose = vi.fn();
    render(<ShortcutsOverlay onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "x" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("ConvertStatus", () => {
  it("renders nothing without a status", () => {
    wrap(<ConvertStatus status={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the label with the reason in a tooltip", async () => {
    wrap(
      <ConvertStatus
        status={{
          label: "Converting · 34% buffered",
          progress: 0.34,
          heavy: true,
          reason: "HEVC video",
        }}
      />,
    );
    const pill = screen.getByRole("status");
    expect(pill.textContent).toContain("Converting · 34% buffered");
    await act(async () => {
      fireEvent.mouseEnter(pill);
    });
    expect(
      await screen.findByText(
        "HEVC video. The video is re-encoded on this device.",
      ),
    ).toBeTruthy();
  });
});
