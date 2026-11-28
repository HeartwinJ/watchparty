// The player view over a fake player: click/tap gestures, keyboard shortcuts, OSD, auto-hide, fullscreen, quick chat
// and the chat panel, the unmute scrim, empty/loading states, and the phone layout.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerArea } from "./PlayerArea";
import { DOUBLE_TAP_MS } from "../logic/gestures";
import {
  renderWithPlayerRoom,
  type RenderPlayerOptions,
} from "../../../test/playerRoom";
import { installMatchMedia } from "../../../test/browserFakes";

// emoji-mart's web component fetches its data from a CDN; a plain element stands in for it
vi.mock("emoji-mart", () => ({
  Picker: class {
    constructor() {
      return document.createElement("div");
    }
  },
}));

const MEDIA = "https://example.com/movie.mp4";

function setup(opts: RenderPlayerOptions = {}) {
  const r = renderWithPlayerRoom((room) => <PlayerArea room={room} />, {
    ...opts,
    state: { roomMedia: MEDIA, ...opts.state },
  });
  const focusInput = vi.fn();
  r.chatRef.current = { focusInput, scrollToBottom: vi.fn() };
  return { ...r, focusInput };
}

const playerEl = () =>
  document.querySelector("[data-fullscreen]") as HTMLElement;
const gestures = () =>
  playerEl().querySelector(':scope > [aria-hidden="true"]') as HTMLElement;
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key: k, ...init });
  });
const keyUp = (k: string) =>
  act(() => {
    fireEvent.keyUp(document.body, { key: k });
  });
const osd = () => playerEl().querySelector('[role="status"]')?.textContent;

function click(x = 640, pointerType = "mouse", button = 0) {
  fireEvent.pointerDown(gestures(), { button, pointerType, clientX: x });
  fireEvent.pointerUp(gestures(), { button, pointerType, clientX: x });
}

