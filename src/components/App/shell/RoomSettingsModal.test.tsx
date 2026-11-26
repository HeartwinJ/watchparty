// The room settings modal with a fake room: per-device switches, owner vs guest, and what each room-wide input sends.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

const transcodeSupported = vi.fn(() => true);
vi.mock("../../../utils/clientTranscode", () => ({
  isClientTranscodeSupported: () => transcodeSupported(),
}));
const toastMock = vi.fn();
vi.mock("../ui/toast", () => ({ toast: (...a: unknown[]) => toastMock(...a) }));

const { RoomSettingsModal } = await import("./RoomSettingsModal");
const { useRoomUi } = await import("../ui/RoomUi");
const { fakeRoom, renderUi } = await import("../../../test/renderRoom");
type FakeRoom = ReturnType<typeof fakeRoom>;

const Open = ({ room }: { room: FakeRoom }) => {
  const ui = useRoomUi();
  useEffect(() => ui.openSettings(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <RoomSettingsModal room={room} roomId="happy-otter-42" />;
};

function setup(
  role: "owner" | "guest" = "owner",
  over: Parameters<typeof fakeRoom>[0] = {},
) {
  const room = fakeRoom({ socketConnected: true, ...over });
  const r = renderUi(<Open room={room} />, { role });
  return { room, ...r };
}

beforeEach(() => {
  window.localStorage.clear();
  toastMock.mockClear();
  transcodeSupported.mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sw = (label: string) =>
  screen.getByRole("switch", { name: new RegExp(label) }) as HTMLInputElement;

describe("on this device", () => {
  it("toggles the message sound in localStorage", () => {
    setup();
    expect(sw("Message sound").checked).toBe(true);
    fireEvent.click(sw("Message sound"));
    expect(
      JSON.parse(window.localStorage.getItem("watchparty-setting")!),
    ).toEqual({ disableChatSound: true });
    expect(sw("Message sound").checked).toBe(false);
  });

  it("toggles auto-convert on the room, and hides it where converting isn't supported", () => {
    const { room, unmount } = setup();
    fireEvent.click(sw("Auto-convert"));
    expect(room.convert.setConvertEnabled).toHaveBeenCalledWith(false);
    unmount();
    transcodeSupported.mockReturnValue(false);
    setup();
    expect(screen.queryByRole("switch", { name: /Auto-convert/ })).toBeNull();
  });

  it("toggles chat bubbles", () => {
    setup();
    const before = sw("Chat bubbles").checked;
    fireEvent.click(sw("Chat bubbles"));
    expect(sw("Chat bubbles").checked).toBe(!before);
  });

  it("Done closes the modal", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("On this device")).toBeNull();
  });
});

describe("guests", () => {
  it("see a note instead of the room-wide settings, with the current skip intro", () => {
    setup("guest", {
      roomSettings: {
        title: "",
        readyCheck: true,
        nextEpisodeOffset: 25,
        autoSyncSubtitles: false,
        skipIntro: 90,
      },
    });
    expect(screen.getByText(/Only the room's owner can change/)).toBeTruthy();
    expect(screen.getByText(/videos start at 1:30/)).toBeTruthy();
    expect(screen.queryByLabelText("Room title")).toBeNull();
  });

  it("see skip intro off", () => {
    setup("guest");
    expect(screen.getByText(/Skip intro:\s*off/)).toBeTruthy();
  });
});

describe("owners", () => {
  it("send the title on Enter and on blur, only when it changed", () => {
    const { room } = setup();
    const input = screen.getByLabelText("Room title") as HTMLInputElement;
    expect(input.placeholder).toBe("Happy otter 42");
    fireEvent.change(input, { target: { value: "  Movie   night " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(room.cmd.setRoomSettings).toHaveBeenLastCalledWith({
      title: "Movie night",
    });
    room.cmd.setRoomSettings.mockClear();
    // Blur without a draft sends nothing
    fireEvent.blur(input);
    expect(room.cmd.setRoomSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Other" } });
    fireEvent.blur(input);
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({ title: "Other" });
  });

  it("Escape discards the title draft without sending", () => {
    const { room } = setup();
    const input = screen.getByLabelText("Room title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    // The modal stayed open
    expect(screen.getByText("On this device")).toBeTruthy();
    fireEvent.blur(input);
    expect(room.cmd.setRoomSettings).not.toHaveBeenCalled();
  });

  it("send the ready check and auto-sync switches right away", () => {
    const { room } = setup();
    fireEvent.click(sw("Ready check"));
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({
      readyCheck: false,
    });
    fireEvent.click(sw("Auto-sync subtitles"));
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({
      autoSyncSubtitles: true,
    });
  });

  it("warn instead of sending while disconnected", () => {
    const { room } = setup("owner", { socketConnected: false });
    fireEvent.click(sw("Ready check"));
    expect(room.cmd.setRoomSettings).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.stringMatching(/Not connected/),
      expect.objectContaining({ tone: "warning" }),
    );
  });

  it("send the next-episode offset 500 ms after the last change, clamped", () => {
    vi.useFakeTimers();
    const { room } = setup();
    // Let the modal's focus trap settle, then type into the input
    act(() => vi.advanceTimersByTime(100));
    const input = screen.getByLabelText("Next-episode card");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "40" } });
    act(() => vi.advanceTimersByTime(400));
    expect(room.cmd.setRoomSettings.mock.calls).toEqual([]);
    fireEvent.change(input, { target: { value: "300" } });
    act(() => vi.advanceTimersByTime(500));
    expect(room.cmd.setRoomSettings).toHaveBeenCalledTimes(1);
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({
      nextEpisodeOffset: 120,
    });
  });

  it("send the offset right away on blur", () => {
    const { room } = setup();
    const input = screen.getByLabelText("Next-episode card");
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({
      nextEpisodeOffset: 30,
    });
  });

  it("send a skip intro preset chip, not the current one again", () => {
    const { room } = setup();
    fireEvent.click(screen.getByRole("radio", { name: "1:30" }));
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({ skipIntro: 90 });
    room.cmd.setRoomSettings.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(room.cmd.setRoomSettings).not.toHaveBeenCalled();
  });

  it("send a custom skip intro after a pause or on blur, with an m:ss preview", () => {
    vi.useFakeTimers();
    const { room } = setup();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const input = screen.getByLabelText("Custom skip intro in seconds");
    expect(screen.getByText("1–600 seconds")).toBeTruthy();
    fireEvent.change(input, { target: { value: "75" } });
    expect(screen.getByText("Starts at 1:15")).toBeTruthy();
    act(() => vi.advanceTimersByTime(500));
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({ skipIntro: 75 });
    room.cmd.setRoomSettings.mockClear();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect(room.cmd.setRoomSettings).toHaveBeenCalledWith({ skipIntro: 20 });
  });

  it("show the custom input for a non-preset value", () => {
    setup("owner", {
      roomSettings: {
        title: "",
        readyCheck: true,
        nextEpisodeOffset: 25,
        autoSyncSubtitles: false,
        skipIntro: 75,
      },
    });
    expect(
      (screen.getByRole("radio", { name: "Custom" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByText("Starts at 1:15")).toBeTruthy();
  });
});

describe("room password", () => {
  const access = { enabled: true, password: "otter-maple-42" };

  it("isn't shown until REC:roomAccess arrived", () => {
    setup();
    expect(screen.queryByRole("switch", { name: /Require a password/ })).toBe(
      null,
    );
  });

  it("is masked, can be revealed and copied", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    setup("owner", { roomAccess: access });
    expect(screen.queryByText(access.password)).toBeNull();
    fireEvent.click(screen.getByLabelText("Show password"));
    expect(screen.getByText(access.password)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Hide password"));
    expect(screen.queryByText(access.password)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy password"));
    });
    expect(writeText).toHaveBeenCalledWith(access.password);
  });

  it("regenerates and reveals the new one", () => {
    const { room } = setup("owner", { roomAccess: access });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(room.cmd.setRoomPassword).toHaveBeenCalledWith({
      action: "regenerate",
    });
    expect(screen.getByText(access.password)).toBeTruthy();
  });

  it("doesn't regenerate while disconnected", () => {
    const { room } = setup("owner", {
      roomAccess: access,
      socketConnected: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(room.cmd.setRoomPassword).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalled();
  });

  it("sets your own (4–64 chars, trimmed), Cancel and Escape discard it", () => {
    const { room } = setup("owner", { roomAccess: access });
    fireEvent.click(screen.getByRole("button", { name: "Set your own" }));
    const input = screen.getByLabelText("New room password");
    const save = screen.getByRole("button", {
      name: "Save password",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  pass word  " } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(room.cmd.setRoomPassword).toHaveBeenCalledWith({
      action: "set",
      password: "pass word",
    });
    expect(screen.queryByLabelText("New room password")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Set your own" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New room password")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Set your own" }));
    fireEvent.keyDown(screen.getByLabelText("New room password"), {
      key: "Escape",
    });
    expect(screen.queryByLabelText("New room password")).toBeNull();
    // The modal stayed open
    expect(screen.getByText("On this device")).toBeTruthy();
  });

  it("turns the password requirement off and on", () => {
    const { room, unmount } = setup("owner", { roomAccess: access });
    fireEvent.click(sw("Require a password"));
    expect(room.cmd.setRoomPassword).toHaveBeenCalledWith({
      action: "enable",
      enabled: false,
    });
    unmount();
    const off = setup("owner", { roomAccess: { enabled: false } });
    expect(screen.getByText(/Anyone with the link can join/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    fireEvent.click(sw("Require a password"));
    expect(off.room.cmd.setRoomPassword).toHaveBeenCalledWith({
      action: "enable",
      enabled: true,
    });
  });
});
