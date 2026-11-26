import React, { useEffect, useState } from "react";
import { Button, Loader, PasswordInput } from "@mantine/core";
import {
  IconAlertTriangle,
  IconClock,
  IconDoorExit,
  IconLock,
  IconMapQuestion,
} from "@tabler/icons-react";
import {
  fetchRoomInfo,
  joinRoom,
  type JoinResult,
  type RoomAccessLossReason,
  type RoomInfo,
} from "../../utils/auth";
import { roomDisplayName } from "../../utils/rooms";
import { StatusPage, statusStyles } from "../StatusPage/StatusPage";
import { formatCountdown, useCountdown } from "./countdown";
import styles from "./AuthGate.module.css";

const lostMessages: Record<RoomAccessLossReason, string> = {
  kicked: "You were removed from this room.",
  passwordChanged: "The room password changed. Ask for the new one.",
  expired: "Your access to this room ended. Enter the room password again.",
};

const joinErrors: Partial<Record<JoinResult, string>> = {
  invalid_password: "Wrong password. Try again.",
  error: "Couldn't join. Check your connection and try again.",
};

type Phase = "checking" | "form" | "kicked" | "notFound" | "error";

/**
 * The room password screen for people with a room link but no access yet (guests). Shows only the room's name. Joins
 * on its own when the room has no password, or with the password from a "#pw=" link.
 */
export const RoomJoinScreen = ({
  roomId,
  lost,
  linkPassword,
  onJoined,
  onOwnerLogin,
}: {
  roomId: string;
  /** Why this browser lost access (kicked, password changed), if it just did */
  lost: RoomAccessLossReason | null;
  /** From a "#pw=" link (already removed from the address bar) */
  linkPassword?: string;
  onJoined: () => void;
  /** "Owner? Log in": switch to the instance login */
  onOwnerLogin: () => void;
}) => {
  const [phase, setPhase] = useState<Phase>(
    lost === "kicked" ? "kicked" : "checking",
  );
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const secondsLeft = useCountdown(lockedUntil);
  const locked = secondsLeft > 0;

  /** Applies a join result; true when joined */
  const handleResult = (
    result: JoinResult,
    retryAfterSec: number | undefined,
    errorText?: string,
  ) => {
    switch (result) {
      case "ok":
        onJoined();
        return true;
      case "kicked":
        setPhase("kicked");
        return false;
      case "not_found":
        setPhase("notFound");
        return false;
      case "rate_limited":
        setPhase("form");
        setLockedUntil(Date.now() + (retryAfterSec ?? 60) * 1000);
        return false;
      default:
        setPhase("form");
        setError(errorText ?? joinErrors[result] ?? joinErrors.error!);
        setShakeKey((k) => k + 1);
        return false;
    }
  };

  useEffect(() => {
    if (phase === "kicked") {
      return;
    }
    let cancelled = false;
    (async () => {
      let roomInfo: RoomInfo | null;
      try {
        roomInfo = await fetchRoomInfo(roomId);
      } catch {
        if (!cancelled) {
          setPhase("error");
        }
        return;
      }
      if (cancelled) {
        return;
      }
      if (!roomInfo) {
        setPhase("notFound");
        return;
      }
      setInfo(roomInfo);
      const usePassword = roomInfo.passwordRequired ? linkPassword : undefined;
      if (roomInfo.passwordRequired && usePassword === undefined) {
        setPhase("form");
        return;
      }
      // No password needed, or one came with the link
      const { result, retryAfterSec } = await joinRoom(roomId, usePassword);
      if (!cancelled) {
        handleResult(
          result,
          retryAfterSec,
          result === "invalid_password"
            ? "The password in your link didn't work. Type the room password instead."
            : undefined,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once per room (and on Retry); handleResult only uses state setters and onJoined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, retryKey]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || submitting || locked) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const { result, retryAfterSec } = await joinRoom(roomId, password);
    setSubmitting(false);
    handleResult(result, retryAfterSec);
  };

  const ownerLink = (
    <button type="button" className={styles.linkButton} onClick={onOwnerLogin}>
      Owner? Log in
    </button>
  );

  if (phase === "checking") {
    return (
      <StatusPage>
        <div className={statusStyles.center} role="status">
          <Loader size="sm" />
          Opening the room…
        </div>
      </StatusPage>
    );
  }
  if (phase === "kicked") {
    return (
      <StatusPage
        icon={<IconDoorExit size={22} />}
        title="You were removed from this room"
        actions={ownerLink}
      >
        <p className={statusStyles.text}>
          Ask the owner if you think this was a mistake.
        </p>
      </StatusPage>
    );
  }
  if (phase === "notFound") {
    return (
      <StatusPage
        icon={<IconMapQuestion size={22} />}
        title="Room not found"
        actions={ownerLink}
      >
        <p className={statusStyles.text}>
          Check the link. Room links look like{" "}
          <code>/watch/brave-otter-sings</code>.
        </p>
      </StatusPage>
    );
  }
  if (phase === "error") {
    return (
      <StatusPage
        icon={<IconAlertTriangle size={22} color="var(--wp-danger)" />}
        title="Couldn't reach the server"
        actions={
          <Button
            onClick={() => {
              setPhase("checking");
              setRetryKey((k) => k + 1);
            }}
          >
            Retry
          </Button>
        }
      >
        <p className={statusStyles.text}>
          Check your connection and try again.
        </p>
      </StatusPage>
    );
  }

  return (
    <StatusPage glow brand>
      <h1 className={statusStyles.title}>
        Join {roomDisplayName(roomId, info?.title)}
      </h1>
      <p className={statusStyles.text}>
        {lost ? lostMessages[lost] : "Enter the room password to join."}
      </p>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div
          key={shakeKey}
          className={shakeKey ? statusStyles.shake : undefined}
        >
          <PasswordInput
            label="Room password"
            placeholder="e.g. otter-maple-42"
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
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
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
          Join room
        </Button>
        <div className={styles.switchRow}>{ownerLink}</div>
      </form>
    </StatusPage>
  );
};
