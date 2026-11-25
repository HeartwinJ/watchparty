import { apiFetch } from "./api";

export interface SessionInfo {
  authenticated: boolean;
  authRequired: boolean;
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

// What the app shows: a spinner while checking, the login form, the app itself, or an error with a retry.
export type AuthState =
  | { status: "loading" }
  | { status: "login"; authRequired: true }
  | { status: "ready"; authRequired: boolean }
  | { status: "error" };

export type AuthEvent =
  | { type: "session"; session: SessionInfo }
  | { type: "sessionError" }
  | { type: "loginSuccess" }
  | { type: "unauthorized" }
  | { type: "logout" }
  | { type: "retry" };

export const initialAuthState: AuthState = { status: "loading" };

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "session": {
      const { authRequired, authenticated } = event.session;
      if (authRequired && !authenticated) {
        return { status: "login", authRequired: true };
      }
      return { status: "ready", authRequired };
    }
    case "sessionError":
      return { status: "error" };
    case "loginSuccess":
      return { status: "ready", authRequired: true };
    case "unauthorized":
    case "logout":
      // A 401 means the server requires a password now (even if /session said otherwise earlier,
      // e.g. it restarted with APP_PASSWORD set)
      if (state.status === "login") {
        return state;
      }
      return { status: "login", authRequired: true };
    case "retry":
      return { status: "loading" };
  }
}
