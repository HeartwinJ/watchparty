import { Alert, Button, Loader, Overlay } from "@mantine/core";
import { IconVolume } from "@tabler/icons-react";
import { VIDEO_MAX_HEIGHT_CSS, softWhite } from "../../utils/utils";
import { Controls } from "../Controls/Controls";
import type { Room } from "./hooks/useRoom";
import { VIDEO_ELEMENT_ID, YOUTUBE_ELEMENT_ID } from "./hooks/usePlayer";
import styles from "./App.module.css";

/** The YouTube iframe and <video> element, with the loading/unmute overlays. */
export const PlayerArea = ({ room }: { room: Room }) => {
  const { state, store, player } = room;
  return (
    <div style={{ flexGrow: 1, position: "relative" }}>
      <div className={styles.playerContainer}>
        {!state.isAutoPlayable && state.roomMedia && (
          <Overlay className={styles.flexCenter}>
            <Button
              onClick={() => {
                store.set({ isAutoPlayable: true });
                player.localSetMute(false);
                player.localSetVolume(1);
              }}
              leftSection={<IconVolume />}
              size="xl"
            >
              Unmute
            </Button>
          </Overlay>
        )}
        {(state.loading || !state.roomMedia || state.nonPlayableMedia) &&
          !state.isLiveStream && (
            <div
              id="loader"
              className={`${styles.videoContent} ${styles.flexCenter}`}
            >
              {state.loading && (
                <div
                  className={styles.flexCenter}
                  style={{ flexDirection: "column" }}
                >
                  <Loader />
                </div>
              )}
              {!state.loading && !state.roomMedia && (
                <Alert color="yellow" title="You're not watching anything!">
                  Pick something to watch above.
                </Alert>
              )}
              {!state.loading && state.nonPlayableMedia && (
                <Alert
                  color="red"
                  title="It doesn't look like this is a media file!"
                >
                  The link needs to point to a video file or stream, not a web
                  page.
                </Alert>
              )}
            </div>
          )}
        <iframe
          style={{
            display: player.usingYoutube() && !state.loading ? "block" : "none",
          }}
          title="YouTube"
          id={YOUTUBE_ELEMENT_ID}
          className={styles.videoContent}
          allowFullScreen
          frameBorder="0"
          allow="autoplay; encrypted-media"
          src="https://www.youtube.com/embed/?enablejsapi=1&controls=0&rel=0"
        />
        <video
          style={{
            display:
              (player.usingNative() && !state.loading) || state.fullScreen
                ? "block"
                : "none",
            width: "100%",
            maxHeight: VIDEO_MAX_HEIGHT_CSS,
          }}
          id={VIDEO_ELEMENT_ID}
          onEnded={(e) => player.onVideoEnded(e.currentTarget.src)}
          playsInline
          onClick={player.roomTogglePlay}
        ></video>
        <div
          style={{
            color: softWhite,
            fontWeight: 400,
            fontSize: 10,
            lineHeight: "8px",
            position: "absolute",
            bottom: 0,
            right: 0,
            zIndex: 1,
          }}
        >
          {state.convertProgress !== undefined &&
            (state.convertProgress * 100).toFixed(1) + "% converted"}
        </div>
      </div>
    </div>
  );
};

/** The playback controls bar (remounted via controlsTimestamp so it re-reads the player). */
export const PlayerControls = ({ room }: { room: Room }) => {
  const { state, player, playlist, convert, subtitles } = room;
  const current = player.current();
  return (
    <Controls
      key={state.controlsTimestamp}
      video={state.roomMedia}
      paused={state.roomPaused}
      roomPlaybackRate={state.roomPlaybackRate}
      isLiveStream={state.isLiveStream}
      muted={current.isMuted()}
      volume={current.getVolume()}
      subtitled={current.isSubtitled()}
      currentTime={current.getCurrentTime()}
      duration={player.getDuration()}
      leaderTime={player.hasDuration() ? player.getLeaderTime() : undefined}
      isPauseDisabled={player.isPauseDisabled()}
      playbackRate={current.getPlaybackRate()}
      isYouTube={player.usingYoutube()}
      timeRanges={current.getTimeRanges()}
      loop={state.roomLoop}
      roomSetLoop={player.roomSetLoop}
      roomTogglePlay={player.roomTogglePlay}
      roomSeek={player.roomSeek}
      roomSetPlaybackRate={player.roomSetPlaybackRate}
      localFullScreen={player.localFullScreen}
      localToggleMute={player.localToggleMute}
      localSubtitleModal={subtitles.openModal}
      localSetVolume={player.localSetVolume}
      localSeek={() => player.localSeek()}
      localSetSubtitleMode={current.setSubtitleMode}
      roomPlaylistPlay={playlist.play}
      playlist={state.playlist}
      audioTracks={state.audioTracks}
      audioTrackId={state.audioTrackId}
      localSetAudioTrack={convert.setAudioTrack}
    />
  );
};
