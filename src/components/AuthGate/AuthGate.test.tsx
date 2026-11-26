import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

vi.mock("../../utils/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/auth")>();
  return {
    ...actual,
    fetchSession: vi.fn(),
    loginWithDetails: vi.fn(),
    logout: vi.fn(async () => {}),
    fetchRoomInfo: vi.fn(),
    joinRoom: vi.fn(),
  };
});

import {
  fetchRoomInfo,
  fetchSession,
  joinRoom,
  loginWithDetails,
} from "../../utils/auth";
import { notifyUnauthorized } from "../../utils/api";
import {
  AuthGate,
  formatCountdown,
  LoginScreen,
  resetLinkPassword,
  useAuth,
} from "./AuthGate";

const mockedInfo = vi.mocked(fetchRoomInfo);
const mockedJoin = vi.mocked(joinRoom);

const mockedLogin = vi.mocked(loginWithDetails);
const mockedSession = vi.mocked(fetchSession);

const wrap = (ui: React.ReactNode) =>
  render(<MantineProvider>{ui}</MantineProvider>);

const typePassword = (value: string) =>
  fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), {
    target: { value },
  });

const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  resetLinkPassword();
});

describe("LoginScreen", () => {
  it("disables Continue until a password is typed", () => {
    wrap(<LoginScreen onSuccess={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button.hasAttribute("disabled")).toBe(true);
    typePassword("x");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("calls onSuccess after a good password", async () => {
    mockedLogin.mockResolvedValue({ result: "ok" });
    const onSuccess = vi.fn();
    wrap(<LoginScreen onSuccess={onSuccess} />);
    typePassword("hunter2");
    await submit();
    expect(mockedLogin).toHaveBeenCalledWith("hunter2");
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows an inline error for a wrong password, cleared when typing", async () => {
    mockedLogin.mockResolvedValue({ result: "invalid_password" });
    wrap(<LoginScreen onSuccess={vi.fn()} />);
    typePassword("nope");
    await submit();
    expect(screen.getByText("Wrong password. Try again.")).toBeTruthy();
    typePassword("nope2");
    expect(screen.queryByText("Wrong password. Try again.")).toBeNull();
  });

  it("locks the form with a countdown when rate limited", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockedLogin.mockResolvedValue({ result: "rate_limited", retryAfterSec: 3 });
    wrap(<LoginScreen onSuccess={vi.fn()} />);
    typePassword("x");
    await submit();
    expect(screen.getByRole("alert").textContent).toContain(
      "Too many attempts",
    );
    expect(screen.getByRole("alert").textContent).toContain("0:03");
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      (
        screen.getByLabelText("Password", {
          selector: "input",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("alert").textContent).toContain("0:02");
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("formats the countdown", () => {
    expect(formatCountdown(42)).toBe("0:42");
    expect(formatCountdown(61)).toBe("1:01");
    expect(formatCountdown(-1)).toBe("0:00");
  });
});

describe("AuthGate", () => {
  const Child = () => {
    const { authRequired } = useAuth();
    return <div>app content {String(authRequired)}</div>;
  };

  it("shows the app when no password is required", async () => {
    mockedSession.mockResolvedValue({
      authenticated: false,
      authRequired: false,
    });
    wrap(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(await screen.findByText("app content false")).toBeTruthy();
  });

  it("shows the login form, then the app after logging in", async () => {
    mockedSession.mockResolvedValue({
      authenticated: false,
      authRequired: true,
    });
    mockedLogin.mockResolvedValue({ result: "ok" });
    wrap(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(await screen.findByText("Welcome back")).toBeTruthy();
    typePassword("pw");
    await submit();
    expect(await screen.findByText("app content true")).toBeTruthy();
  });

  it("offers a retry when the server can't be reached", async () => {
    mockedSession.mockRejectedValueOnce(new Error("offline"));
    mockedSession.mockResolvedValueOnce({
      authenticated: true,
      authRequired: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    wrap(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(await screen.findByText("Couldn't reach the server")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(await screen.findByText("app content true")).toBeTruthy();
  });
});

describe("AuthGate on a room page (guests)", () => {
  const Child = () => {
    const { role, roomAccessLost } = useAuth();
    return (
      <div>
        <span>room as {role}</span>
        <button onClick={() => roomAccessLost("brave-otter-sings", "kicked")}>
          kick me
        </button>
      </div>
    );
  };
  const renderRoom = (path = "/watch/brave-otter-sings") => {
    window.history.replaceState(null, "", path);
    resetLinkPassword();
    return wrap(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
  };
  const stranger = { authenticated: false, authRequired: true, guestRooms: [] };

  it("shows the room password screen, then the room as a guest", async () => {
    mockedSession.mockResolvedValue(stranger);
    mockedInfo.mockResolvedValue({
      title: "Movie night",
      passwordRequired: true,
    });
    mockedJoin.mockResolvedValueOnce({ result: "invalid_password" });
    mockedJoin.mockResolvedValueOnce({ result: "ok" });
    renderRoom();
    expect(await screen.findByText("Join Movie night")).toBeTruthy();
    const input = () =>
      screen.getByLabelText("Room password", { selector: "input" });
    fireEvent.change(input(), { target: { value: "nope" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    });
    expect(await screen.findByText("Wrong password. Try again.")).toBeTruthy();
    fireEvent.change(input(), { target: { value: "otter-maple-42" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    });
    expect(mockedJoin).toHaveBeenLastCalledWith(
      "brave-otter-sings",
      "otter-maple-42",
    );
    expect(await screen.findByText("room as guest")).toBeTruthy();
  });

  it("falls back to the generated name when the room has no title", async () => {
    mockedSession.mockResolvedValue(stranger);
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: true });
    renderRoom();
    expect(await screen.findByText("Join Brave otter sings")).toBeTruthy();
  });

  it("joins an open room without asking", async () => {
    mockedSession.mockResolvedValue(stranger);
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: false });
    mockedJoin.mockResolvedValue({ result: "ok" });
    renderRoom();
    expect(await screen.findByText("room as guest")).toBeTruthy();
    expect(mockedJoin).toHaveBeenCalledWith("brave-otter-sings", undefined);
  });

  it("uses a #pw= link password and strips it from the address bar", async () => {
    mockedSession.mockResolvedValue(stranger);
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: true });
    mockedJoin.mockResolvedValue({ result: "ok" });
    renderRoom("/watch/brave-otter-sings#pw=otter-maple-42");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/watch/brave-otter-sings");
    expect(await screen.findByText("room as guest")).toBeTruthy();
    expect(mockedJoin).toHaveBeenCalledWith(
      "brave-otter-sings",
      "otter-maple-42",
    );
  });

  it("says so when the link's password is wrong", async () => {
    mockedSession.mockResolvedValue(stranger);
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: true });
    mockedJoin.mockResolvedValue({ result: "invalid_password" });
    renderRoom("/watch/brave-otter-sings#pw=old-password");
    expect(
      await screen.findByText(/The password in your link didn't work/),
    ).toBeTruthy();
  });

  it("counts down after too many attempts", async () => {
    mockedSession.mockResolvedValue(stranger);
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: true });
    mockedJoin.mockResolvedValue({ result: "rate_limited", retryAfterSec: 90 });
    renderRoom();
    fireEvent.change(
      await screen.findByLabelText("Room password", { selector: "input" }),
      { target: { value: "x" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    });
    expect(await screen.findByText("Too many attempts")).toBeTruthy();
    expect(screen.getByText("1:30")).toBeTruthy();
  });

  it("a guest of the room goes straight in; kicked shows the removed screen", async () => {
    mockedSession.mockResolvedValue({
      ...stranger,
      guestRooms: ["brave-otter-sings"],
    });
    renderRoom();
    expect(await screen.findByText("room as guest")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "kick me" }));
    });
    expect(
      await screen.findByText("You were removed from this room"),
    ).toBeTruthy();
    expect(mockedInfo).not.toHaveBeenCalled();
  });

  it("a guest whose access expires (401) is asked for the room password again", async () => {
    mockedSession.mockResolvedValue({
      ...stranger,
      guestRooms: ["brave-otter-sings"],
    });
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: true });
    renderRoom();
    expect(await screen.findByText("room as guest")).toBeTruthy();
    await act(async () => notifyUnauthorized());
    expect(
      await screen.findByText(/Your access to this room ended/),
    ).toBeTruthy();
  });

  it("guests get the instance login on Home", async () => {
    mockedSession.mockResolvedValue({
      ...stranger,
      guestRooms: ["brave-otter-sings"],
    });
    renderRoom("/");
    expect(await screen.findByText("Welcome back")).toBeTruthy();
  });

  it("an owner whose session ends on a room page gets the instance login", async () => {
    mockedSession.mockResolvedValue({
      authenticated: true,
      authRequired: true,
    });
    renderRoom();
    expect(await screen.findByText("room as owner")).toBeTruthy();
    await act(async () => notifyUnauthorized());
    expect(await screen.findByText("Welcome back")).toBeTruthy();
    // ...with a way back to the room password screen
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: true });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Have a room password? Join the room",
        }),
      );
    });
    expect(await screen.findByText("Join Brave otter sings")).toBeTruthy();
  });

  it("'Owner? Log in' switches to the instance login", async () => {
    mockedSession.mockResolvedValue(stranger);
    mockedInfo.mockResolvedValue({ title: "", passwordRequired: true });
    mockedLogin.mockResolvedValue({ result: "ok" });
    renderRoom();
    const ownerLogin = await screen.findByRole("button", {
      name: "Owner? Log in",
    });
    await act(async () => {
      fireEvent.click(ownerLogin);
    });
    typePassword("pw");
    await submit();
    expect(await screen.findByText("room as owner")).toBeTruthy();
  });
});
