// The call panel and the top bar's call control with a fake room: pre-join (mic preview, errors, join-muted note),
// in the call (mute, push to talk, switches, leave), owners' moderation menu, the camera section and the phone drawer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { AuthContext } from "../../AuthGate/AuthGate";
import { FakeTrack } from "../../../test/browserFakes";
import { initialCallState, type CallUiState } from "./callReducer";
import { CallVideo } from "./videoStreams";
import { CallPanel } from "./CallPanel";
import { CallControl } from "./CallControl";
import type { Room } from "../hooks/useRoom";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const member = (clientId: string, extra: Partial<CallMember> = {}) => ({
  clientId,
  session: `${clientId.slice(0, 8)}session`,
  muted: false,
  camera: false,
  joinedAt: 1,
  reconnecting: false,
  ...extra,
});

let devChange: (() => void) | null = null;

function fakeRoom(callPatch: Partial<CallUiState> = {}, roomPatch = {}) {
  const call: CallUiState = {
    ...initialCallState({ pushToTalk: false, ducking: false }),
    ...callPatch,
  };
  const video = new CallVideo();
  const api = {
    video,
    startPreview: vi.fn(async () => {}),
    stopPreview: vi.fn(),
    listMics: vi.fn(async () => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk mic" },
      { kind: "audioinput", deviceId: "mic-2", label: "" },
      { kind: "audioinput", deviceId: "", label: "hidden" },
    ]),
    currentDeviceId: vi.fn(() => "mic-1"),
    setDevice: vi.fn(async () => {}),
    listCameras: vi.fn(async () => [
      { kind: "videoinput", deviceId: "cam-1", label: "Desk cam" },
      { kind: "videoinput", deviceId: "cam-2", label: "" },
    ]),
    currentCameraId: vi.fn(() => "cam-gone"),
    setCameraDevice: vi.fn(async () => {}),
    toggleCamera: vi.fn(async () => true),
    getLevel: vi.fn(() => 0.5),
    join: vi.fn(),
    leave: vi.fn(),
    toggleMute: vi.fn(),
    setDucking: vi.fn(),
    setPushToTalk: vi.fn(),
    setTilesHidden: vi.fn(),
    moderate: vi.fn(),
    pttDown: vi.fn(),
    pttUp: vi.fn(),
  };
  const state = {
    call,
    nameMap: { [ME]: "Me", [BOB]: "Bob" },
    pictureMap: {},
    roomMedia: "",
    roomPaused: true,
    ...roomPatch,
  };
  const room = {
    clientId: ME,
    state,
    call: api,
    store: { get: () => state },
  } as unknown as Room;
  return { room, api, video };
}

function wrap(node: React.ReactNode, role: "owner" | "guest" = "owner") {
  return (
    <MantineProvider env="test">
      <AuthContext.Provider
        value={{
          authRequired: true,
          role,
          logout: async () => {},
          roomAccessLost: () => {},
        }}
      >
        {node}
      </AuthContext.Provider>
    </MantineProvider>
  );
}

const renderPanel = (room: Room, role: "owner" | "guest" = "owner") =>
  render(wrap(<CallPanel room={room} />, role));

const joinedCall = (
  extra: Partial<CallUiState> = {},
): Partial<CallUiState> => ({
  status: "joined",
  session: "aaaaaaaasession",
  members: [member(ME), member(BOB, { muted: true, camera: true })],
  peers: { [BOB]: "connected" },
  ...extra,
});

beforeEach(() => {
  devChange = null;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener: (_t: string, fn: () => void) => (devChange = fn),
      removeEventListener: vi.fn(),
    },
  });
});
afterEach(() => cleanup());

