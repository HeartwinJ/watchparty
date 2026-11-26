import { afterEach, describe, expect, it, vi } from "vitest";
import { onUnauthorized, serverPath } from "./api";
import {
  authReducer,
  authView,
  fetchRoomInfo,
  joinRoom,
  takePasswordFromHash,
  fetchSession,
  initialAuthState,
  login,
  loginWithDetails,
  DEFAULT_RETRY_AFTER_SEC,
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
      guestRooms: [],
    });
    expect(fetch).toHaveBeenCalledWith(serverPath + "/session", {
      credentials: "include",
    });
    mockFetch(200, {
      authenticated: false,
      authRequired: true,
      guestRooms: ["brave-otter-sings", 5],
    });
    expect((await fetchSession()).guestRooms).toEqual(["brave-otter-sings"]);
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

  it("reads the retry wait from a 429", async () => {
    mockFetch(429, { error: "rate_limited", retryAfter: 42 });
    expect(await loginWithDetails("x")).toEqual({
      result: "rate_limited",
      retryAfterSec: 42,
    });
    mockFetch(429, { error: "rate_limited" });
    expect((await loginWithDetails("x")).retryAfterSec).toBe(
      DEFAULT_RETRY_AFTER_SEC,
    );
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
  const owner: AuthState = {
    status: "ready",
    authRequired: true,
    owner: true,
    guestRooms: [],
    forceLogin: false,
    lost: null,
  };
  const open: AuthState = { ...owner, authRequired: false };
  const stranger: AuthState = { ...owner, owner: false };
  const guest: AuthState = { ...stranger, guestRooms: ["brave-otter-sings"] };

  it("starts loading", () => {
    expect(initialAuthState).toEqual({ status: "loading" });
  });

  it("reads the session: owner, nobody, or a guest of some rooms", () => {
    expect(
      authReducer(initialAuthState, {
        type: "session",
        session: { authRequired: true, authenticated: true },
      }),
    ).toEqual(owner);
    expect(
      authReducer(initialAuthState, {
        type: "session",
        session: { authRequired: true, authenticated: false },
      }),
    ).toEqual(stranger);
    expect(
      authReducer(initialAuthState, {
        type: "session",
        session: {
          authRequired: true,
          authenticated: false,
          guestRooms: ["brave-otter-sings"],
        },
      }),
    ).toEqual(guest);
    // Auth off: everyone is an owner
    expect(
      authReducer(initialAuthState, {
        type: "session",
        session: { authRequired: false, authenticated: false },
      }),
    ).toEqual(open);
  });

  it("becomes an owner after logging in", () => {
    expect(
      authReducer({ ...stranger, forceLogin: true }, { type: "loginSuccess" }),
    ).toEqual(owner);
  });

  it("sends owners back to the instance login on 401 or logout, even on a room page", () => {
    const loggedOut = { ...owner, owner: false, forceLogin: true };
    expect(
      authReducer(owner, { type: "unauthorized", roomId: "brave-otter-sings" }),
    ).toEqual(loggedOut);
    expect(authReducer(owner, { type: "logout" })).toEqual(loggedOut);
    // e.g. the server restarted with a password set
    expect(authReducer(open, { type: "unauthorized", roomId: null })).toEqual(
      loggedOut,
    );
  });

  it("sends guests back to the room password screen on 401", () => {
    expect(
      authReducer(guest, { type: "unauthorized", roomId: "brave-otter-sings" }),
    ).toEqual({
      ...stranger,
      lost: { roomId: "brave-otter-sings", reason: "expired" },
    });
    // Not a guest of this room (e.g. already on the join screen): nothing changes
    expect(
      authReducer(stranger, { type: "unauthorized", roomId: "other-room" }),
    ).toBe(stranger);
  });

  it("records joined rooms and lost access", () => {
    const joined = authReducer(stranger, {
      type: "roomJoined",
      roomId: "brave-otter-sings",
    });
    expect(joined).toEqual(guest);
    const kicked = authReducer(joined, {
      type: "roomAccessLost",
      roomId: "brave-otter-sings",
      reason: "kicked",
    });
    expect(kicked).toEqual({
      ...stranger,
      lost: { roomId: "brave-otter-sings", reason: "kicked" },
    });
    expect(
      authReducer(kicked, { type: "roomJoined", roomId: "brave-otter-sings" }),
    ).toEqual(guest);
    // Owners never lose access to a room
    expect(
      authReducer(owner, {
        type: "roomAccessLost",
        roomId: "x",
        reason: "kicked",
      }),
    ).toBe(owner);
  });

  it("switches between the instance login and the room password screen", () => {
    const login = authReducer(stranger, { type: "showLogin", show: true });
    expect(login).toEqual({ ...stranger, forceLogin: true });
    expect(authReducer(login, { type: "showLogin", show: true })).toBe(login);
    expect(authReducer(login, { type: "showLogin", show: false })).toEqual(
      stranger,
    );
  });

  it("shows an error when the session check fails, and retries", () => {
    const error = authReducer(initialAuthState, { type: "sessionError" });
    expect(error).toEqual({ status: "error" });
    expect(authReducer(error, { type: "retry" })).toEqual({
      status: "loading",
    });
  });
});

