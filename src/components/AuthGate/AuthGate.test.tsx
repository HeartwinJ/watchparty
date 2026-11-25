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
  };
});

import { fetchSession, loginWithDetails } from "../../utils/auth";
import { AuthGate, formatCountdown, LoginScreen, useAuth } from "./AuthGate";

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
