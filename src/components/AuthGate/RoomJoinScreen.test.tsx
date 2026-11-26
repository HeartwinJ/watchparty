// The room password screen on its own: not found, server errors with Retry, kicked, typed-password errors and
// the lost-access messages.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchRoomInfo = vi.fn();
const joinRoom = vi.fn();
vi.mock("../../utils/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/auth")>()),
  fetchRoomInfo: (...a: unknown[]) => fetchRoomInfo(...a),
  joinRoom: (...a: unknown[]) => joinRoom(...a),
}));

const { RoomJoinScreen } = await import("./RoomJoinScreen");

const onJoined = vi.fn();
const onOwnerLogin = vi.fn();
function renderScreen(
  props: Partial<React.ComponentProps<typeof RoomJoinScreen>> = {},
) {
  return render(
    <MantineProvider env="test">
      <RoomJoinScreen
        roomId="brave-otter"
        lost={null}
        onJoined={onJoined}
        onOwnerLogin={onOwnerLogin}
        {...props}
      />
    </MantineProvider>,
  );
}

beforeEach(() => {
  fetchRoomInfo.mockReset();
  joinRoom.mockReset();
  onJoined.mockClear();
  onOwnerLogin.mockClear();
});
afterEach(() => cleanup());

const typeAndJoin = (pw: string) => {
  fireEvent.change(screen.getByLabelText("Room password"), {
    target: { value: pw },
  });
  fireEvent.click(screen.getByRole("button", { name: "Join room" }));
};

describe("RoomJoinScreen", () => {
  it("says the room doesn't exist (and offers the owner login)", async () => {
    fetchRoomInfo.mockResolvedValue(null);
    renderScreen();
    expect(screen.getByText("Opening the room…")).toBeTruthy();
    await screen.findByText("Room not found");
    fireEvent.click(screen.getByRole("button", { name: "Owner? Log in" }));
    expect(onOwnerLogin).toHaveBeenCalled();
  });

  it("offers Retry when the server can't be reached", async () => {
    fetchRoomInfo.mockRejectedValueOnce(new Error("offline"));
    fetchRoomInfo.mockResolvedValueOnce({
      title: "Movie night",
      passwordRequired: true,
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Join Movie night");
    expect(fetchRoomInfo).toHaveBeenCalledTimes(2);
  });

  it("shows the removed screen right away for a kicked browser", () => {
    renderScreen({ lost: "kicked" });
    expect(screen.getByText("You were removed from this room")).toBeTruthy();
    expect(fetchRoomInfo).not.toHaveBeenCalled();
  });

  it("explains why access was lost", async () => {
    fetchRoomInfo.mockResolvedValue({ title: "", passwordRequired: true });
    renderScreen({ lost: "passwordChanged" });
    await screen.findByText("The room password changed. Ask for the new one.");
    expect(screen.getByText("Join Brave otter")).toBeTruthy();
  });

  it("a wrong typed password shows an error that typing clears; success joins", async () => {
    fetchRoomInfo.mockResolvedValue({ title: "", passwordRequired: true });
    renderScreen();
    await screen.findByLabelText("Room password");
    joinRoom.mockResolvedValueOnce({ result: "invalid_password" });
    typeAndJoin("nope");
    await screen.findByText("Wrong password. Try again.");
    expect(joinRoom).toHaveBeenCalledWith("brave-otter", "nope");
    fireEvent.change(screen.getByLabelText("Room password"), {
      target: { value: "nope2" },
    });
    expect(screen.queryByText("Wrong password. Try again.")).toBeNull();
    joinRoom.mockResolvedValueOnce({ result: "error" });
    fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    await screen.findByText(/Couldn't join/);
    joinRoom.mockResolvedValueOnce({ result: "ok" });
    fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalled());
  });

  it("a typed password can turn out kicked or the room gone", async () => {
    fetchRoomInfo.mockResolvedValue({ title: "", passwordRequired: true });
    renderScreen();
    await screen.findByLabelText("Room password");
    joinRoom.mockResolvedValueOnce({ result: "kicked" });
    typeAndJoin("pw12");
    await screen.findByText("You were removed from this room");
    cleanup();
    renderScreen();
    await screen.findByLabelText("Room password");
    joinRoom.mockResolvedValueOnce({ result: "not_found" });
    typeAndJoin("pw12");
    await screen.findByText("Room not found");
  });

  it("locks for 60 s by default when rate limited without Retry-After", async () => {
    fetchRoomInfo.mockResolvedValue({ title: "", passwordRequired: true });
    renderScreen();
    await screen.findByLabelText("Room password");
    joinRoom.mockResolvedValueOnce({ result: "rate_limited" });
    typeAndJoin("pw12");
    await screen.findByText("Too many attempts");
    expect(screen.getByText(/^(1:00|0:59)$/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Join room" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
