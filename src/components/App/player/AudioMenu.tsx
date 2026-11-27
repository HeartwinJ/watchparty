import { IconCheck } from "@tabler/icons-react";
import type { Room } from "../hooks/useRoom";
import { AudioBoostSection } from "./AudioBoostSection";
import styles from "./Player.module.css";

/** Whether the Audio menu has anything to offer: several audio tracks (converter), or the volume boost (not YouTube) */
export function hasAudioMenu(room: Room) {
  return (
    !room.player.usingYoutube() || (room.state.audioTracks?.length ?? 0) > 1
  );
}

/**
 * The Audio menu (headphones button in the control bar): the audio track when the converter found several, then
 * volume boost / Night mode for this device.
 */
export function AudioMenu({ room }: { room: Room }) {
  const { state, player } = room;
  return (
    <>
      {state.audioTracks && state.audioTracks.length > 1 && (
        <div className={styles.menuSection}>
          <div className={styles.menuLabel}>Audio track</div>
          <div role="menu" aria-label="Audio tracks">
            {state.audioTracks.map((t) => (
              <button
                key={t.id}
                className={styles.menuItem}
                role="menuitemradio"
                aria-checked={state.audioTrackId === t.id}
                onClick={() => room.convert.setAudioTrack(t.id)}
              >
                <IconCheck size={16} className={styles.check} />
                <span className={styles.grow}>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!player.usingYoutube() && <AudioBoostSection room={room} />}
    </>
  );
}
