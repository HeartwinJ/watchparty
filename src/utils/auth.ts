import { apiFetch } from "./api";

export interface SessionInfo {
  /** Owner: logged in with the instance password (or auth is off) */
  authenticated: boolean;
  authRequired: boolean;
  /** Rooms (ids without the slash) this browser is a guest of; only for non-owners */
  guestRooms?: string[];
}

/**
 * GET /session. A 404 (or a non-JSON page) means the server predates password auth, so treat auth as not required.
 * Throws on network errors and unexpected responses.
 */
export async function fetchSession(): Promise<SessionInfo> {
  const response = await apiFetch("/session", undefined, {
    ignoreUnauthorized: true,
  });
  if (response.status === 404) {
    return { authenticated: false, authRequired: false };
  }
  if (!response.ok) {
    throw new Error(`Unexpected /session response: ${response.status}`);
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    // e.g. an older server's SPA fallback answering with index.html: it has no auth
    return { authenticated: false, authRequired: false };
  }
  return {
    authenticated: Boolean(data?.authenticated),
    authRequired: Boolean(data?.authRequired),
    guestRooms: Array.isArray(data?.guestRooms)
      ? data.guestRooms.filter((r: unknown) => typeof r === "string")
      : [],
  };
}

export type LoginResult = "ok" | "invalid_password" | "rate_limited" | "error";

export interface LoginOutcome {
  result: LoginResult;
  /** Seconds until another attempt is allowed (only for "rate_limited") */
  retryAfterSec?: number;
}

/** Default wait when a 429 doesn't say how long (the server's window is 10 minutes). */
export const DEFAULT_RETRY_AFTER_SEC = 60;

/** Reads the wait from a 429: the JSON `retryAfter`, else the Retry-After header, else a default. */
async function readRetryAfter(response: Response): Promise<number> {
  let fromBody: unknown;
  try {
    fromBody = (await response.json())?.retryAfter;
  } catch {
    // Not JSON
  }
  const candidates = [fromBody, response.headers.get("Retry-After")];
  for (const value of candidates) {
    const n = Number(value);
    if (value != null && value !== "" && Number.isFinite(n) && n > 0) {
      return Math.ceil(n);
    }
  }
  return DEFAULT_RETRY_AFTER_SEC;
}

/** POST /login with details (the rate-limit wait). On success the server sets an httpOnly session cookie. */
export async function loginWithDetails(
  password: string,
): Promise<LoginOutcome> {
  let response: Response;
  try {
    response = await apiFetch(
      "/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      },
      { ignoreUnauthorized: true },
    );
  } catch {
    return { result: "error" };
  }
  if (response.ok) {
    return { result: "ok" };
  }
  if (response.status === 401) {
    return { result: "invalid_password" };
  }
  if (response.status === 429) {
    return {
      result: "rate_limited",
      retryAfterSec: await readRetryAfter(response),
    };
  }
  return { result: "error" };
}

/** POST /login. On success the server sets an httpOnly session cookie. */
export async function login(password: string): Promise<LoginResult> {
  return (await loginWithDetails(password)).result;
}

/** POST /logout. Errors are ignored: the caller shows the login screen either way. */
export async function logout(): Promise<void> {
  try {
    await apiFetch("/logout", { method: "POST" }, { ignoreUnauthorized: true });
  } catch (e) {
    console.warn(e);
  }
}

/** Why a guest is back on the room password screen */
export type RoomAccessLossReason = "kicked" | "passwordChanged" | "expired";

// The session as far as the client knows it. What's shown also depends on the route (see authView).
export type AuthState =
  | { status: "loading" }
  | {
      status: "ready";
      authRequired: boolean;
      /** Logged in with the instance password (always true while auth is off) */
      owner: boolean;
      /** Rooms this browser is a guest of (ids without the slash) */
      guestRooms: string[];
      /** Show the instance login even on a room page (an owner's session ended, or "I'm the owner") */
      forceLogin: boolean;
      /** The last room this guest lost access to, and why (shown on the room password screen) */
      lost: { roomId: string; reason: RoomAccessLossReason } | null;
    }
  | { status: "error" };

export type AuthEvent =
  | { type: "session"; session: SessionInfo }
  | { type: "sessionError" }
  | { type: "loginSuccess" }
  /** A 401 or a refused socket. `roomId` is the room page we're on, if any. */
  | { type: "unauthorized"; roomId: string | null }
  | { type: "roomJoined"; roomId: string }
  | { type: "roomAccessLost"; roomId: string; reason: RoomAccessLossReason }
  | { type: "showLogin"; show: boolean }
  | { type: "logout" }
  | { type: "retry" };

export const initialAuthState: AuthState = { status: "loading" };

