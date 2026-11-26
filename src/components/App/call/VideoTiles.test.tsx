// The video tile strip renders who has their camera on, enlarges on click, collapses and hides (per device).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { initialCallState } from "./callReducer";
import { CallVideo } from "./videoStreams";
import { VideoTiles } from "./VideoTiles";
import type { Room } from "../hooks/useRoom";

vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const member = (clientId: string, camera: boolean, muted = false) => ({
  clientId,
  session: `${clientId.slice(0, 8)}session`,
  muted,
  camera,
  joinedAt: 1,
  reconnecting: false,
  wantsVideo: true,
});

function fakeRoom(opts: {
  camera?: boolean;
  members: CallMember[];
  tilesCollapsed?: boolean;
}) {
  const call = {
    ...initialCallState({ pushToTalk: false, ducking: false }),
    status: "joined" as const,
    session: "aaaaaaaasession",
    camera: opts.camera ?? false,
    members: opts.members,
    tilesCollapsed: opts.tilesCollapsed ?? false,
  };
  const setTilesHidden = vi.fn();
  const setTilesCollapsed = vi.fn();
  const room = {
    clientId: ME,
    state: {
      call,
      nameMap: { [ME]: "Me", [BOB]: "Bob", [CAT]: "Cat" },
      pictureMap: {},
    },
    call: { video: new CallVideo(), setTilesHidden, setTilesCollapsed },
  } as unknown as Room;
  return { room, setTilesHidden, setTilesCollapsed };
}

function playerEl() {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { value: 1280 });
  Object.defineProperty(el, "offsetHeight", { value: 720 });
  return el;
}

const renderTiles = (room: Room) =>
  render(
    <MantineProvider>
      <VideoTiles
        room={room}
        container={playerEl()}
        fullscreen={false}
        phone={false}
        controls
      />
    </MantineProvider>,
  );

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("VideoTiles", () => {
  it("shows nothing while nobody has their camera on", () => {
    const { room } = fakeRoom({
      members: [member(ME, false), member(BOB, false)],
    });
    renderTiles(room);
    expect(screen.queryByRole("region", { name: "Call video" })).toBeNull();
  });

  it("shows a tile per camera, enlarges on click, collapses and hides", () => {
    const { room, setTilesHidden, setTilesCollapsed } = fakeRoom({
      camera: true,
      members: [member(ME, false), member(BOB, true, true), member(CAT, false)],
    });
    renderTiles(room);
    // Us (by our own camera state) and Bob; not Cat
    const me = screen.getByRole("button", { name: /^Me \(you\)/ });
    const bob = screen.getByRole("button", { name: /^Bob/ });
    expect(screen.queryByRole("button", { name: /^Cat/ })).toBeNull();
    expect(bob.querySelector('[aria-label="Muted"]')).not.toBeNull();
    expect(me).toBeTruthy();

    fireEvent.click(bob);
    expect(
      screen.getByRole("button", { name: /^Bob/ }).getAttribute("aria-pressed"),
    ).toBe("true");

    // Collapsing goes through the call (it stops video to us while collapsed)
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse call video" }),
    );
    expect(setTilesCollapsed).toHaveBeenCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide video tiles on this device" }),
    );
    expect(setTilesHidden).toHaveBeenCalledWith(true);
  });

  it("collapsed (state.call.tilesCollapsed): a pill that expands through the call", () => {
    const { room, setTilesCollapsed } = fakeRoom({
      camera: true,
      tilesCollapsed: true,
      members: [member(ME, false), member(BOB, true)],
    });
    renderTiles(room);
    expect(screen.queryByRole("button", { name: /^Bob/ })).toBeNull();
    act(() =>
      fireEvent.click(
        screen.getByRole("button", { name: "Show call video (2)" }),
      ),
    );
    expect(setTilesCollapsed).toHaveBeenCalledWith(false);
  });
});