beforeEach(() => {
  window.localStorage.clear();
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PlayerArea states", () => {
  it("shows the empty card without media and no controls", () => {
    setup({ state: { roomMedia: "" } });
    expect(screen.getByText("Nothing playing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play something" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    // Space does nothing without media
  });

  it("shows a loader while loading and the not-a-video card", () => {
    setup({ state: { loading: true } });
    expect(screen.getByLabelText("Loading video")).toBeTruthy();
    cleanup();
    setup({ state: { nonPlayableMedia: true } });
    expect(screen.getByText("This link isn't a video")).toBeTruthy();
  });

  it("registers itself as the fullscreen container", () => {
    const r = setup();
    expect(r.player.setContainer).toHaveBeenCalledWith(playerEl());
    cleanup();
    expect(r.player.setContainer).toHaveBeenLastCalledWith(null);
  });

  it("forwards the video's events to the player", () => {
    const r = setup();
    const video = document.getElementById("leftVideo") as HTMLVideoElement;
    fireEvent(video, new Event("waiting"));
    expect(r.player.setBuffering).toHaveBeenLastCalledWith(true);
    fireEvent(video, new Event("playing"));
    expect(r.player.setBuffering).toHaveBeenLastCalledWith(false);
    fireEvent(video, new Event("canplay"));
    fireEvent(video, new Event("emptied"));
    expect(r.player.setBuffering).toHaveBeenCalledTimes(4);
    fireEvent(video, new Event("ended"));
    expect(r.player.onVideoEnded).toHaveBeenCalled();
  });

  it("shows the YouTube iframe instead of the video for YouTube", () => {
    setup({ media: { youtube: true, native: false } });
    const iframe = screen.getByTitle("YouTube") as HTMLIFrameElement;
    expect(iframe.style.display).toBe("block");
    expect(
      (document.getElementById("leftVideo") as HTMLElement).style.display,
    ).toBe("none");
  });

  it("the unmute scrim unmutes on any click", () => {
    const r = setup({ state: { isAutoPlayable: false } });
    fireEvent.click(screen.getByText("Unmute"));
    expect(r.player.localSetMute).toHaveBeenCalledWith(false);
    expect(r.player.localSetVolume).toHaveBeenCalledWith(1);
    expect(r.store().get().isAutoPlayable).toBe(true);
    expect(screen.queryByText("Unmute")).toBeNull();
  });
});

describe("PlayerArea mouse", () => {
  it("click = play/pause for everyone, with a flash", () => {
    const r = setup();
    act(() => click());
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 10);
    });
    expect(r.player.roomTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("double-click = fullscreen, wherever it is", () => {
    const r = setup();
    act(() => {
      click(100);
      click(100);
    });
    expect(r.player.toggleFullscreen).toHaveBeenCalledTimes(1);
    expect(r.player.roomSeekBy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
  });

  it("ignores other buttons and clicks while pausing is disabled", () => {
    const r = setup({ media: { pauseDisabled: true } });
    act(() => click(640, "mouse", 2));
    act(() => click());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
  });

  it("the first click outside an open menu only closes it", () => {
    const r = setup();
    fireEvent.click(screen.getByRole("button", { name: /Playback speed/ }));
    expect(screen.getByRole("dialog", { name: "Playback speed" })).toBeTruthy();
    act(() => click());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Playback speed" })).toBeNull();
  });

  it("hides the controls after a while playing, shows them on mouse move", () => {
    setup();
    const player = playerEl();
    fireEvent.pointerMove(player, { pointerType: "mouse" });
    expect(player.getAttribute("data-idle")).toBe("false");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(player.getAttribute("data-idle")).toBe("true");
    fireEvent.pointerMove(player, { pointerType: "mouse" });
    expect(player.getAttribute("data-idle")).toBe("false");
    // Leaving the player hides them sooner
    fireEvent.pointerLeave(player, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(player.getAttribute("data-idle")).toBe("true");
  });

  it("keeps the controls while paused", () => {
    setup({ state: { roomPaused: true } });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(playerEl().getAttribute("data-idle")).toBe("false");
  });
});

describe("PlayerArea touch", () => {
  it("tap toggles the controls", () => {
    setup();
    act(() => click(640, "touch"));
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 10);
    });
    expect(playerEl().getAttribute("data-idle")).toBe("true");
    act(() => click(640, "touch"));
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 10);
    });
    expect(playerEl().getAttribute("data-idle")).toBe("false");
  });

  it("double-tap left/right seeks ∓10 s with a ripple, centre is fullscreen", () => {
    const r = setup();
    act(() => {
      click(100, "touch");
      click(100, "touch");
    });
    expect(r.player.roomSeekBy).toHaveBeenLastCalledWith(-10);
    expect(playerEl().querySelector('[data-side="left"]')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(playerEl().querySelector("[data-side]")).toBeNull();
    act(() => {
      click(1200, "touch");
      click(1200, "touch");
    });
    expect(r.player.roomSeekBy).toHaveBeenLastCalledWith(10);
    expect(playerEl().querySelector('[data-side="right"]')).toBeTruthy();
    act(() => {
      click(640, "touch");
      click(640, "touch");
    });
    expect(r.player.toggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it("double-tap on media without a duration goes fullscreen instead of seeking", () => {
    const r = setup({ media: { hasDuration: false } });
    act(() => {
      click(100, "touch");
      click(100, "touch");
    });
    expect(r.player.roomSeekBy).not.toHaveBeenCalled();
    expect(r.player.toggleFullscreen).toHaveBeenCalled();
  });
});

describe("PlayerArea keyboard", () => {
  it("space/k play/pause; nothing without media", () => {
    const r = setup();
    key(" ");
    // Space toggles on release (a hold is 2× instead)
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
    keyUp(" ");
    key("k");
    expect(r.player.roomTogglePlay).toHaveBeenCalledTimes(2);
    expect(r.player.roomSetPlaybackRate).not.toHaveBeenCalled();
    cleanup();
    const e = setup({ state: { roomMedia: "" } });
    key(" ");
    keyUp(" ");
    expect(e.player.roomTogglePlay).not.toHaveBeenCalled();
  });

  it("holding space plays the room at 2× and restores the rate on release", () => {
    const r = setup({ state: { roomPaused: false, roomPlaybackRate: 1.25 } });
    key(" ");
    key(" ", { repeat: true });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(r.player.roomSetPlaybackRate).toHaveBeenLastCalledWith(2, {
      hold: true,
    });
    expect(osd()).toBe("2× ▸▸");
    keyUp(" ");
    expect(r.player.roomSetPlaybackRate).toHaveBeenLastCalledWith(1.25, {
      hold: true,
    });
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
  });

  it("a hold ends when the window loses focus", () => {
    const r = setup({ state: { roomPaused: false } });
    key(" ");
    act(() => {
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new Event("blur"));
    });
    expect(r.player.roomSetPlaybackRate).toHaveBeenLastCalledWith(1, {
      hold: true,
    });
    keyUp(" ");
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
  });

  it("a slow space press while paused or live still toggles play", () => {
    const r = setup({ state: { roomPaused: true } });
    key(" ");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    keyUp(" ");
    expect(r.player.roomSetPlaybackRate).not.toHaveBeenCalled();
    expect(r.player.roomTogglePlay).toHaveBeenCalledTimes(1);
    cleanup();
    const live = setup({ state: { roomPaused: false, isLiveStream: true } });
    key(" ");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    keyUp(" ");
    expect(live.player.roomSetPlaybackRate).not.toHaveBeenCalled();
    expect(live.player.roomTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("arrows seek with an OSD that fades", () => {
    const r = setup();
    key("ArrowRight");
    expect(r.player.roomSeekBy).toHaveBeenLastCalledWith(10);
    expect(osd()).toBe("+10 s");
    key("ArrowLeft");
    expect(r.player.roomSeekBy).toHaveBeenLastCalledWith(-10);
    expect(osd()).toBe("−10 s");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(osd()).toBeUndefined();
  });

  it("no seeking on screen shares", () => {
    const r = setup({ media: { webrtcShare: true } });
    key("ArrowRight");
    expect(r.player.roomSeekBy).not.toHaveBeenCalled();
  });

  it("volume up/down and mute show the level", () => {
    const r = setup({ media: { volume: 0.5 } });
    key("ArrowUp");
    expect(r.player.localSetVolume).toHaveBeenCalledWith(0.55);
    expect(osd()).toBe("Volume 55%");
    key("m");
    expect(r.player.localToggleMute).toHaveBeenCalled();
    expect(osd()).toBe("Muted");
    // Muted counts as 0 when turning it up
    key("ArrowUp");
    expect(r.player.localSetVolume).toHaveBeenLastCalledWith(0.05);
    // (setting the volume unmuted it)
    key("m");
    expect(osd()).toBe("Muted");
    key("m");
    expect(osd()).toBe("Unmuted");
  });

  it("f toggles fullscreen", () => {
    const r = setup();
    key("f");
    expect(r.player.toggleFullscreen).toHaveBeenCalled();
  });

  it("[ and ] nudge the subtitle offset (native player only)", () => {
    const r = setup();
    r.subtitles.nudgeOffset.mockReturnValue(0.3);
    key("]");
    expect(r.subtitles.nudgeOffset).toHaveBeenCalledWith(0.1);
    expect(osd()).toBe("Subtitles +0.3 s · everyone");
    cleanup();
    const me = setup({ state: { subtitleScope: "me" } });
    me.subtitles.nudgeOffset.mockReturnValue(-0.1);
    key("[");
    expect(osd()).toBe("Subtitles −0.1 s · just me");
    cleanup();
    const yt = setup({ media: { youtube: true, native: false } });
    key("]");
    expect(yt.subtitles.nudgeOffset).not.toHaveBeenCalled();
  });

  it("? and the overflow menu's event open the shortcuts; Esc closes them", () => {
    setup();
    key("?");
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    key("?");
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("wp:show-shortcuts"));
    });
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    // The overlay holds the controls; a click on the video only closes it... via its scrim
    key("Escape");
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeNull();
  });

  it("ignores keys while typing", () => {
    const r = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: " " });
    expect(r.player.roomTogglePlay).not.toHaveBeenCalled();
    input.remove();
  });
});

