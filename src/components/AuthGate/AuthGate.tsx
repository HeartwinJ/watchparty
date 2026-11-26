import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { Button, Loader, PasswordInput } from "@mantine/core";
import { IconAlertTriangle, IconClock, IconLock } from "@tabler/icons-react";
import { onUnauthorized } from "../../utils/api";
import {
  authReducer,
  authView,
  fetchSession,
  initialAuthState,
  loginWithDetails,
  logout,
  takePasswordFromHash,
  type LoginResult,
  type RoomAccessLossReason,
} from "../../utils/auth";
import { matchRoute, useRoute } from "../../router";
import { StatusPage, statusStyles } from "../StatusPage/StatusPage";
import { formatCountdown, useCountdown } from "./countdown";
import { RoomJoinScreen } from "./RoomJoinScreen";
import styles from "./AuthGate.module.css";

export { formatCountdown };

interface AuthContextValue {
  // Whether this server requires the instance password (controls whether "Log out" is shown)
  authRequired: boolean;
  /** Owner: instance session (or auth off), can do everything. Guest: has access to this one room only. */
  role: "owner" | "guest";
  logout: () => Promise<void>;
  /** The server took this guest's access to the room away (kicked, password changed) */
  roomAccessLost: (roomId: string, reason: RoomAccessLossReason) => void;
}

export const AuthContext = createContext<AuthContextValue>({
  authRequired: false,
  role: "owner",
  logout: async () => {},
  roomAccessLost: () => {},
});

export const useAuth = () => useContext(AuthContext);

const watchRoomId = (pathname: string) => {
  const route = matchRoute(pathname);
  return route.name === "watch" ? route.roomId : null;
};

// A "#pw=" room password from the link, read (and removed from the address bar) once per page load
let linkPassword: { roomId: string; password: string } | null | undefined;
function takeLinkPassword() {
  if (linkPassword === undefined) {
    const roomId = watchRoomId(window.location.pathname);
    const password = takePasswordFromHash();
    linkPassword = roomId && password ? { roomId, password } : null;
  }
  return linkPassword;
}
/** For tests */
export function resetLinkPassword() {
  linkPassword = undefined;
}

/**
 * Checks GET /session on load. Owners see the app; on a room page, guests of that room see the room and anyone else
 * sees the room password screen; every other page needs the instance login.
 */
export const AuthGate = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);
  const route = useRoute();
  const roomId = route.name === "watch" ? route.roomId : null;
  // Strip "#pw=" right away, before anything else renders
  const fromLink = takeLinkPassword();

  useEffect(() => {
    if (state.status !== "loading") {
      return;
    }
    let cancelled = false;
    fetchSession().then(
      (session) => !cancelled && dispatch({ type: "session", session }),
      (e) => {
        console.error(e);
        !cancelled && dispatch({ type: "sessionError" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.status]);

  useEffect(
    () =>
      onUnauthorized(() =>
        dispatch({
          type: "unauthorized",
          roomId: watchRoomId(window.location.pathname),
        }),
      ),
    [],
  );

  const doLogout = useCallback(async () => {
    await logout();
    dispatch({ type: "logout" });
  }, []);
  const roomAccessLost = useCallback(
    (lostRoomId: string, reason: RoomAccessLossReason) =>
      dispatch({ type: "roomAccessLost", roomId: lostRoomId, reason }),
    [],
  );

  const view = authView(state, roomId);
  const authRequired = state.status === "ready" && state.authRequired;
  const role = view.kind === "app" ? view.role : "owner";
  const context = useMemo(
    () => ({ authRequired, role, logout: doLogout, roomAccessLost }),
    [authRequired, role, doLogout, roomAccessLost],
  );

  switch (view.kind) {
    case "loading":
      return (
        <StatusPage>
          <div className={statusStyles.center} role="status">
            <Loader size="sm" />
            Connecting…
          </div>
        </StatusPage>
      );
    case "error":
      return (
        <StatusPage
          icon={<IconAlertTriangle size={22} color="var(--wp-danger)" />}
          title="Couldn't reach the server"
          actions={
            <Button onClick={() => dispatch({ type: "retry" })}>Retry</Button>
          }
        >
          <p className={statusStyles.text}>
            Check your connection and try again.
          </p>
        </StatusPage>
      );
    case "login":
      return (
        <LoginScreen
          onSuccess={() => dispatch({ type: "loginSuccess" })}
          onUseRoomPassword={
            view.roomId
              ? () => dispatch({ type: "showLogin", show: false })
              : undefined
          }
        />
      );
    case "roomJoin":
      return (
        <RoomJoinScreen
          key={view.roomId}
          roomId={view.roomId}
          lost={view.lost}
          linkPassword={
            fromLink?.roomId === view.roomId ? fromLink.password : undefined
          }
          onJoined={() => dispatch({ type: "roomJoined", roomId: view.roomId })}
          onOwnerLogin={() => dispatch({ type: "showLogin", show: true })}
        />
      );
    case "app":
      return (
        <AuthContext.Provider value={context}>{children}</AuthContext.Provider>
      );
  }
};

const errorMessages: Record<
  Exclude<LoginResult, "ok" | "rate_limited">,
  string
> = {
  invalid_password: "Wrong password. Try again.",
  error: "Couldn't log in. Check your connection and try again.",
};

/** The instance password form: inline errors with a shake, and a countdown after too many attempts (429). */
export const LoginScreen = ({
  onSuccess,
  onUseRoomPassword,
}: {
  onSuccess: () => void;
  /** On a room page: go back to the room password screen */
  onUseRoomPassword?: () => void;
}) => {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const secondsLeft = useCountdown(lockedUntil);
  const locked = secondsLeft > 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || submitting || locked) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const { result, retryAfterSec } = await loginWithDetails(password);
    setSubmitting(false);
    if (result === "ok") {
      onSuccess();
    } else if (result === "rate_limited") {
      setLockedUntil(Date.now() + (retryAfterSec ?? 60) * 1000);
    } else {
      setError(errorMessages[result]);
      setShakeKey((k) => k + 1);
    }
  };

  return (
    <StatusPage glow brand>
      <h1 className={statusStyles.title}>Welcome back</h1>
      <p className={statusStyles.text}>
        This is a private instance. Enter the password to continue.
      </p>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div
          key={shakeKey}
          className={shakeKey ? statusStyles.shake : undefined}
        >
          <PasswordInput
            label="Password"
            placeholder="Password"
            size="md"
            leftSection={<IconLock size={16} />}
            value={password}
            onChange={(e) => {
              setPassword(e.currentTarget.value);
              setError(null);
            }}
            error={error}
            disabled={locked}
            autoFocus
            autoComplete="current-password"
            visibilityToggleButtonProps={{
              "aria-label": "Show or hide password",
              tabIndex: 0,
            }}
          />
        </div>
        {locked && (
          <div className={styles.alert} role="alert">
            <IconClock
              size={18}
              className={styles.alertIcon}
              aria-hidden="true"
            />
            <div>
              <b>Too many attempts</b>
              Try again in{" "}
              <span className={styles.mono}>
                {formatCountdown(secondsLeft)}
              </span>
              .
            </div>
          </div>
        )}
        <Button
          type="submit"
          size="md"
          fullWidth
          loading={submitting}
          disabled={!password || locked}
        >
          Continue
        </Button>
        {onUseRoomPassword && (
          <div className={styles.switchRow}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={onUseRoomPassword}
            >
              Have a room password? Join the room
            </button>
          </div>
        )}
      </form>
    </StatusPage>
  );
};