const without = (list: string[], item: string) =>
  list.includes(item) ? list.filter((x) => x !== item) : list;

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "session": {
      const { authRequired, authenticated, guestRooms } = event.session;
      return {
        status: "ready",
        authRequired,
        owner: !authRequired || authenticated,
        guestRooms: guestRooms ?? [],
        forceLogin: false,
        lost: null,
      };
    }
    case "sessionError":
      return { status: "error" };
    case "retry":
      return { status: "loading" };
  }
  if (state.status !== "ready") {
    return state;
  }
  switch (event.type) {
    case "loginSuccess":
      return { ...state, authRequired: true, owner: true, forceLogin: false };
    case "unauthorized":
      if (state.owner) {
        // An owner's session ended (or the server now requires a password): back to the instance login
        return {
          ...state,
          authRequired: true,
          owner: false,
          forceLogin: true,
        };
      }
      if (event.roomId && state.guestRooms.includes(event.roomId)) {
        return {
          ...state,
          guestRooms: without(state.guestRooms, event.roomId),
          lost: { roomId: event.roomId, reason: "expired" },
        };
      }
      return state;
    case "roomJoined":
      return {
        ...state,
        guestRooms: [...without(state.guestRooms, event.roomId), event.roomId],
        lost: state.lost?.roomId === event.roomId ? null : state.lost,
      };
    case "roomAccessLost":
      if (state.owner) {
        return state;
      }
      return {
        ...state,
        guestRooms: without(state.guestRooms, event.roomId),
        lost: { roomId: event.roomId, reason: event.reason },
      };
    case "showLogin":
      return state.forceLogin === event.show
        ? state
        : { ...state, forceLogin: event.show };
    case "logout":
      return { ...state, owner: false, forceLogin: true };
  }
}

/** What to render for the current route: the app (as owner or guest), the instance login, or a room's password screen */
export type AuthView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "app"; role: "owner" | "guest" }
  | { kind: "login"; roomId: string | null }
  | { kind: "roomJoin"; roomId: string; lost: RoomAccessLossReason | null };

/** `roomId` is the room of the current /watch/:roomId page, null on any other page. */
export function authView(state: AuthState, roomId: string | null): AuthView {
  if (state.status !== "ready") {
    return { kind: state.status };
  }
  if (state.owner) {
    return { kind: "app", role: "owner" };
  }
  if (roomId && !state.forceLogin) {
    if (state.guestRooms.includes(roomId)) {
      return { kind: "app", role: "guest" };
    }
    return {
      kind: "roomJoin",
      roomId,
      lost: state.lost?.roomId === roomId ? state.lost.reason : null,
    };
  }
  // Home, /create etc. are for owners only
  return { kind: "login", roomId };
}

// --- Room guests ---

export interface RoomInfo {
  title: string;
  passwordRequired: boolean;
}

/** GET /rooms/:roomId/info: the join screen's heading. Null for an unknown room; throws on other errors. */
export async function fetchRoomInfo(roomId: string): Promise<RoomInfo | null> {
  const response = await apiFetch(
    `/rooms/${encodeURIComponent(roomId)}/info`,
    undefined,
    { ignoreUnauthorized: true },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`room info ${response.status}`);
  }
  const data = await response.json();
  return {
    title: typeof data?.title === "string" ? data.title : "",
    passwordRequired: Boolean(data?.passwordRequired),
  };
}

export type JoinResult =
  "ok" | "invalid_password" | "rate_limited" | "kicked" | "not_found" | "error";

/** POST /rooms/:roomId/join. On success the server sets an httpOnly guest cookie for that room. */
export async function joinRoom(
  roomId: string,
  password?: string,
): Promise<{ result: JoinResult; retryAfterSec?: number }> {
  let response: Response;
  try {
    response = await apiFetch(
      `/rooms/${encodeURIComponent(roomId)}/join`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(password === undefined ? {} : { password }),
      },
      { ignoreUnauthorized: true },
    );
  } catch {
    return { result: "error" };
  }
  if (response.ok) {
    return { result: "ok" };
  }
  switch (response.status) {
    case 401:
      return { result: "invalid_password" };
    case 403:
      return { result: "kicked" };
    case 404:
      return { result: "not_found" };
    case 429:
      return {
        result: "rate_limited",
        retryAfterSec: await readRetryAfter(response),
      };
  }
  return { result: "error" };
}

/**
 * Reads a room password from a "#pw=..." link fragment (the fragment never reaches the server) and removes it from
 * the address bar, so it doesn't linger in history or get copied along. Undefined when there is none.
 */
export function takePasswordFromHash(
  loc: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): string | undefined {
  if (!loc.hash.startsWith("#")) {
    return undefined;
  }
  const params = new URLSearchParams(loc.hash.slice(1));
  const pw = params.get("pw");
  if (pw === null) {
    return undefined;
  }
  params.delete("pw");
  const rest = params.toString();
  history.replaceState(
    history.state,
    "",
    loc.pathname + loc.search + (rest ? "#" + rest : ""),
  );
  return pw || undefined;
}
