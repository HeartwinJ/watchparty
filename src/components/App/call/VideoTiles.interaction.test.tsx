// The video tile strip: live video, the enlarged tile, dragging (saved per device, no click after a drag),
// reconnecting/joining states, and resizing with the player.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  FakeResizeObserver,
  FakeTrack,
  installResizeObserver,
} from "../../../test/browserFakes";
import { initialCallState, type CallUiState } from "./callReducer";
import { CallVideo } from "./videoStreams";
import { VideoTiles } from "./VideoTiles";
import type { Room } from "../hooks/useRoom";

const toast = vi.fn();
vi.mock("../ui/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const member = (clientId: string, extra: Partial<CallMember> = {}) => ({
  clientId,
  session: `${clientId.slice(0, 8)}session`,
  muted: false,
  camera: true,
  joinedAt: 1,
  reconnecting: false,
  ...extra,
});

function fakeRoom(patch: Partial<CallUiState> = {}) {
  const call: CallUiState = {
    ...initialCallState({ pushToTalk: false, ducking: false }),
    status: "joined",
    session: "aaaaaaaasession",
    camera: true,
    members: [member(ME), member(BOB)],
    peers: { [BOB]: "connected" },
    ...patch,
  };
  const video = new CallVideo();
  const room = {
    clientId: ME,
    state: { call, nameMap: { [ME]: "Me" }, pictureMap: {} },
    call: { video, setTilesHidden: vi.fn() },
  } as unknown as Room;
  return { room, video };
}

function playerEl(width = 1280, height = 720) {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(el, "offsetHeight", {
    configurable: true,
    value: height,
  });
  return el;
}

const renderTiles = (
  room: Room,
  container: HTMLElement | null = playerEl(),
  props: Partial<{
    fullscreen: boolean;
    phone: boolean;
    controls: boolean;
  }> = {},
) =>
  render(
    <MantineProvider env="test">
      <VideoTiles
        room={room}
        container={container}
        fullscreen={props.fullscreen ?? false}
        phone={props.phone ?? false}
        controls={props.controls ?? true}
        reserveRight={40}
      />
    </MantineProvider>,
  );

