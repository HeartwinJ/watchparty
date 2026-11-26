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
  getEffectiveDuration,
  getLeaderTime,
  getLocalSeekTarget,
  getSyncStatus,
  initialDriftState,
  isSameSyncStatus,
  nextDriftAction,
  shouldAutoSyncRate,
  toRoomTime,
  type DriftState,
} from "../logic/sync";
import { decideOnVideoEnded } from "../logic/playlist";
import {
  nextDurationReport,
  type DurationReport,
} from "../logic/durationReport";

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
  /** The player container (video + controls + overlays) that goes fullscreen; set by the player view */
  const containerRef = useRef<HTMLElement | null>(null);
  const driftRef = useRef<DriftState>(initialDriftState());
  /** Last drift seen by the controller (leader minus us, seconds) */
  const driftValueRef = useRef(0);

  const api = useMemo(() => {
    const current = (): Player =>
      usesYouTube(store.get().roomMedia) ? youtubeRef.current : htmlRef.current;
    const usingYoutube = () => usesYouTube(store.get().roomMedia);
    const usingNative = () => !usingYoutube();
    const roomHasDuration = () => hasDuration(store.get().roomMedia);
    const isPauseDisabled = () => isScreenShare(store.get().roomMedia);

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
    };

    const localSetVolume = (volume: number) => {
      const v = Math.min(1, Math.max(0, volume));
      current().setVolume(v);
      if (v > 0 && current().isMuted()) {
        current().setMute(false);
      }
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

    const fullscreenElement = (): Element | null =>
      document.fullscreenElement ??
      // Safari < 16.4
      (document as any).webkitFullscreenElement ??
      null;

    /** Whether the player container is fullscreen */
    const isFullscreen = () =>
      Boolean(
        containerRef.current && fullscreenElement() === containerRef.current,
      );

    /**
     * Toggles fullscreen on the player container (video + controls + chat overlay + menus), not the bare <video>, so
     * the custom controls keep working. iOS Safari has no element fullscreen: fall back to the video's native one.
     * Phones also lock to landscape where the browser allows it.
     */
    const toggleFullscreen = async () => {
      const el = containerRef.current as any;
      const video = htmlRef.current.getVideoEl() as any;
      try {
        if (fullscreenElement()) {
          if (document.exitFullscreen) {
            await document.exitFullscreen();
          } else {
            await (document as any).webkitExitFullscreen?.();
          }
          (screen.orientation as any)?.unlock?.();
          return;
        }
        if (el?.requestFullscreen) {
          await el.requestFullscreen({ navigationUI: "hide" });
        } else if (el?.webkitRequestFullscreen) {
          await el.webkitRequestFullscreen();
        } else if (usingNative() && video?.webkitEnterFullscreen) {
          video.webkitEnterFullscreen();
          return;
        } else {
          return;
        }
        if (isMobile() || window.matchMedia?.("(pointer: coarse)").matches) {
          await (screen.orientation as any)
            ?.lock?.("landscape")
            ?.catch?.(() => {});
        }
      } catch (e) {
        console.warn("fullscreen failed", e);
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
      // Our own reported time is stale for a moment; don't let the drift controller fight the seek
      driftRef.current = initialDriftState();
    };

    /** ±seconds for everyone, clamped to the media */
    const roomSeekBy = (seconds: number) => {
      const duration = getDuration();
      let target = current().getCurrentTime() + seconds;
      if (Number.isFinite(duration) && duration > 0) {
        target = Math.min(target, duration - 0.1);
      }
      roomSeek(target);
    };

    const roomRate = () => store.get().roomPlaybackRate || 1;

    /** Recomputes the sync indicator state and stores it if it changed */
    const updateSyncStatus = () => {
      const s = store.get();
      const status = getSyncStatus({
        connected: s.socketConnected,
        buffering: s.buffering && !s.roomPaused,
        correcting: driftRef.current.correcting,
        drift: driftValueRef.current,
      });
      if (!isSameSyncStatus(status, s.syncStatus)) {
        store.set({ syncStatus: status });
      }
    };

    const setBuffering = (buffering: boolean) => {
      if (store.get().buffering !== buffering) {
        store.set({ buffering });
        updateSyncStatus();
      }
    };

    const setSocketConnected = (socketConnected: boolean) => {
      store.set({ socketConnected });
      updateSyncStatus();
    };

    /** "Resync me": jump to the room's position and start the controller fresh */
    const resync = () => {
      driftRef.current = initialDriftState();
      driftValueRef.current = 0;
      current().setPlaybackRate(roomRate());
      localSeek();
      updateSyncStatus();
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
      } else if (action.type === "stop" && store.get().videoMeta) {
        // Starts the next episode if the room is showing its card (the server ignores it otherwise)
        cmd.nextEpisode({ action: "ended", url: roomMedia });
      }
    };

    /**
     * Drift correction, run on every REC:tsMap (~1 s): small drift nudges the playback rate (0.95–1.05× the room
     * speed), large drift seeks (see logic/sync.ts nextDriftAction). Updates the sync indicator.
     */
    const onTsMap = (tsMap: NumberDict) => {
      const s = store.get();
      const active =
        shouldAutoSyncRate({
          roomPaused: s.roomPaused,
          isLiveStream: s.isLiveStream,
          hasDuration: roomHasDuration(),
        }) &&
        !s.loading &&
        !s.buffering &&
        tsMap[clientId] !== undefined;
      if (!active) {
        if (driftRef.current.correcting) {
          current().setPlaybackRate(roomRate());
        }
        driftRef.current = {
          ...driftRef.current,
          correcting: false,
        };
        driftValueRef.current = 0;
        updateSyncStatus();
        return;
      }
      const drift = leaderTime() - tsMap[clientId];
      driftValueRef.current = drift;
      const { state, action } = nextDriftAction(driftRef.current, {
        drift,
        baseRate: roomRate(),
        now: Date.now(),
        allowedRates: usingYoutube()
          ? youtubeRef.current.getAvailablePlaybackRates()
          : undefined,
      });
      driftRef.current = state;
      if (Math.abs(current().getPlaybackRate() - action.rate) > 0.001) {
        current().setPlaybackRate(action.rate);
      }
      if (action.type === "seek") {
        console.log("drift %ss: seeking to the room", drift.toFixed(2));
        localSeek();
      }
      updateSyncStatus();
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
              if (usingYoutube()) {
                setBuffering(e.data === states?.BUFFERING);
              }
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
      localSeek,
      localPlay,
      localPause,
      localSetMute,
      localSetVolume,
      localToggleMute,
      toggleFullscreen,
      isFullscreen,
      /** The player view registers its container element here (fullscreen target) */
      setContainer: (el: HTMLElement | null) => {
        containerRef.current = el;
      },
      getContainer: () => containerRef.current,
      roomTogglePlay,
      roomSeek,
      roomSeekBy,
      setBuffering,
      setSocketConnected,
      updateSyncStatus,
      resync,
      onTsMap,
      roomSetPlaybackRate: (rate: number) => cmd.setPlaybackRate(rate),
      roomSetLoop: (loop: boolean) => cmd.setLoop(loop),
      onVideoEnded,
      loadYouTube,
    };
  }, [store, cmd, clientId, share]);

  // Report our position to the room every second (and the duration now and then, for the watch history)
  useEffect(() => {
    if (!opts.connected) {
      return;
    }
    let lastDuration: DurationReport | null = null;
    const id = window.setInterval(() => {
      const { roomMedia, isLiveStream } = store.get();
      if (roomMedia) {
        cmd.reportTime(api.toRoomTime(api.current().getCurrentTime()));
        const now = Date.now();
        const report = nextDurationReport(lastDuration, {
          media: roomMedia,
          duration: api.getDuration(),
          isLive: isLiveStream,
          hasDuration: hasDuration(roomMedia),
          now,
        });
        if (report !== undefined) {
          lastDuration = { media: roomMedia, duration: report, at: now };
          cmd.reportDuration(report);
        }
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [opts.connected, api, store, cmd]);

  return api;
}

export type PlayerApi = ReturnType<typeof usePlayer>;
