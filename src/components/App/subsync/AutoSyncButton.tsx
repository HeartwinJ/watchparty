import { useEffect } from "react";
import { IconWand } from "@tabler/icons-react";
import type { Room } from "../hooks/useRoom";
import { syncProgressLabel } from "./logic";
import menu from "../player/Player.module.css";
import styles from "./AutoSync.module.css";

/**
 * "Auto-sync" in the subtitles menu's Timing offset section: aligns the selected track to the audio (useSubtitleSync)
 * and shows progress while it listens. Disabled with the reason underneath when it can't run here (YouTube, screen
 * share, live, no track, ...). Closing the menu cancels a manual sync. The last outcome stays underneath for a while.
 */
export function AutoSyncButton({
  room,
  hasTrack,
}: {
  room: Room;
  /** A subtitle track is selected */
  hasTrack: boolean;
}) {
  const { subsync, state } = room;
  const job = state.subtitleSyncJob;
  const remote = state.subtitleSyncRemote;
  const outcome = state.subtitleSyncOutcome;
  useEffect(() => () => subsync.cancel("manual"), [subsync]);

  const reason =
    subsync.unavailableReason() ??
    (hasTrack ? null : "Pick a subtitle track first");

  if (job) {
    return (
      <div className={styles.row} role="status" aria-live="polite">
        <IconWand size={16} className={styles.icon} />
        <span className={menu.grow}>
          {job.auto ? "Auto-syncing for the room" : "Auto-sync"}
          <small>{syncProgressLabel(job.progress)}</small>
          <span className={styles.track} aria-hidden="true">
            <span
              className={styles.bar}
              style={{ width: `${Math.round(job.progress * 100)}%` }}
            />
          </span>
        </span>
        {!job.auto && (
          <button
            className={menu.linkBtn}
            onClick={() => subsync.cancel("manual")}
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      className={`${menu.menuItem} ${reason ? styles.unavailable : ""}`}
      disabled={Boolean(reason)}
      title={reason ?? "Match the subtitles to the speech in the audio"}
      onClick={() => subsync.syncNow()}
    >
      <IconWand size={16} className={styles.icon} />
      <span className={menu.grow}>
        Auto-sync
        {!reason && !remote && outcome ? (
          // The last result (toasts don't show in fullscreen)
          <small className={styles[outcome.tone]} role="status">
            {outcome.text}
          </small>
        ) : (
          <small>
            {reason ??
              (remote
                ? `${remote.by} is syncing subtitles for the room…`
                : "Match the subtitles to the speech")}
          </small>
        )}
      </span>
    </button>
  );
}