beforeEach(() => {
  installResizeObserver();
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.reject(new Error("background tab"))),
  });
  toast.mockClear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("VideoTiles", () => {
  it("renders nothing without a measured player or when hidden", () => {
    const { room } = fakeRoom();
    renderTiles(room, null);
    expect(screen.queryByRole("region")).toBeNull();
    cleanup();
    renderTiles(fakeRoom({ tilesHidden: true }).room);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("plays live video (ours mirrored) and shows avatars until frames arrive", () => {
    const { room, video } = fakeRoom();
    act(() => {
      video.setLocal(new FakeTrack("video") as unknown as MediaStreamTrack);
      const bob = new FakeTrack("video");
      bob.muted = true;
      video.addRemote(BOB, bob as unknown as MediaStreamTrack);
    });
    const { container, unmount } = renderTiles(room);
    const videos = container.querySelectorAll("video");
    expect(videos).toHaveLength(1);
    expect(videos[0].getAttribute("data-mirrored")).toBe("true");
    expect(videos[0].srcObject).toBe(video.getSnapshot().local);
    // Bob's frames arrive
    const bobTrack = (video as any).remote.get(BOB).track as FakeTrack;
    act(() => {
      bobTrack.muted = false;
      bobTrack.dispatch("unmute");
    });
    expect(container.querySelectorAll("video")).toHaveLength(2);
    // An unnamed member is "Someone"
    expect(
      screen.getByRole("button", { name: /^Someone: enlarge/ }),
    ).toBeTruthy();
    unmount();
    expect(videos[0].srcObject).toBeNull();
  });

  it("enlarges one tile above the others and makes it smaller again", () => {
    const { room } = fakeRoom();
    renderTiles(room);
    fireEvent.click(screen.getByRole("button", { name: /^Someone: enlarge/ }));
    const big = screen.getByRole("button", { name: /^Someone: make smaller/ });
    expect(big.getAttribute("data-enlarged")).toBe("true");
    fireEvent.click(big);
    expect(
      screen.getByRole("button", { name: /^Someone: enlarge/ }),
    ).toBeTruthy();
  });

  it("shows reconnecting for a dropped member and for us while rejoining", () => {
    const { room } = fakeRoom({
      status: "joining",
      muted: true,
      members: [member(ME), member(BOB, { reconnecting: true })],
    });
    renderTiles(room, playerEl(), { phone: true, fullscreen: true });
    expect(screen.getAllByText("Reconnecting…")).toHaveLength(2);
    // We're muted
    expect(screen.getAllByLabelText("Muted")).toHaveLength(1);
  });

  it("drags the strip, saves where it was dropped and doesn't enlarge on that click", () => {
    vi.useFakeTimers();
    try {
      const { room } = fakeRoom();
      renderTiles(room);
      const strip = screen.getByRole("region", { name: "Call video" });
      // Right button: no drag
      fireEvent.pointerDown(strip, {
        button: 2,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      });
      fireEvent.pointerMove(strip, {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      expect(strip.getAttribute("data-dragging")).toBeNull();

      fireEvent.pointerDown(strip, {
        button: 0,
        pointerId: 1,
        clientX: 20,
        clientY: 20,
      });
      // Another pointer is ignored; a tiny move isn't a drag yet
      fireEvent.pointerMove(strip, {
        pointerId: 2,
        clientX: 400,
        clientY: 400,
      });
      fireEvent.pointerMove(strip, { pointerId: 1, clientX: 22, clientY: 21 });
      expect(strip.getAttribute("data-dragging")).toBeNull();
      fireEvent.pointerMove(strip, {
        pointerId: 1,
        clientX: 600,
        clientY: 300,
      });
      fireEvent.pointerMove(strip, {
        pointerId: 1,
        clientX: 700,
        clientY: 320,
      });
      expect(strip.getAttribute("data-dragging")).toBe("true");
      fireEvent.pointerUp(strip, { pointerId: 2 });
      fireEvent.pointerUp(strip, { pointerId: 1 });
      expect(strip.getAttribute("data-dragging")).toBeNull();
      const saved = JSON.parse(window.localStorage.getItem("wp-call-tiles")!);
      expect(saved.fx).toBeGreaterThan(0);
      expect(saved.fy).toBeGreaterThan(0);
      // The click that ends a drag doesn't enlarge
      fireEvent.click(
        screen.getByRole("button", { name: /^Someone: enlarge/ }),
      );
      expect(screen.queryByRole("button", { name: /make smaller/ })).toBeNull();
      act(() => vi.runAllTimers());
      fireEvent.click(
        screen.getByRole("button", { name: /^Someone: enlarge/ }),
      );
      expect(screen.getByRole("button", { name: /make smaller/ })).toBeTruthy();
      // A press without moving doesn't save
      window.localStorage.removeItem("wp-call-tiles");
      fireEvent.pointerDown(strip, {
        button: 0,
        pointerId: 3,
        clientX: 5,
        clientY: 5,
      });
      fireEvent.pointerCancel(strip, { pointerId: 3 });
      expect(window.localStorage.getItem("wp-call-tiles")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a collapsed strip dragged doesn't expand on release", () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem(
        "wp-call-tiles",
        JSON.stringify({ fx: 0, fy: 0, collapsed: true }),
      );
      const { room } = fakeRoom();
      renderTiles(room);
      const strip = screen.getByRole("region", { name: "Call video" });
      fireEvent.pointerDown(strip, {
        button: 0,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      });
      fireEvent.pointerMove(strip, {
        pointerId: 1,
        clientX: 200,
        clientY: 200,
      });
      fireEvent.pointerUp(strip, { pointerId: 1 });
      fireEvent.click(
        screen.getByRole("button", { name: "Show call video (2)" }),
      );
      expect(
        screen.getByRole("button", { name: "Show call video (2)" }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hiding the tiles says where to get them back", () => {
    const { room } = fakeRoom();
    renderTiles(room);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide video tiles on this device" }),
    );
    expect(room.call.setTilesHidden).toHaveBeenCalledWith(true);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("Show them again in the call panel"),
      expect.anything(),
    );
  });

  it("re-measures when the player resizes", () => {
    const { room } = fakeRoom();
    const el = playerEl(1280, 720);
    renderTiles(room, el);
    const tile = screen.getByRole("button", { name: /^Someone/ });
    const before = tile.style.width;
    Object.defineProperty(el, "offsetWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(el, "offsetHeight", {
      configurable: true,
      value: 225,
    });
    act(() => FakeResizeObserver.trigger());
    expect(
      screen.getByRole("button", { name: /^Someone/ }).style.width,
    ).not.toBe(before);
  });

  it("works without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { room } = fakeRoom();
    renderTiles(room);
    expect(screen.getByRole("region", { name: "Call video" })).toBeTruthy();
  });
});
