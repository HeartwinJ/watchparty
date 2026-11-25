import { useEffect, useMemo, useRef } from "react";
import { isMobile, testAutoplay } from "../../../utils/utils";
import { HTML } from "../HTML";
import { YouTube } from "../YouTube";
import type { Player } from "../Player";
import type { RoomStore } from "../roomState";
import type { RoomCommands } from "../socketEvents";
import type { ShareSession } from "./useShare";
import { hasDuration, isWebRTCShare, usesYouTube } from "../logic/media";
import { isScreenShare } from "../../../utils/utils";
import {
  getCatchUpPlaybackRate,
  getEffectiveDuration,
  getLeaderTime,
  getLocalSeekTarget,
  shouldAutoSyncRate,
  toRoomTime,
} from "../logic/sync";
import { decideOnVideoEnded } from "../logic/playlist";

/** id of the <video> element used for everything except YouTube */
export const VIDEO_ELEMENT_ID = "leftVideo";
/** id of the YouTube iframe */
export const YOUTUBE_ELEMENT_ID = "leftYt";

/**
 * Wraps the two player implementations (HTML.ts for <video>, YouTube.ts for the iframe) and exposes playback actions.
 * "local*" functions only affect this device; "room*" functions also tell the room (CMD:*).
 */
export function usePlayer(opts: {
  store: RoomStore;
  cmd: RoomCommands;
  clientId: string;
  /** Screen/file share state, needed to decide whether to mute (see useShare) */
  share: ShareSession;
  /** Starts the 1s CMD:ts reporting loop once the socket exists */
  connected: boolean;
}) {
  const { store, cmd, clientId, share } = opts;
  const youtubeRef = useRef(new YouTube(null));
  const htmlRef = useRef(new HTML(VIDEO_ELEMENT_ID));
  const ytDebounce = useRef(true);

  const api = useMemo(() => {
    const current = (): Player =>
      usesYouTube(store.get().roomMedia) ? youtubeRef.current : htmlRef.current;
    const usingYoutube = () => usesYouTube(store.get().roomMedia);
    const usingNative = () => !usingYoutube();
    const roomHasDuration = () => hasDuration(store.get().roomMedia);
    const isPauseDisabled = () => isScreenShare(store.get().roomMedia);
    const refreshControls = () => store.set({ controlsTimestamp: Date.now() });

    const getDuration = () =>
      getEffectiveDuration(
        current().getDuration(),
        store.get().isLiveStream,
        current().getVideoEl()?.seekable,
      );
    const leaderTime = () => {
      const { participants, tsMap } = store.get();
      return getLeaderTime(participants.length, tsMap);
    };
    const roomTime = (time: number) =>
      toRoomTime(time, store.get().isLiveStream, getDuration());

    const localSeek = (roomTimeToSeek?: number) => {
      // Jump to the leader's position, or a custom one
      const target = getLocalSeekTarget({
        roomTime: roomTimeToSeek,
        leaderTime: leaderTime(),
        isLiveStream: store.get().isLiveStream,
        duration: getDuration(),
      });
      if (target !== undefined) {
        console.log("syncing self to leader or custom:", target);
        current().seekVideo(target);
      }
    };

    const localSetMute = (muted: boolean) => {
      current().setMute(muted);
      refreshControls();
    };

    const localSetVolume = (volume: number) => {
      current().setVolume(volume);
      refreshControls();
    };

    const localToggleMute = () => localSetMute(!current().isMuted());

    const localPlay = async () => {
      if (!store.get().roomMedia) {
        return;
      }
      const canAutoplay = store.get().isAutoPlayable || (await testAutoplay());
      store.set({ roomPaused: false, isAutoPlayable: canAutoplay });
      if (!store.get().isAutoPlayable || (share.localStream && !share.isFile)) {
        console.log("auto-muting to allow autoplay or screenshare host");
        localSetMute(true);
      } else {
        localSetMute(false);
      }
      try {
        await current().playVideo();
      } catch (e: any) {
        console.warn(e, e.name);
        if (e.name === "NotSupportedError" && usingNative()) {
          store.set({ loading: false, nonPlayableMedia: true });
        }
      }
    };

    const localPause = () => {
      store.set({ roomPaused: true });
      current().pauseVideo();
    };

    const localFullScreen = async (videoOnly: boolean) => {
      // Default: fullscreen the body (theater mode)
      let container = document.body as HTMLElement;
      if (videoOnly || isMobile()) {
        // fullscreen just the video
        container = current().getVideoEl();
      }
      if (
        !container.requestFullscreen &&
        //@ts-expect-error
        container.webkitEnterFullScreen
      ) {
        // e.g. iPhone doesn't allow requestFullscreen
        //@ts-expect-error
        container.webkitEnterFullscreen();
        return;
      }
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        // e.g. switching from video fullscreen to theater mode
        const changeElements = document.fullscreenElement !== container;
        await document.exitFullscreen();
        if (changeElements) {
          await container.requestFullscreen();
        }
      }
    };

    const roomTogglePlay = () => {
      if (isPauseDisabled()) {
        return;
      }
      if (current().shouldPlay()) {
        cmd.play();
        localPlay();
      } else {
        cmd.pause();
        localPause();
      }
    };

    const roomSeek = (time: number) => {
      const target = Math.max(time, 0);
      current().seekVideo(target);
      cmd.seek(roomTime(target));
    };

    const onVideoEnded = (endedUrl: string) => {
      const { loading, roomLoop, playlist, roomMedia } = store.get();
      const action = decideOnVideoEnded({
        loading,
        loop: roomLoop,
        playlistLength: playlist.length,
        roomMedia,
        endedUrl,
      });
      if (action.type === "ignore") {
        return;
      }
      localPause();
      if (action.type === "loop") {
        localSeek(0);
        localPlay();
      } else if (action.type === "playlistNext") {
        // Pass the url of the video at the time this video was started
        cmd.playlistNext(action.url);
      } else if (action.type === "setMedia") {
        // Play next fileIndex
        cmd.setMedia(action.url);
      }
    };

    /** Nudges the playback rate to catch up with the leader (called on every REC:tsMap) */
    const autoSyncRate = (tsMap: NumberDict) => {
      const s = store.get();
      if (
        shouldAutoSyncRate({
          roomPaused: s.roomPaused,
          isLiveStream: s.isLiveStream,
          hasDuration: roomHasDuration(),
          roomPlaybackRate: s.roomPlaybackRate,
        })
      ) {
        const rate = getCatchUpPlaybackRate(leaderTime(), tsMap[clientId]);
        if (current().getPlaybackRate() !== rate) {
          current().setPlaybackRate(rate);
        }
      }
    };

    // Loads the YouTube IFrame API, which creates the player in the iframe once ready
    const loadYouTube = () => {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.append(tag);
      window.onYouTubeIframeAPIReady = () => {
        // Note: this fails silently if the element is not available
        const ytPlayer = new window.YT.Player(YOUTUBE_ELEMENT_ID, {
          events: {
            onReady: () => {
              console.log("yt onReady");
              youtubeRef.current = new YouTube(ytPlayer);
              store.set({ loading: false });
              // We might have failed to play YT originally, ask for the current video again
              if (usingYoutube()) {
                console.log("requesting host data again after ytReady");
                cmd.askHost();
              }
            },
            onStateChange: (e) => {
              const states = window.YT?.PlayerState;
              if (usingYoutube() && e.data === states?.CUED) {
                store.set({ loading: false });
              }
              if (usingYoutube() && e.data === states?.ENDED) {
                console.log(e.data, e.target.getVideoUrl());
                onVideoEnded(e.target.getVideoUrl());
              }
              const paused = store.get().roomPaused;
              // Play/pause from the YouTube UI (e.g. clicking the iframe) is sent to the room
              if (
                ytDebounce.current &&
                ((e.data === states?.PLAYING && paused) ||
                  (e.data === states?.PAUSED && !paused))
              ) {
                ytDebounce.current = false;
                if (e.data === states?.PLAYING) {
                  cmd.play();
                  localPlay();
                } else {
                  cmd.pause();
                  localPause();
                }
                window.setTimeout(() => (ytDebounce.current = true), 500);
              }
            },
          },
        });
      };
    };

    const onKeydown = (e: KeyboardEvent) => {
      if (
        !document.activeElement ||
        document.activeElement.tagName === "BODY"
      ) {
        if (e.key === " ") {
          e.preventDefault();
          roomTogglePlay();
        } else if (e.key === "ArrowRight") {
          roomSeek(current().getCurrentTime() + 10);
        } else if (e.key === "ArrowLeft") {
          roomSeek(current().getCurrentTime() - 10);
        } else if (e.key === "t") {
          localFullScreen(false);
        } else if (e.key === "f") {
          localFullScreen(true);
        } else if (e.key === "m") {
          localToggleMute();
        }
      }
    };

    return {
      /** The active player implementation for the room's media */
      current,
      html: () => htmlRef.current,
      youtube: () => youtubeRef.current,
      usingYoutube,
      usingNative,
      hasDuration: roomHasDuration,
      isPauseDisabled,
      isWebRTCShare: () => isWebRTCShare(store.get().roomMedia),
      getDuration,
      getLeaderTime: leaderTime,
      toRoomTime: roomTime,
      refreshControls,
      localSeek,
      localPlay,
      localPause,
      localSetMute,
      localSetVolume,
      localToggleMute,
      localFullScreen,
      roomTogglePlay,
      roomSeek,
      roomSetPlaybackRate: (rate: number) => cmd.setPlaybackRate(rate),
      roomSetLoop: (loop: boolean) => cmd.setLoop(loop),
      onVideoEnded,
      autoSyncRate,
      loadYouTube,
      onKeydown,
    };
  }, [store, cmd, clientId, share]);

  // Keyboard shortcuts
  useEffect(() => {
    document.onkeydown = api.onKeydown;
    return () => {
      document.onkeydown = null;
    };
  }, [api]);

  // Report our position to the room every second
  useEffect(() => {
    if (!opts.connected) {
      return;
    }
    const id = window.setInterval(() => {
      if (store.get().roomMedia) {
        cmd.reportTime(api.toRoomTime(api.current().getCurrentTime()));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [opts.connected, api, store, cmd]);

  return api;
}

export type PlayerApi = ReturnType<typeof usePlayer>;
