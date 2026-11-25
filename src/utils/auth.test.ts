import { afterEach, describe, expect, it, vi } from "vitest";
import { onUnauthorized, serverPath } from "./api";
import {
  authReducer,
  fetchSession,
  initialAuthState,
  login,
  logout,
  type AuthState,
} from "./auth";

const mockFetch = (status: number, body: unknown = null) => {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === null ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSession", () => {
  it("returns the server's session info", async () => {
    const fetch = mockFetch(200, { authenticated: false, authRequired: true });
    expect(await fetchSession()).toEqual({
      authenticated: false,
      authRequired: true,
    });
    expect(fetch).toHaveBeenCalledWith(serverPath + "/session", {
      credentials: "include",
    });
  });

  it("treats 404 (server without auth) as auth not required", async () => {
    mockFetch(404);
    expect(await fetchSession()).toEqual({
      authenticated: false,
      authRequired: false,
    });
  });

  it("treats a non-JSON page (old server's SPA fallback) as auth not required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html>", { status: 200 })),
    );
    expect(await fetchSession()).toEqual({
      authenticated: false,
      authRequired: false,
    });
  });

  it("throws on server errors", async () => {
    mockFetch(500);
    await expect(fetchSession()).rejects.toThrow();
  });

  it("throws on network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchSession()).rejects.toThrow();
  });
});

describe("login", () => {
  it("posts the password as JSON", async () => {
    const fetch = mockFetch(204);
    expect(await login("hunter2")).toBe("ok");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(serverPath + "/login");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(init!.body as string)).toEqual({ password: "hunter2" });
  });

  it.each([
    [401, "invalid_password"],
    [429, "rate_limited"],
    [500, "error"],
  ] as const)("maps %s to %s", async (status, expected) => {
    mockFetch(status, { error: expected });
    expect(await login("x")).toBe(expected);
  });

  it("doesn't log the user out on a wrong password", async () => {
    mockFetch(401, { error: "invalid_password" });
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await login("wrong");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("returns error when the server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await login("x")).toBe("error");
  });
});

describe("logout", () => {
  it("posts to /logout and swallows errors", async () => {
    const fetch = mockFetch(204);
    await logout();
    expect(fetch).toHaveBeenCalledWith(serverPath + "/logout", {
      credentials: "include",
      method: "POST",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(logout()).resolves.toBeUndefined();
  });
});

describe("authReducer", () => {
  const ready: AuthState = { status: "ready", authRequired: true };
  const open: AuthState = { status: "ready", authRequired: false };

  it("starts loading", () => {
    expect(initialAuthState).toEqual({ status: "loading" });
  });

  it("shows the login form when auth is required and we're not logged in", () => {
    expect(
      authReducer(initialAuthState, {
        type: "session",
        session: { authRequired: true, authenticated: false },
      }),
    ).toEqual({ status: "login", authRequired: true });
  });

  it("shows the app when already logged in", () => {
    expect(
      authReducer(initialAuthState, {
        type: "session",
        session: { authRequired: true, authenticated: true },
      }),
    ).toEqual(ready);
  });

  it("shows the app when auth isn't required", () => {
    expect(
      authReducer(initialAuthState, {
        type: "session",
        session: { authRequired: false, authenticated: false },
      }),
    ).toEqual(open);
  });

  it("goes to the app after logging in", () => {
    expect(
      authReducer(
        { status: "login", authRequired: true },
        { type: "loginSuccess" },
      ),
    ).toEqual(ready);
  });

  it("returns to the login form on 401 or logout", () => {
    expect(authReducer(ready, { type: "unauthorized" })).toEqual({
      status: "login",
      authRequired: true,
    });
    expect(authReducer(ready, { type: "logout" })).toEqual({
      status: "login",
      authRequired: true,
    });
    // e.g. the server restarted with a password set
    expect(authReducer(open, { type: "unauthorized" })).toEqual({
      status: "login",
      authRequired: true,
    });
  });

  it("keeps the same state object when already on the login form", () => {
    const login: AuthState = { status: "login", authRequired: true };
    expect(authReducer(login, { type: "unauthorized" })).toBe(login);
  });

  it("shows an error when the session check fails, and retries", () => {
    const error = authReducer(initialAuthState, { type: "sessionError" });
    expect(error).toEqual({ status: "error" });
    expect(authReducer(error, { type: "retry" })).toEqual({
      status: "loading",
    });
  });
});
