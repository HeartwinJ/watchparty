import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useState,
} from "react";
import {
  Alert,
  Button,
  Center,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Title,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { onUnauthorized } from "../../utils/api";
import {
  authReducer,
  fetchSession,
  initialAuthState,
  login,
  logout,
  type LoginResult,
} from "../../utils/auth";

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
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (state.status === "error") {
    return (
      <Center h="100vh">
        <Stack align="center">
          <Alert color="red" title="Couldn't reach the server">
            Check your connection and try again.
          </Alert>
          <Button onClick={() => dispatch({ type: "retry" })}>Retry</Button>
        </Stack>
      </Center>
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

const errorMessages: Record<Exclude<LoginResult, "ok">, string> = {
  invalid_password: "Wrong password.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  error: "Couldn't log in. Check your connection and try again.",
};

export const LoginScreen = ({ onSuccess }: { onSuccess: () => void }) => {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await login(password);
    setSubmitting(false);
    if (result === "ok") {
      onSuccess();
    } else {
      setError(errorMessages[result]);
    }
  };

  return (
    <Center h="100vh" px="md">
      <Paper withBorder p="xl" radius="md" w="100%" maw={360}>
        <form onSubmit={onSubmit}>
          <Stack>
            <Title order={2} ta="center">
              WatchParty
            </Title>
            <PasswordInput
              label="Password"
              leftSection={<IconLock size={16} />}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              error={error}
              autoFocus
              autoComplete="current-password"
            />
            <Button type="submit" loading={submitting} disabled={!password}>
              Log in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
};
