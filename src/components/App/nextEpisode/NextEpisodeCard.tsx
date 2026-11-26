import { useEffect, useRef, useState } from "react";
import { Button } from "@mantine/core";
import { IconPlayerPlayFilled } from "@tabler/icons-react";
import type { Room } from "../hooks/useRoom";
import { countdownSeconds, describeNext, nextEpisodeOffset } from "./logic";
import { useNextEpisode } from "./useNextEpisode";
import styles from "./NextEpisode.module.css";

/**
 * The room-wide "Up next" card over the player (bottom-right, also in fullscreen). Render it inside PlayerArea so it
 * lives in the fullscreen element. Play now / Cancel act for the whole room (server-authoritative).
 */
export function NextEpisodeCard({ room }: { room: Room }) {
  const { offered, playNow, cancel } = useNextEpisode(room);
  if (!offered) {
    return null;
  }
  return (
    <NextEpisodeView
      next={offered.next}
      startAt={offered.startAt}
      window={nextEpisodeOffset(room.state)}
      getTime={() => room.player.current().getCurrentTime()}
      onPlayNow={playNow}
      onCancel={cancel}
    />
  );
}

/** The card itself (testable without a room) */
export function NextEpisodeView(props: {
  next: NextEpisodeInfo;
  /** Video seconds at which it starts (the video's end) */
  startAt: number;
  /** Length of the countdown window, for the progress bar */
  window: number;
  getTime: () => number;
  onPlayNow: () => void;
  onCancel: () => void;
}) {
  const { next, startAt, getTime } = props;
  const [time, setTime] = useState(getTime);
  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;
  // Follows this device's player, so pausing the room pauses the countdown
  useEffect(() => {
    const id = window.setInterval(() => setTime(getTimeRef.current()), 250);
    return () => window.clearInterval(id);
  }, []);
  const left = countdownSeconds(startAt, time);
  const info = describeNext(next);
  const fraction = Math.min(1, Math.max(0, (startAt - time) / props.window));
  return (
    <section
      className={styles.card}
      aria-label="Up next"
      // Clicks on the card shouldn't reach the player's tap/click handling
      onPointerUp={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {info.image && (
        <img className={styles.thumb} src={info.image} alt="" loading="lazy" />
      )}
      <div className={styles.body}>
        <div className={styles.heading} role="status">
          {info.heading}
        </div>
        <div className={styles.show}>{info.show}</div>
        <div className={styles.countdown}>
          {left > 0 ? `Starts in ${left} s` : "Starting…"}
        </div>
        <div className={styles.actions}>
          <Button
            size="compact-sm"
            leftSection={<IconPlayerPlayFilled size={14} />}
            onClick={props.onPlayNow}
          >
            Play now
          </Button>
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>
      <div
        className={styles.progress}
        style={{ transform: `scaleX(${fraction})` }}
        aria-hidden="true"
      />
    </section>
  );
}
