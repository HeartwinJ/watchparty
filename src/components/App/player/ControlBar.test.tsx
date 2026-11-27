// The player's control bar with its speed/subtitle menus, driven by the real usePlaybackState/useTextTracks/
// useSubtitleStyle hooks over a fake player.
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ControlBar, type MenuName } from "./ControlBar";
import { usePlaybackState } from "./usePlaybackState";
import { useTextTracks } from "./useTextTracks";
import { useSubtitleStyle } from "./useSubtitleStyle";
import type { Room } from "../hooks/useRoom";
import {
  renderWithPlayerRoom,
  type RenderPlayerOptions,
} from "../../../test/playerRoom";

function Bar({
  room,
  phone = false,
  fullscreen = false,
  showMiniSync = false,
  chatPanel,
  onHoverChange = () => {},
}: {
  room: Room;
  phone?: boolean;
  fullscreen?: boolean;
  showMiniSync?: boolean;
  chatPanel?: { open: boolean; unread: number; onToggle: () => void };
  onHoverChange?: (h: boolean) => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuName | null>(null);
  const playback = usePlaybackState(room);
  const tracks = useTextTracks(room);
  const [style, setStyle] = useSubtitleStyle();
  return (
    <div ref={setContainer} data-testid="player">
      <video id="leftVideo" />
      <ControlBar
        room={room}
        playback={playback}
        menu={menu}
        setMenu={setMenu}
        container={container}
        fullscreen={fullscreen}
        phone={phone}
        showMiniSync={showMiniSync}
        tracks={tracks}
        subtitleStyle={style}
        setSubtitleStyle={setStyle}
        onTogglePlay={() => room.player.roomTogglePlay()}
        onHoverChange={onHoverChange}
        chatPanel={chatPanel}
      />
    </div>
  );
}

function setup(
  props: Omit<React.ComponentProps<typeof Bar>, "room"> = {},
  opts: RenderPlayerOptions = {},
) {
  return renderWithPlayerRoom((room) => <Bar room={room} {...props} />, {
    ...opts,
    state: { roomMedia: "https://example.com/movie.mp4", ...opts.state },
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const btn = (name: string | RegExp) => screen.getByRole("button", { name });

describe("ControlBar", () => {
  it("shows the time, toggles play and seeks ±10 s", () => {
    const r = setup();
    expect(screen.getByText("00:30")).toBeTruthy();
    expect(screen.getByText("/ 10:00", { exact: false })).toBeTruthy();
    fireEvent.click(btn("Pause"));
    expect(r.player.roomTogglePlay).toHaveBeenCalled();
    // The video's pause event refreshes the playback snapshot
    act(() => {
      document.getElementById("leftVideo")!.dispatchEvent(new Event("pause"));
    });
    expect(btn("Play")).toBeTruthy();
    fireEvent.click(btn("Back 10 seconds"));
    expect(r.player.roomSeekBy).toHaveBeenCalledWith(-10);
    fireEvent.click(btn("Forward 10 seconds"));
    expect(r.player.roomSeekBy).toHaveBeenCalledWith(10);
  });

  it("the room pause shows Play even if this element is playing", () => {
    setup({}, { state: { roomPaused: true } });
    expect(btn("Play")).toBeTruthy();
  });

  it("disables play while pausing isn't possible", () => {
    setup({}, { media: { pauseDisabled: true } });
    expect((btn("Pause") as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides seeking for screen shares and media without a duration", () => {
    setup({}, { media: { webrtcShare: true } });
    expect(screen.queryByRole("slider", { name: "Seek" })).toBeNull();
    expect(screen.queryByLabelText("Back 10 seconds")).toBeNull();
    expect(screen.queryByText("/ 10:00", { exact: false })).toBeNull();
  });

  it("shows LIVE and no duration for live streams", () => {
    setup({}, { state: { isLiveStream: true } });
    expect(screen.getByText("LIVE")).toBeTruthy();
    expect(screen.queryByText("/ 10:00", { exact: false })).toBeNull();
  });

  it("seeking with the bar's keyboard seeks the room", () => {
    const r = setup();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Seek" }), {
      key: "Home",
    });
    expect(r.player.roomSeek).toHaveBeenCalledWith(0);
  });

  it("volume: mute button, slider and icons", () => {
    const r = setup({}, { media: { volume: 0.3 } });
    const slider = screen.getByRole("slider", {
      name: "Volume",
    }) as HTMLInputElement;
    expect(slider.getAttribute("aria-valuetext")).toBe("30%");
    fireEvent.change(slider, { target: { value: "0.65" } });
    expect(r.player.localSetVolume).toHaveBeenCalledWith(0.65);
    fireEvent.click(btn("Mute"));
    expect(r.player.localToggleMute).toHaveBeenCalled();
    act(() => {
      document
        .getElementById("leftVideo")!
        .dispatchEvent(new Event("volumechange"));
    });
    // Muted reads as volume 0
    expect(btn("Unmute")).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBe("0%");
  });

  it("shows conversion progress", () => {
    setup({}, { state: { convertProgress: 0.345 } });
    expect(screen.getByText("34.5% converted")).toBeTruthy();
  });

  it("loop toggles for the room", () => {
    const r = setup({}, { state: { roomLoop: true } });
    const loop = btn("Loop");
    expect(loop.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(loop);
    expect(r.player.roomSetLoop).toHaveBeenCalledWith(false);
  });

  it("fullscreen button follows the fullscreen prop", () => {
    const r = setup({ fullscreen: true });
    fireEvent.click(btn("Exit fullscreen"));
    expect(r.player.toggleFullscreen).toHaveBeenCalled();
  });

  it("speed menu sets the room's rate and closes", () => {
    const r = setup({}, { state: { roomPlaybackRate: 1.5 } });
    const trigger = btn("Playback speed 1.5×");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("dialog", { name: "Playback speed" });
    // Portalled into the player container
    expect(screen.getByTestId("player").contains(menu)).toBe(true);
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: "1.5×" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Normal" }),
    );
    expect(r.socket.emits("CMD:playbackRate")).toEqual([[1]]);
    expect(screen.queryByRole("dialog", { name: "Playback speed" })).toBeNull();
    // Clicking the trigger twice toggles it closed
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Playback speed" })).toBeNull();
  });

  it("subtitles menu: Esc closes it, and so does picking Search subtitles…", () => {
    const r = setup();
    const cc = btn("Subtitles");
    fireEvent.click(cc);
    expect(screen.getByRole("dialog", { name: "Subtitles" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Subtitles" })).toBeNull();
    fireEvent.click(cc);
    fireEvent.click(screen.getByRole("button", { name: /Search subtitles/ }));
    expect(r.subtitles.openSearch).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Subtitles" })).toBeNull();
  });

  it("pointer and click events on the controls don't reach the video", () => {
    const outer = vi.fn();
    renderWithPlayerRoom(
      (room) => (
        <div onPointerDown={outer} onClick={outer} onDoubleClick={outer}>
          <Bar room={room} />
        </div>
      ),
      { state: { roomMedia: "https://example.com/movie.mp4" } },
    );
    const toolbar = screen.getByRole("toolbar");
    fireEvent.pointerDown(toolbar);
    fireEvent.click(toolbar);
    fireEvent.doubleClick(toolbar);
    expect(outer).not.toHaveBeenCalled();
  });

  it("the room rate 0 (unset) reads as 1×", () => {
    setup();
    expect(btn("Playback speed 1×")).toBeTruthy();
  });

  it("menus open as a bottom sheet in the body on a phone outside fullscreen", () => {
    setup({ phone: true });
    fireEvent.click(btn("Subtitles"));
    const menu = screen.getByRole("dialog", { name: "Subtitles" });
    expect(menu.getAttribute("data-sheet")).toBe("true");
    expect(screen.getByTestId("player").contains(menu)).toBe(false);
  });

  it("chat panel button: unread badge, pressed state and toggle", () => {
    const onToggle = vi.fn();
    setup({ chatPanel: { open: false, unread: 3, onToggle } });
    fireEvent.click(btn("Show chat (3 unread)"));
    expect(onToggle).toHaveBeenCalled();
    expect(screen.getByText("3")).toBeTruthy();
    cleanup();
    setup({ chatPanel: { open: true, unread: 3, onToggle } });
    expect(btn("Hide chat").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("3")).toBeNull();
    cleanup();
    setup({ chatPanel: { open: false, unread: 0, onToggle } });
    expect(btn("Show chat")).toBeTruthy();
  });

  it("reports mouse hover (not touch) for the auto-hide", () => {
    const onHoverChange = vi.fn();
    setup({ onHoverChange });
    const bar = screen.getByRole("toolbar").parentElement!;
    fireEvent.pointerEnter(bar, { pointerType: "touch" });
    expect(onHoverChange).not.toHaveBeenCalled();
    fireEvent.pointerEnter(bar, { pointerType: "mouse" });
    fireEvent.pointerLeave(bar, { pointerType: "mouse" });
    expect(onHoverChange.mock.calls).toEqual([[true], [false]]);
  });

  it("shows the mini sync pill when asked", () => {
    setup({ showMiniSync: true });
    expect(btn("Playback sync: In sync")).toBeTruthy();
  });

  it("picture in picture enters and leaves", async () => {
    Object.defineProperty(document, "pictureInPictureEnabled", {
      configurable: true,
      value: true,
    });
    const request = vi.fn(async () => {});
    (HTMLVideoElement.prototype as any).requestPictureInPicture = request;
    setup();
    await act(async () => {
      fireEvent.click(btn("Picture in picture"));
    });
    expect(request).toHaveBeenCalled();
    const exit = vi.fn(async () => {});
    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      value: document.createElement("video"),
    });
    (document as any).exitPictureInPicture = exit;
    await act(async () => {
      fireEvent.click(btn("Picture in picture"));
    });
    expect(exit).toHaveBeenCalled();
    // A failure is only logged
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (document as any).exitPictureInPicture = vi.fn(async () => {
      throw new Error("nope");
    });
    await act(async () => {
      fireEvent.click(btn("Picture in picture"));
    });
    expect(warn).toHaveBeenCalled();
    delete (document as any).pictureInPictureEnabled;
    delete (document as any).pictureInPictureElement;
    delete (document as any).exitPictureInPicture;
  });

  it("YouTube: no PiP, CC reflects YouTube captions and polls the player", () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "pictureInPictureEnabled", {
        configurable: true,
        value: true,
      });
      const r = setup({}, { media: { youtube: true, native: false } });
      expect(screen.queryByLabelText("Picture in picture")).toBeNull();
      expect(btn("Subtitles").getAttribute("aria-pressed")).toBe("false");
      // Polled 4×/s: a time change shows up without media events
      r.media.time = 95;
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByText("01:35")).toBeTruthy();
      delete (document as any).pictureInPictureEnabled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ControlBar audio menu", () => {
  it("opens the Audio menu with the boost, and shows when the boost is on", () => {
    const r = setup(
      {},
      {
        state: {
          audioBoost: { level: 2, night: false },
          audioBoostStatus: "on",
        },
      },
    );
    const audio = screen.getByRole("button", { name: "Audio" });
    expect(audio.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(audio);
    const menu = screen.getByRole("dialog", { name: "Audio" });
    expect(within(menu).getByRole("group", { name: "Boost" })).toBeTruthy();
    // The subtitles menu no longer has it
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    const subs = screen.getByRole("dialog", { name: "Subtitles" });
    expect(within(subs).queryByRole("group", { name: "Boost" })).toBeNull();
    r.unmount();
  });

  it("isn't offered for YouTube with a single audio track", () => {
    setup({}, { media: { youtube: true, native: false } });
    expect(screen.queryByRole("button", { name: "Audio" })).toBeNull();
  });
});

describe("ControlBar volume boost badge", () => {
  it("shows the boost while it's applied", () => {
    const r = setup(
      {},
      {
        state: {
          audioBoost: { level: 2, night: true },
          audioBoostStatus: "on",
        },
      },
    );
    expect(screen.getByText("200% · Night")).toBeTruthy();
    r.setState({ audioBoostStatus: "unavailable" });
    expect(screen.queryByText("200% · Night")).toBeNull();
  });

  it("not for YouTube", () => {
    setup(
      {},
      {
        media: { youtube: true, native: false },
        state: {
          audioBoost: { level: 2, night: false },
          audioBoostStatus: "on",
        },
      },
    );
    expect(screen.queryByText("200%")).toBeNull();
  });
});
