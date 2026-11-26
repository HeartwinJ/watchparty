import { useEffect, useState } from "react";
import { IconPlayerSkipBack } from "@tabler/icons-react";
import type { Room } from "../hooks/useRoom";
import {
  formatSkipIntro,
  INTRO_SKIP_NOTICE_MS,
  showIntroSkipNotice,
} from "../logic/introSkip";
import styles from "./IntroSkipNotice.module.css";

/**
 * "Skipped intro (1:30) · Watch from start": shown to everyone for a few seconds when the room started a video past
 * its intro (REC:introSkip). Render it inside PlayerArea so it lives in the fullscreen element. The button is a normal
 * room seek to 0 (everyone follows, and it shows as a seek in chat).
 */
export function IntroSkipNotice({ room }: { room: Room }) {
  const { introSkip, isLiveStream } = room.state;
  const [, setTick] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  // Re-render once the notice has been up long enough, so it goes away on its own
  useEffect(() => {
    if (!introSkip) {
      return;
    }
    const left = INTRO_SKIP_NOTICE_MS - (Date.now() - introSkip.at);
    const id = window.setTimeout(
      () => setTick((n) => n + 1),
      Math.max(0, left) + 50,
    );
    return () => window.clearTimeout(id);
  }, [introSkip]);
  if (
    !introSkip ||
    dismissedAt === introSkip.at ||
    !showIntroSkipNotice({ info: introSkip, isLiveStream, now: Date.now() })
  ) {
    return null;
  }
  return (
    <IntroSkipNoticeView
      seconds={introSkip.seconds}
      onWatchFromStart={() => {
        setDismissedAt(introSkip.at);
        room.player.roomSeek(0);
      }}
    />
  );
}

/** The notice itself (testable without a room) */
export function IntroSkipNoticeView(props: {
  seconds: number;
  onWatchFromStart: () => void;
}) {
  return (
    <div
      className={styles.notice}
      role="status"
      // Clicks here shouldn't reach the player's tap/click handling
      onPointerUp={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className={styles.text}>
        Skipped intro ({formatSkipIntro(props.seconds)})
      </span>
      <span className={styles.dot} aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        className={styles.action}
        onClick={props.onWatchFromStart}
      >
        <IconPlayerSkipBack size={14} aria-hidden="true" />
        Watch from start
      </button>
    </div>
  );
}
