import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useState,
} from "react";
import { Button, Loader, PasswordInput } from "@mantine/core";
import { IconAlertTriangle, IconClock, IconLock } from "@tabler/icons-react";
import { onUnauthorized } from "../../utils/api";
import {
  authReducer,
  fetchSession,
  initialAuthState,
  loginWithDetails,
  logout,
  type LoginResult,
} from "../../utils/auth";
import { StatusPage, statusStyles } from "../StatusPage/StatusPage";
import styles from "./AuthGate.module.css";

interface AuthContextValue {
  // Whether this server requires the instance password (controls whether "Log out" is shown)
  authRequired: boolean;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  authRequired: false,
  logout: async () => {},
});

export const useAuth = () => useContext(AuthContext);

/** Checks GET /session on load and shows a password form instead of the app until logged in. */
export const AuthGate = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);

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

  useEffect(() => onUnauthorized(() => dispatch({ type: "unauthorized" })), []);

  const doLogout = useCallback(async () => {
    await logout();
    dispatch({ type: "logout" });
  }, []);

  if (state.status === "loading") {
    return (
      <StatusPage>
        <div className={statusStyles.center} role="status">
          <Loader size="sm" />
          Connecting…
        </div>
      </StatusPage>
    );
  }
  if (state.status === "error") {
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
  }
  if (state.status === "login") {
    return <LoginScreen onSuccess={() => dispatch({ type: "loginSuccess" })} />;
  }
  return (
    <AuthContext.Provider
      value={{ authRequired: state.authRequired, logout: doLogout }}
    >
      {children}
    </AuthContext.Provider>
  );
};

const errorMessages: Record<
  Exclude<LoginResult, "ok" | "rate_limited">,
  string
> = {
  invalid_password: "Wrong password. Try again.",
  error: "Couldn't log in. Check your connection and try again.",
};

/** "0:42" */
export function formatCountdown(totalSec: number): string {
  const sec = Math.max(0, Math.ceil(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Seconds left until `until` (ms), ticking once a second; 0 once it has passed. */
function useCountdown(until: number | null): number {
  const remaining = () =>
    until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const [left, setLeft] = useState(remaining);
  useEffect(() => {
    setLeft(remaining());
    if (until === null) {
      return;
    }
    const timer = window.setInterval(() => {
      const next = remaining();
      setLeft(next);
      if (next <= 0) {
        window.clearInterval(timer);
      }
    }, 1000);
    return () => window.clearInterval(timer);
    // remaining only depends on until
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return left;
}

/** The instance password form: inline errors with a shake, and a countdown after too many attempts (429). */
export const LoginScreen = ({ onSuccess }: { onSuccess: () => void }) => {
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
      </form>
    </StatusPage>
  );
};