describe("PlayerArea in a voice call", () => {
  const joined = (over: Record<string, unknown> = {}) => ({
    status: "joined",
    members: [],
    camera: false,
    cameraBusy: false,
    pushToTalk: false,
    ...over,
  });

  it("m is the mic", () => {
    const r = setup();
    r.store().set({ call: { ...r.store().get().call, ...joined() } as any });
    key("m");
    expect(r.call.toggleMute).toHaveBeenCalled();
    expect(r.player.localToggleMute).not.toHaveBeenCalled();
    expect(osd()).toBe("Mic muted");
    r.call.toggleMute.mockReturnValue(false);
    key("m");
    expect(osd()).toBe("Mic on");
  });

  it("with push to talk, m explains it", () => {
    const r = setup();
    r.store().set({
      call: { ...r.store().get().call, ...joined({ pushToTalk: true }) } as any,
    });
    key("m");
    expect(r.call.toggleMute).not.toHaveBeenCalled();
    expect(osd()).toBe("Push to talk is on: hold T to talk");
  });

  it("v turns the camera on/off and reports failures", async () => {
    const r = setup();
    act(() => {
      r.store().set({ call: { ...r.store().get().call, ...joined() } as any });
    });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "v" });
    });
    expect(r.call.toggleCamera).toHaveBeenCalled();
    expect(osd()).toBe("Camera on");
    r.call.toggleCamera.mockResolvedValue(false);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "v" });
    });
    expect(osd()).toBe("Camera unavailable");
    act(() => {
      r.store().set({
        call: { ...r.store().get().call, camera: true } as any,
      });
    });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "v" });
    });
    expect(osd()).toBe("Camera off");
  });

  it("v does nothing outside a call", () => {
    const r = setup();
    key("v");
    expect(r.call.toggleCamera).not.toHaveBeenCalled();
  });
});

