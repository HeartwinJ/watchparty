import React, { useRef } from "react";
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconBadgeCc,
  IconBadgeCcFilled,
  IconPictureInPicture,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRepeat,
  IconRewindBackward10,
  IconRewindForward10,
  IconVolume,
  IconVolume2,
  IconVolumeOff,
  IconCheck,
} from "@tabler/icons-react";
import { formatTimestamp } from "../../../utils/utils";
import type { Room } from "../hooks/useRoom";
import { SeekBar } from "./SeekBar";
import { PlayerMenu } from "./PlayerMenu";
import { SubtitlesMenu } from "./SubtitlesMenu";
import { SyncIndicator } from "./SyncIndicator";
import type { PlaybackState } from "./usePlaybackState";
import type { SubtitleStyle } from "./useSubtitleStyle";
import type { useTextTracks } from "./useTextTracks";
import styles from "./Player.module.css";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export type MenuName = "subtitles" | "speed";

/** The overlay control bar: seek bar, then play/±10 s/volume/time … sync/CC/speed/loop/PiP/fullscreen. */
export function ControlBar(props: {
  room: Room;
  playback: PlaybackState;
  menu: MenuName | null;
  setMenu: (menu: MenuName | null) => void;
  container: HTMLElement | null;
  fullscreen: boolean;
  phone: boolean;
  showMiniSync: boolean;
  tracks: ReturnType<typeof useTextTracks>;
  subtitleStyle: SubtitleStyle;
  setSubtitleStyle: (patch: Partial<SubtitleStyle>) => void;
  onTogglePlay: () => void;
  onHoverChange: (hovering: boolean) => void;
}) {
  const { room, playback, menu, setMenu, fullscreen, phone } = props;
  const { state, player, cmd } = room;
  const ccRef = useRef<HTMLButtonElement>(null);
  const speedRef = useRef<HTMLButtonElement>(null);
  const seekable = player.hasDuration() && !player.isWebRTCShare();
  const pauseDisabled = player.isPauseDisabled();
  const youtube = player.usingYoutube();
  const subtitlesOn = youtube
    ? player.youtube().isSubtitled()
    : props.tracks.selected >= 0;
  const roomRate = state.roomPlaybackRate || 1;
  const volume = playback.muted ? 0 : playback.volume;
  const canPip =
    !youtube &&
    typeof document !== "undefined" &&
    Boolean((document as any).pictureInPictureEnabled);
  const sheet = phone && !fullscreen;
  const VolumeIcon =
    volume === 0 ? IconVolumeOff : volume < 0.5 ? IconVolume2 : IconVolume;

  const toggleMenu = (name: MenuName) => setMenu(menu === name ? null : name);

  return (
    <div
      className={styles.controls}
      onPointerEnter={(e) =>
        e.pointerType === "mouse" && props.onHoverChange(true)
      }
      onPointerLeave={(e) =>
        e.pointerType === "mouse" && props.onHoverChange(false)
      }
      // Clicks on the controls never reach the click-to-pause layer
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {seekable && (
        <SeekBar
          currentTime={playback.currentTime}
          duration={playback.duration}
          buffered={playback.buffered}
          onSeek={player.roomSeek}
        />
      )}
      <div className={styles.row} role="toolbar" aria-label="Player controls">
        <button
          className={styles.btn}
          aria-label={playback.paused ? "Play" : "Pause"}
          title={playback.paused ? "Play (k)" : "Pause (k)"}
          disabled={pauseDisabled}
          onClick={props.onTogglePlay}
        >
          {playback.paused ? (
            <IconPlayerPlayFilled size={22} />
          ) : (
            <IconPlayerPauseFilled size={22} />
          )}
        </button>
        {seekable && (
          <>
            <button
              className={`${styles.btn} ${styles.desktopOnly}`}
              aria-label="Back 10 seconds"
              title="Back 10 s (←)"
              onClick={() => player.roomSeekBy(-10)}
            >
              <IconRewindBackward10 size={22} />
            </button>
            <button
              className={`${styles.btn} ${styles.desktopOnly}`}
              aria-label="Forward 10 seconds"
              title="Forward 10 s (→)"
              onClick={() => player.roomSeekBy(10)}
            >
              <IconRewindForward10 size={22} />
            </button>
          </>
        )}
        <div className={`${styles.volume} ${styles.desktopOnly}`}>
          <button
            className={styles.btn}
            aria-label={volume === 0 ? "Unmute" : "Mute"}
            title="Mute (m)"
            onClick={() => player.localToggleMute()}
          >
            <VolumeIcon size={22} />
          </button>
          <input
            type="range"
            className={`${styles.range} ${styles.volumeSlider}`}
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label="Volume"
            aria-valuetext={`${Math.round(volume * 100)}%`}
            style={{ "--pct": `${volume * 100}%` } as React.CSSProperties}
            onChange={(e) => player.localSetVolume(Number(e.target.value))}
          />
        </div>
        {seekable ? (
          <span className={styles.time}>
            {formatTimestamp(playback.currentTime) || "0:00"}
            {!state.isLiveStream && (
              <span> / {formatTimestamp(playback.duration)}</span>
            )}
          </span>
        ) : null}
        {state.isLiveStream && <span className={styles.live}>LIVE</span>}
        <span className={styles.spacer} />
        {state.convertProgress !== undefined && (
          <span className={`${styles.convert} ${styles.desktopOnly}`}>
            {(state.convertProgress * 100).toFixed(1)}% converted
          </span>
        )}
        {props.showMiniSync && (
          <SyncIndicator
            room={room}
            variant="mini"
            portalTarget={fullscreen ? props.container : undefined}
          />
        )}
        <button
          ref={ccRef}
          className={styles.btn}
          aria-label="Subtitles and audio"
          title="Subtitles"
          aria-haspopup="dialog"
          aria-expanded={menu === "subtitles"}
          aria-controls="wp-menu-subtitles"
          aria-pressed={subtitlesOn}
          onClick={() => toggleMenu("subtitles")}
        >
          {subtitlesOn ? (
            <IconBadgeCcFilled size={22} />
          ) : (
            <IconBadgeCc size={22} />
          )}
        </button>
        <button
          ref={speedRef}
          className={`${styles.btn} ${styles.textBtn} ${styles.desktopOnly}`}
          aria-label={`Playback speed ${roomRate}×`}
          title="Speed (for everyone)"
          aria-haspopup="dialog"
          aria-expanded={menu === "speed"}
          aria-controls="wp-menu-speed"
          onClick={() => toggleMenu("speed")}
        >
          {roomRate}×
        </button>
        <button
          className={`${styles.btn} ${styles.desktopOnly}`}
          aria-label="Loop"
          title="Loop (for everyone)"
          aria-pressed={state.roomLoop}
          onClick={() => player.roomSetLoop(!state.roomLoop)}
        >
          <IconRepeat size={22} />
        </button>
        {canPip && (
          <button
            className={`${styles.btn} ${styles.desktopOnly}`}
            aria-label="Picture in picture"
            title="Picture in picture"
            onClick={async () => {
              try {
                if ((document as any).pictureInPictureElement) {
                  await (document as any).exitPictureInPicture();
                } else {
                  await (
                    player.html().getVideoEl() as HTMLVideoElement
                  ).requestPictureInPicture();
                }
              } catch (e) {
                console.warn(e);
              }
            }}
          >
            <IconPictureInPicture size={22} />
          </button>
        )}
        <button
          className={styles.btn}
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          title={fullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
          onClick={() => player.toggleFullscreen()}
        >
          {fullscreen ? (
            <IconArrowsMinimize size={22} />
          ) : (
            <IconArrowsMaximize size={22} />
          )}
        </button>
      </div>

      <PlayerMenu
        open={menu === "subtitles"}
        onClose={() => setMenu(null)}
        target={props.container}
        sheet={sheet}
        label="Subtitles and audio"
        id="wp-menu-subtitles"
        trigger={ccRef}
      >
        <SubtitlesMenu
          room={room}
          tracks={props.tracks}
          style={props.subtitleStyle}
          setStyle={props.setSubtitleStyle}
          onClose={() => setMenu(null)}
        />
      </PlayerMenu>
      <PlayerMenu
        open={menu === "speed"}
        onClose={() => setMenu(null)}
        target={props.container}
        sheet={sheet}
        label="Playback speed"
        id="wp-menu-speed"
        size="small"
        trigger={speedRef}
      >
        <div className={styles.menuSection}>
          <div className={styles.menuLabel}>Speed · for everyone</div>
          <div role="menu" aria-label="Playback speed">
            {SPEEDS.map((r) => (
              <button
                key={r}
                className={styles.menuItem}
                role="menuitemradio"
                aria-checked={roomRate === r}
                onClick={() => {
                  cmd.setPlaybackRate(r);
                  setMenu(null);
                }}
              >
                <IconCheck size={16} className={styles.check} />
                <span className={styles.grow}>
                  {r === 1 ? "Normal" : `${r}×`}
                </span>
              </button>
            ))}
          </div>
        </div>
      </PlayerMenu>
    </div>
  );
}