describe("authView", () => {
  const base: AuthState = {
    status: "ready",
    authRequired: true,
    owner: false,
    guestRooms: ["brave-otter-sings"],
    forceLogin: false,
    lost: null,
  };

  it("owners see everything", () => {
    const owner = { ...base, owner: true };
    expect(authView(owner, null)).toEqual({ kind: "app", role: "owner" });
    expect(authView(owner, "any-room")).toEqual({ kind: "app", role: "owner" });
  });

  it("guests see only their rooms; other rooms ask for the room password", () => {
    expect(authView(base, "brave-otter-sings")).toEqual({
      kind: "app",
      role: "guest",
    });
    expect(authView(base, "other-room")).toEqual({
      kind: "roomJoin",
      roomId: "other-room",
      lost: null,
    });
    expect(
      authView(
        { ...base, lost: { roomId: "other-room", reason: "kicked" } },
        "other-room",
      ),
    ).toEqual({ kind: "roomJoin", roomId: "other-room", lost: "kicked" });
  });

  it("guests get the instance login on Home and every other page", () => {
    expect(authView(base, null)).toEqual({ kind: "login", roomId: null });
  });

  it("forceLogin shows the instance login on a room page", () => {
    expect(
      authView({ ...base, forceLogin: true }, "brave-otter-sings"),
    ).toEqual({ kind: "login", roomId: "brave-otter-sings" });
  });

  it("passes loading and error through", () => {
    expect(authView({ status: "loading" }, null)).toEqual({ kind: "loading" });
    expect(authView({ status: "error" }, "x")).toEqual({ kind: "error" });
  });
});

describe("room guests API", () => {
  it("fetchRoomInfo returns the title and whether a password is needed, null for unknown rooms", async () => {
    const fetch = mockFetch(200, {
      title: "Movie night",
      passwordRequired: true,
    });
    expect(await fetchRoomInfo("brave-otter-sings")).toEqual({
      title: "Movie night",
      passwordRequired: true,
    });
    expect(fetch.mock.calls[0][0]).toBe(
      serverPath + "/rooms/brave-otter-sings/info",
    );
    mockFetch(404, { error: "not_found" });
    expect(await fetchRoomInfo("nope")).toBeNull();
    mockFetch(500);
    await expect(fetchRoomInfo("x")).rejects.toThrow();
  });

  it("joinRoom posts the password and maps the answers", async () => {
    const fetch = mockFetch(200, { ok: true });
    expect(await joinRoom("brave-otter-sings", "otter-maple-42")).toEqual({
      result: "ok",
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(serverPath + "/rooms/brave-otter-sings/join");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(init!.body as string)).toEqual({
      password: "otter-maple-42",
    });
    mockFetch(200, { ok: true });
    await joinRoom("open-room");
    for (const [status, result] of [
      [401, "invalid_password"],
      [403, "kicked"],
      [404, "not_found"],
      [500, "error"],
    ] as const) {
      mockFetch(status, { error: "x" });
      expect((await joinRoom("r", "p")).result).toBe(result);
    }
    mockFetch(429, { error: "rate_limited", retryAfter: 30 });
    expect(await joinRoom("r", "p")).toEqual({
      result: "rate_limited",
      retryAfterSec: 30,
    });
  });

  it("joinRoom with a wrong password doesn't trigger the unauthorized handler", async () => {
    mockFetch(401, { error: "invalid_password" });
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await joinRoom("r", "wrong");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("takePasswordFromHash reads #pw= and strips it from the URL", () => {
    const replaceState = vi.fn();
    const history = { replaceState, state: null };
    expect(
      takePasswordFromHash(
        { hash: "#pw=otter-maple-42", pathname: "/watch/r", search: "" },
        history,
      ),
    ).toBe("otter-maple-42");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/watch/r");
    // Encoded characters, and other fragment params are kept
    expect(
      takePasswordFromHash(
        {
          hash: "#x=1&pw=a%20b%26c",
          pathname: "/watch/r",
          search: "?tab=chat",
        },
        history,
      ),
    ).toBe("a b&c");
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/watch/r?tab=chat#x=1",
    );
    replaceState.mockClear();
    expect(
      takePasswordFromHash(
        { hash: "", pathname: "/watch/r", search: "" },
        history,
      ),
    ).toBeUndefined();
    expect(
      takePasswordFromHash(
        { hash: "#other", pathname: "/watch/r", search: "" },
        history,
      ),
    ).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("auth edge cases", () => {
  it("ignores app events until the session is known", () => {
    const loading: AuthState = { status: "loading" };
    expect(authReducer(loading, { type: "loginSuccess" })).toBe(loading);
    expect(authReducer(loading, { type: "unauthorized", roomId: "r" })).toBe(
      loading,
    );
    const error: AuthState = { status: "error" };
    expect(authReducer(error, { type: "roomJoined", roomId: "r" })).toBe(error);
  });

  it("joinRoom reports a network failure as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await joinRoom("r", "p")).toEqual({ result: "error" });
  });

  it("takePasswordFromHash treats an empty #pw= as no password but still strips it", () => {
    const replaceState = vi.fn();
    expect(
      takePasswordFromHash(
        { hash: "#pw=", pathname: "/watch/r", search: "?x=1" },
        { replaceState, state: null },
      ),
    ).toBeUndefined();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/watch/r?x=1");
    expect(
      takePasswordFromHash(
        { hash: "", pathname: "/watch/r", search: "" },
        { replaceState, state: null },
      ),
    ).toBeUndefined();
  });
});