describe("CallPanel before joining", () => {
  it("opens the mic preview, lists mics and joins", async () => {
    const { room, api } = fakeRoom();
    const { unmount } = renderPanel(room);
    expect(screen.getByText("Nobody's in the call yet")).toBeTruthy();
    expect(api.startPreview).toHaveBeenCalled();
    await waitFor(() => expect(api.listMics).toHaveBeenCalledTimes(3));
    expect(screen.getByText(/Headphones recommended/)).toBeTruthy();
    expect(screen.getByText("Say something to test")).toBeTruthy();
    expect(screen.queryByText(/you'll join muted/)).toBeNull();
    // Device changes refresh the lists
    await act(async () => devChange?.());
    fireEvent.click(screen.getByRole("button", { name: "Join voice call" }));
    expect(api.join).toHaveBeenCalled();
    unmount();
    expect(api.stopPreview).toHaveBeenCalled();
  });

  it("picks another mic (unnamed ones get a number)", async () => {
    const { room, api } = fakeRoom();
    renderPanel(room);
    const select = screen
      .getAllByLabelText("Microphone")
      .find((e) => e.tagName === "INPUT")!;
    await waitFor(() =>
      expect((select as HTMLInputElement).value).toBe("Desk mic"),
    );
    fireEvent.click(select);
    fireEvent.click(
      await screen.findByRole("option", { name: "Microphone 2" }),
    );
    await waitFor(() => expect(api.setDevice).toHaveBeenCalledWith("mic-2"));
  });

  it("doesn't start a preview while already in the call", () => {
    const { room, api } = fakeRoom(joinedCall());
    renderPanel(room);
    expect(api.startPreview).not.toHaveBeenCalled();
  });

  it("says you'll join muted while the video plays, and with the camera on", () => {
    const { room } = fakeRoom(
      { camera: true },
      { roomMedia: "https://example.com/v.mp4", roomPaused: false },
    );
    renderPanel(room);
    expect(
      screen.getByText("The video is playing, so you'll join muted."),
    ).toBeTruthy();
    expect(screen.getByText("You'll join with your camera on.")).toBeTruthy();
  });

  it("push to talk users don't get the join-muted note", () => {
    const { room } = fakeRoom(
      { pushToTalk: true },
      { roomMedia: "https://example.com/v.mp4", roomPaused: false },
    );
    renderPanel(room);
    expect(screen.queryByText(/you'll join muted/)).toBeNull();
  });

  it("shows a mic error with Try again, and can't join", async () => {
    const { room, api } = fakeRoom({ micError: "blocked" });
    renderPanel(room);
    expect(screen.getByRole("alert").textContent).toMatch(/blocked/i);
    expect(
      (
        screen.getByRole("button", {
          name: "Join voice call",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.startPreview).toHaveBeenCalledTimes(2);
  });
});

describe("CallPanel in the call", () => {
  it("lists members with mute/camera icons and connection state", () => {
    const { room } = fakeRoom(
      joinedCall({
        muted: true,
        peers: {},
        members: [
          member(ME),
          member(BOB, { muted: true, camera: true }),
          member("cccccccc", { reconnecting: true }),
        ],
      }),
    );
    renderPanel(room);
    expect(screen.getByText("3 in the call")).toBeTruthy();
    const list = screen.getByRole("list", { name: "In the call" });
    expect(within(list).getByText("(you)")).toBeTruthy();
    expect(within(list).getAllByLabelText("Muted")).toHaveLength(2);
    expect(within(list).getByLabelText("Camera on")).toBeTruthy();
    expect(within(list).getByText("Connecting…")).toBeTruthy();
    expect(within(list).getByText("Reconnecting…")).toBeTruthy();
    expect(within(list).getByText("Someone")).toBeTruthy();
    // The level meter says muted
    expect(screen.getAllByText("Muted").length).toBeGreaterThan(0);
  });

  it("mute, switches and leave", () => {
    const { room, api } = fakeRoom(joinedCall());
    renderPanel(room);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(api.toggleMute).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: /Lower the movie/ }));
    expect(api.setDucking).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("switch", { name: /Push to talk/ }));
    expect(api.setPushToTalk).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("switch", { name: /Show video tiles/ }));
    expect(api.setTilesHidden).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Leave call" }));
    expect(api.leave).toHaveBeenCalled();
  });

  it("has no mute button with push to talk, and shows Unmute when muted", () => {
    const { room } = fakeRoom(joinedCall({ pushToTalk: true }));
    renderPanel(room);
    expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
    cleanup();
    const muted = fakeRoom(joinedCall({ muted: true }));
    renderPanel(muted.room);
    expect(screen.getByRole("button", { name: "Unmute" })).toBeTruthy();
  });

  it("owners can mute, turn off the camera of, and remove others", async () => {
    const { room, api } = fakeRoom(joinedCall());
    renderPanel(room);
    fireEvent.click(
      screen.getByRole("button", { name: "Call options for Bob" }),
    );
    const mute = await screen.findByRole("menuitem", { name: "Mute in call" });
    // Bob is already muted
    expect(
      mute.hasAttribute("disabled") || mute.getAttribute("data-disabled"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Turn off camera" }));
    expect(api.moderate).toHaveBeenCalledWith(BOB, "camera");
    fireEvent.click(
      screen.getByRole("button", { name: "Call options for Bob" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from call" }),
    );
    expect(api.moderate).toHaveBeenCalledWith(BOB, "remove");
  });

  it("owners can mute someone who's unmuted", async () => {
    const { room, api } = fakeRoom(
      joinedCall({ members: [member(ME), member(BOB)] }),
    );
    renderPanel(room);
    fireEvent.click(
      screen.getByRole("button", { name: "Call options for Bob" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mute in call" }),
    );
    expect(api.moderate).toHaveBeenCalledWith(BOB, "mute");
  });

  it("guests get no moderation menu", () => {
    const { room } = fakeRoom(joinedCall());
    renderPanel(room, "guest");
    expect(screen.queryByRole("button", { name: /Call options/ })).toBeNull();
  });
});

describe("CallPanel camera", () => {
  it("lists cameras when there's more than one and switches", async () => {
    const { room, api } = fakeRoom(joinedCall());
    renderPanel(room);
    const select = (await screen.findAllByLabelText("Camera")).find(
      (e) => e.tagName === "INPUT",
    )!;
    // The current camera isn't listed → placeholder
    expect((select as HTMLInputElement).value).toBe("");
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Camera 2" }));
    await waitFor(() =>
      expect(api.setCameraDevice).toHaveBeenCalledWith("cam-2"),
    );
    expect(
      screen.getByRole("button", { name: "Turn camera on (V)" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn camera on (V)" }));
    expect(api.toggleCamera).toHaveBeenCalled();
  });

  it("shows the preview while it's on", async () => {
    const play = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      writable: true,
      value: play,
    });
    const { room, video } = fakeRoom({ camera: true });
    video.setLocal(new FakeTrack("video") as unknown as MediaStreamTrack);
    const { unmount } = renderPanel(room);
    const el = screen.getByLabelText("Your camera") as HTMLVideoElement;
    expect(el.srcObject).toBe(video.getSnapshot().local);
    expect(play).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Turn camera off" }),
    ).toBeTruthy();
    unmount();
    expect(el.srcObject).toBeNull();
  });

  it("explains a camera error and offers to try again", () => {
    const { room } = fakeRoom({ cameraError: "blocked" });
    renderPanel(room);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try the camera again" }),
    ).toBeTruthy();
  });

  it("before joining the camera button has no shortcut", () => {
    const { room } = fakeRoom();
    renderPanel(room);
    expect(screen.getByRole("button", { name: "Turn camera on" })).toBeTruthy();
  });
});

describe("CallControl", () => {
  it("desktop: 'Voice' opens the panel; shows who's in the call", async () => {
    const { room } = fakeRoom();
    render(wrap(<CallControl room={room} isPhone={false} />));
    const trigger = screen.getByRole("button", { name: "Voice call" });
    expect(trigger.textContent).toContain("Voice");
    fireEvent.click(trigger);
    expect(await screen.findByText("Nobody's in the call yet")).toBeTruthy();
    cleanup();
    const others = fakeRoom({ members: [member(BOB)] });
    render(wrap(<CallControl room={others.room} isPhone={false} />));
    expect(
      screen.getByRole("button", { name: "Voice call, 1 in the call. Join" }),
    ).toBeTruthy();
  });

  it("in the call: camera and mic buttons; reconnecting in the label", () => {
    const { room, api } = fakeRoom(
      joinedCall({
        members: [member(ME), member(BOB, { reconnecting: true })],
      }),
    );
    render(wrap(<CallControl room={room} isPhone={false} />));
    expect(
      screen.getByRole("button", {
        name: "Voice call, 2 in the call, reconnecting",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    expect(api.toggleCamera).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(api.toggleMute).toHaveBeenCalled();
  });

  it("shows Unmute and camera-off states", () => {
    const { room } = fakeRoom(joinedCall({ muted: true, camera: true }));
    render(wrap(<CallControl room={room} isPhone={false} />));
    expect(
      screen.getByRole("button", { name: "Unmute microphone" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Turn camera off" }),
    ).toBeTruthy();
  });

  it("push to talk: hold the button to talk", () => {
    const { room, api } = fakeRoom(joinedCall({ pushToTalk: true }));
    render(wrap(<CallControl room={room} isPhone={false} />));
    const btn = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(api.pttDown).toHaveBeenCalled();
    fireEvent.pointerUp(btn);
    expect(api.pttUp).toHaveBeenCalled();
    fireEvent.contextMenu(btn);
    cleanup();
    const held = fakeRoom(joinedCall({ pushToTalk: true, pttHeld: true }));
    render(wrap(<CallControl room={held.room} isPhone={false} />));
    expect(
      screen
        .getByRole("button", { name: "Hold to talk" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("phone: an icon with a count opens the panel in a drawer; no camera button", async () => {
    const { room } = fakeRoom({ members: [member(BOB)] });
    render(wrap(<CallControl room={room} isPhone />));
    fireEvent.click(
      screen.getByRole("button", { name: "Voice call, 1 in the call. Join" }),
    );
    expect(await screen.findByText("1 in the call")).toBeTruthy();
    cleanup();
    const joined = fakeRoom(joinedCall());
    render(wrap(<CallControl room={joined.room} isPhone />));
    expect(screen.queryByRole("button", { name: /Turn camera/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Mute microphone" }),
    ).toBeTruthy();
  });
});
