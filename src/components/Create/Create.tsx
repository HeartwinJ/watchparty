import { useEffect, useRef, useState } from "react";
import { Button, Loader } from "@mantine/core";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { navigate } from "../../router";
import { createRoom } from "../../utils/rooms";
import { StatusPage, statusStyles } from "../StatusPage/StatusPage";

/** /create?video=URL: makes a room (optionally preloading a video) and replaces this page with it. */
export const Create = () => {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);

  useEffect(() => {
    // Guard against StrictMode's double effect creating two rooms
    if (started.current === attempt) {
      return;
    }
    started.current = attempt;
    const video =
      new URLSearchParams(window.location.search).get("video") ?? undefined;
    createRoom({ video, replace: true }).catch((e) => {
      console.error(e);
      setFailed(true);
    });
  }, [attempt]);

  if (failed) {
    return (
      <StatusPage
        icon={<IconAlertTriangle size={22} color="var(--wp-danger)" />}
        title="Couldn't create a room"
        actions={
          <>
            <Button
              leftSection={<IconRefresh size={16} />}
              onClick={() => {
                setFailed(false);
                setAttempt((a) => a + 1);
              }}
            >
              Try again
            </Button>
            <Button variant="default" onClick={() => navigate("/")}>
              Go home
            </Button>
          </>
        }
      >
        <p className={statusStyles.text}>
          The server didn't respond. Check your connection and try again.
        </p>
      </StatusPage>
    );
  }
  return (
    <StatusPage>
      <div className={statusStyles.center} role="status">
        <Loader size="sm" />
        Creating your room…
      </div>
    </StatusPage>
  );
};