describe("PlayerArea chat", () => {
  it("c focuses the sidebar chat while the sidebar is open", () => {
    const r = setup();
    key("c");
    expect(r.focusInput).toHaveBeenCalled();
    expect(screen.queryByLabelText("Message everyone")).toBeNull();
    // Shift+C has no panel here either: same as c
    key("C", { shiftKey: true });
    expect(r.focusInput).toHaveBeenCalledTimes(2);
  });

  it("with the sidebar collapsed, c opens quick chat; Enter sends, Esc closes", () => {
    window.localStorage.setItem("wp-sidebar-collapsed", "1");
    const r = setup();
    // Bubbles over the video
    expect(playerEl().querySelector("[aria-live]")).toBeTruthy();
    key("c");
    const input = screen.getByLabelText("Message everyone");
    fireEvent.change(input, { target: { value: "hi all" } });
    act(() => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(r.socket.emits("CMD:chat")).toEqual([["hi all"]]);
    expect(screen.queryByLabelText("Message everyone")).toBeNull();
    key("c");
    expect(screen.getByLabelText("Message everyone")).toBeTruthy();
    // The window's Esc (focus elsewhere) closes it
    key("Escape");
    expect(screen.queryByLabelText("Message everyone")).toBeNull();
  });

  it("the chat panel button opens the panel; Esc closes it; the control shows it open", () => {
    window.localStorage.setItem("wp-sidebar-collapsed", "1");
    setup({ state: { roomPaused: true } });
    fireEvent.click(screen.getByRole("button", { name: "Show chat" }));
    expect(playerEl().getAttribute("data-chat-panel")).toBe("open");
    expect(screen.getByRole("button", { name: "Hide chat" })).toBeTruthy();
    // c focuses the panel's input instead of opening quick chat
    key("c");
    expect(screen.queryByLabelText("Message everyone")).toBeNull();
    key("Escape");
    expect(playerEl().getAttribute("data-chat-panel")).toBeNull();
  });

  it("opening the panel on a touch screen doesn't focus its input", () => {
    installMatchMedia({ "(pointer: coarse)": true });
    window.localStorage.setItem("wp-sidebar-collapsed", "1");
    setup();
    key("C", { shiftKey: true });
    expect(playerEl().getAttribute("data-chat-panel")).toBe("open");
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("phone layout: no chat panel, so Shift+C opens quick chat", () => {
    installMatchMedia({ "(max-width: 48em)": true });
    window.localStorage.setItem("wp-sidebar-collapsed", "1");
    setup();
    expect(screen.queryByRole("button", { name: /Show chat/ })).toBeNull();
    key("C", { shiftKey: true });
    expect(screen.getByLabelText("Message everyone")).toBeTruthy();
  });
});

describe("PlayerArea fullscreen", () => {
  it("shows the title bar and the room's notices on the video", () => {
    const r = setup();
    act(() => {
      r.player.toggleFullscreen();
    });
    expect(playerEl().getAttribute("data-fullscreen")).toBe("true");
    expect(screen.getByText("movie.mp4")).toBeTruthy();
    act(() => {
      r.store().set({ playerNotice: { text: "Alex paused", at: Date.now() } });
    });
    expect(osd()).toBe("Alex paused");
    // In fullscreen, quick chat is available even with the sidebar open
    key("c");
    expect(screen.getByLabelText("Message everyone")).toBeTruthy();
    // Leaving fullscreen closes it again
    fireEvent.click(
      screen.getAllByRole("button", { name: "Exit fullscreen" })[0],
    );
    expect(playerEl().getAttribute("data-fullscreen")).toBe("false");
    expect(screen.queryByLabelText("Message everyone")).toBeNull();
  });

  it("notices don't show on the video outside fullscreen", () => {
    const r = setup();
    act(() => {
      r.store().set({ playerNotice: { text: "Alex paused", at: 1 } });
    });
    expect(osd()).toBeUndefined();
  });
});
