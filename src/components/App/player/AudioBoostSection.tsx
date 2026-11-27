import { BOOST_LEVELS, type BoostStatus } from "../audioBoost";
import type { Room } from "../hooks/useRoom";
import styles from "./Player.module.css";

const NOTES: Partial<Record<BoostStatus, string>> = {
  pending: "Starts with your next click or key press.",
  unavailable: "Not available for this video: its server doesn't allow it.",
};

/** Volume boost and Night mode in the Audio menu (per device; <video> only). See audioBoost.ts. */
export function AudioBoostSection({ room }: { room: Room }) {
  const { state, player } = room;
  const { level, night } = state.audioBoost;
  const note = NOTES[state.audioBoostStatus];
  return (
    <div className={styles.menuSection}>
      <div className={styles.menuLabel}>Volume · just you</div>
      <div className={styles.styleGrid}>
        <span id="wp-boost">Boost</span>
        <div className={styles.seg} role="group" aria-labelledby="wp-boost">
          {BOOST_LEVELS.map((v) => (
            <button
              key={v}
              aria-pressed={level === v}
              onClick={() => player.setAudioBoost({ level: v })}
            >
              {v === 1 ? "Off" : `${v * 100}%`}
            </button>
          ))}
        </div>
        <span
          id="wp-night"
          title="Evens out the volume: louder speech, quieter explosions"
        >
          Night mode
        </span>
        <div className={styles.seg} role="group" aria-labelledby="wp-night">
          {[false, true].map((v) => (
            <button
              key={String(v)}
              aria-pressed={night === v}
              onClick={() => player.setAudioBoost({ night: v })}
            >
              {v ? "On" : "Off"}
            </button>
          ))}
        </div>
      </div>
      {note && (
        <div className={styles.scopeNote} role="status">
          {note}
        </div>
      )}
    </div>
  );
}
