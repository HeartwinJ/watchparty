import { Loader, Popover } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import type { Room } from "../hooks/useRoom";
import {
  describePeerSync,
  getLeaderTime,
  type SyncStatus,
} from "../logic/sync";
import styles from "./SyncIndicator.module.css";

type Tone = "success" | "warning" | "danger";

/** Label, tone and whether to show a spinner for a sync status */
export function describeSyncStatus(status: SyncStatus): {
  label: string;
  short: string;
  tone: Tone;
  busy: boolean;
} {
  switch (status.kind) {
    case "catching-up": {
      const secs = Math.abs(status.behind).toFixed(1);
      const where = status.behind >= 0 ? "behind" : "ahead";
      return {
        label: `Catching up · ${secs} s ${where}`,
        short: `${secs} s ${where}`,
        tone: "warning",
        busy: false,
      };
    }
    case "buffering":
      return {
        label: "Buffering…",
        short: "Buffering…",
        tone: "warning",
        busy: true,
      };
    case "reconnecting":
      return {
        label: "Reconnecting…",
        short: "Reconnecting…",
        tone: "danger",
        busy: false,
      };
    default:
      return {
        label: "In sync",
        short: "In sync",
        tone: "success",
        busy: false,
      };
  }
}

const AVATAR_VARS = [
  "var(--wp-avatar-1)",
  "var(--wp-avatar-2)",
  "var(--wp-avatar-3)",
  "var(--wp-avatar-4)",
];
const avatarColor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return AVATAR_VARS[Math.abs(h) % AVATAR_VARS.length];
};

/**
 * Sync pill (coloured dot + state) with a popover listing each person's position relative to the room, plus "Resync
 * me to the room". Put it in the top bar; the player shows a compact one (`variant="mini"`) in its control bar in
 * fullscreen or with the sidebar collapsed. Renders nothing when nothing is playing.
 */
export function SyncIndicator({
  room,
  variant = "pill",
  portalTarget,
}: {
  room: Room;
  variant?: "pill" | "mini";
  /** Portal the popover here (the player container, so it shows in fullscreen) */
  portalTarget?: HTMLElement | null;
}) {
  const { state, clientId, player } = room;
  if (!state.roomMedia) {
    return null;
  }
  const status = state.syncStatus;
  const d = describeSyncStatus(status);
  const nudgeRate = player.current().getPlaybackRate();
  const showRate =
    variant === "mini" &&
    status.kind === "catching-up" &&
    Math.abs(nudgeRate - (state.roomPlaybackRate || 1)) > 0.001;
  const leader = getLeaderTime(state.participants.length, state.tsMap);
  const comparable =
    !state.isLiveStream && player.hasDuration() && Number.isFinite(leader);

  const people = state.participants.map((p) => {
    const me = p.id === clientId;
    let tone: Tone;
    let label: string;
    if (me) {
      tone = d.tone;
      label = d.label;
    } else if (!comparable) {
      tone = "success";
      label = "Watching";
    } else {
      const peer = describePeerSync(leader - state.tsMap[p.id]);
      tone = peer.tone;
      label = peer.label;
    }
    return {
      id: p.id,
      me,
      name: state.nameMap[p.id] || "Someone",
      tone,
      label,
    };
  });

  return (
    <Popover
      position="bottom-end"
      offset={8}
      shadow="md"
      withinPortal
      portalProps={portalTarget ? { target: portalTarget } : undefined}
      zIndex={600}
      trapFocus
      returnFocus
    >
      <Popover.Target>
        <button
          type="button"
          className={`${styles.pill} ${variant === "mini" ? styles.mini : ""}`}
          aria-label={`Playback sync: ${d.label}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {d.busy ? (
            <Loader size={12} color="var(--wp-warning)" />
          ) : (
            <span className={styles.dot} data-tone={d.tone} />
          )}
          <span className={styles.label}>
            {variant === "mini" ? d.short : d.label}
          </span>
          {showRate && (
            <span className={styles.rate}>{nudgeRate.toFixed(2)}×</span>
          )}
        </button>
      </Popover.Target>
      <Popover.Dropdown
        className={styles.dropdown}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.title}>Playback sync</div>
        {people.map((p) => (
          <div key={p.id} className={styles.person}>
            <span
              className={styles.avatar}
              style={{ background: avatarColor(p.id) }}
              aria-hidden="true"
            >
              {p.name.slice(0, 1).toUpperCase()}
            </span>
            <div className={styles.info}>
              <div className={styles.name}>
                {p.name} {p.me && <small>(you)</small>}
              </div>
              <div className={styles.state}>
                <span className={styles.dot} data-tone={p.tone} />
                {p.label}
              </div>
            </div>
          </div>
        ))}
        <div className={styles.sep} />
        <button
          type="button"
          className={styles.action}
          onClick={() => player.resync()}
        >
          <IconRefresh size={16} />
          Resync me to the room
        </button>
        <div className={styles.note}>
          Drift under 2 s is fixed by nudging speed (0.95–1.05×). Larger gaps
          seek.
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
