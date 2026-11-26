import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type Hls from "hls.js";
import type { MediaPlayerClass } from "dashjs";
import { apiFetch } from "../../../utils/api";
import { generateName } from "../../../utils/generateName";
import {
  getOrCreateClientId,
  isDash,
  isDirectVideoUrl,
  isFileShare,
  isHls,
  isScreenShare,
  testAutoplay,
} from "../../../utils/utils";
import type { Chat } from "../../Chat/Chat";
import { createInitialRoomState } from "../roomState";
import { getMediaDisplayName } from "../logic/media";
import { useStore } from "./useStore";
import { getJoinSeekTarget } from "../logic/sync";
import { useRoomSocket, type RoomSocketHandlers } from "./useRoomSocket";
import { usePlayer } from "./usePlayer";
import { getConvertStatus, useConvert } from "./useConvert";
import { createShareSession, useShare } from "./useShare";
import { useChat } from "./useChat";
import { usePlaylist } from "./usePlaylist";
import { useSubtitles } from "./useSubtitles";
import { useReadyCheck } from "./useReadyCheck";
import { useSubtitleSync } from "../subsync/useSubtitleSync";
import { useCall } from "../call/useCall";
import { toast } from "../ui/toast";
import { useAuth } from "../../AuthGate/AuthGate";
import { navigate } from "../../../router";
import { removeRecentRoom } from "../../../utils/recentRooms";

declare global {
  interface Window {
    onYouTubeIframeAPIReady: any;
    YT: YT.JsApi;
    watchparty: {
      hls?: Hls;
      dash?: MediaPlayerClass;
    };
  }
}

window.watchparty = window.watchparty ?? {};

const MESSAGE_DURATION_MS = 3000;

/** One quiet toast when this device starts converting the room's video (replaces the previous one) */
const notifyConvertStart = (reason: string, heavy: boolean) =>
  toast(
    heavy
      ? `Converting the video on this device (${reason}). This can be heavy on phones and older laptops.`
      : `Converting for this browser: ${reason}`,
    { id: "wp-convert", title: "Auto-convert" },
  );

/**
 * Everything the room page needs: composes the store, socket, player, conversion, sharing, chat, playlist and
 * subtitle hooks, and wires the socket events to them. App.tsx only renders what this returns.
 */
export function useRoom(roomId: string) {
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const [state, store] = useStore(createInitialRoomState);
  const shareSession = useRef(createShareSession()).current;
  const chatRef = useRef<Chat>(null);
  const handlersRef = useRef<RoomSocketHandlers>(null);
  /**
   * Where the room wants the current video (its REC:host start, moved by every REC:seek) and when we heard it. The
   * join seek when the media can play uses the latest one: a REC:seek that arrives while the video is still loading
   * (e.g. the server undoing a skipped intro) must not be overridden by the stale start.
   */
  const roomPositionRef = useRef({ time: 0, at: 0 });
  // The socket connects once we know whether autoplay is allowed
  const [ready, setReady] = useState(false);

  const { socket, cmd } = useRoomSocket(roomId, clientId, ready, handlersRef);
  // Read at call time by the socket handlers (kicked / access revoked send guests to the room password screen)
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;

  const showMessage = useCallback(
    (key: "errorMessage" | "successMessage", message: string) => {
      store.set({ [key]: message });
      setTimeout(() => store.set({ [key]: "" }), MESSAGE_DURATION_MS);
    },
    [store],
  );
  const showError = useCallback(
    (message: string) => showMessage("errorMessage", message),
    [showMessage],
  );

  const player = usePlayer({
    store,
    cmd,
    clientId,
    share: shareSession,
    connected: Boolean(socket),
  });
  const convertApi = useConvert({
    store,
    player,
    showError,
    reportIssue: cmd.reportPlaybackIssue,
    onConvertStart: notifyConvertStart,
  });
  const share = useShare({
    store,
    cmd,
    clientId,
    player,
    convert: convertApi,
    session: shareSession,
    showError,
  });
  const chat = useChat({ store, chatRef });
  const playlist = usePlaylist({ store, cmd });
  const subtitles = useSubtitles({ store, player, clientId, cmd });
  const subsync = useSubtitleSync({
    store,
    player,
    cmd,
    clientId,
    subtitles,
    share: shareSession,
  });
  const readyCheck = useReadyCheck({
    store,
    cmd,
    player,
    clientId,
    connected: Boolean(socket),
  });
  const call = useCall({ store, cmd, clientId, roomId, player });

  const actions = useMemo(() => {
    const updateName = (name: string) => {
      store.set({ myName: name });
      cmd.setName(name);
      window.localStorage.setItem("watchparty-username", name);
    };

    const displayName = (input?: string) =>
      getMediaDisplayName(input, store.get());

    const setLoadingFalse = () => store.set({ loading: false });

    /** "Alex paused": a toast, plus the player's on-screen display (toasts aren't visible in fullscreen) */
    const announce = (actor: PlaybackActor | undefined, verb: string) => {
      if (!actor || actor.id === clientId) {
        return;
      }
      const name = actor.name || store.get().nameMap[actor.id] || "Someone";
      const text = `${name} ${verb}`;
      toast(text, { id: "wp-playback-actor" });
      store.set({ playerNotice: { text, at: Date.now() } });
    };

    // REC:host: the room's media changed (or we just joined). Stop what's playing and load the new media.
    const onHost = async (data: HostState) => {
      const currentMedia = data.video || "";
      const prevMedia = store.get().roomMedia;
      if (isScreenShare(prevMedia) && !isScreenShare(currentMedia)) {
        share.stopPublishing();
      }
      if (isFileShare(prevMedia) && !isFileShare(currentMedia)) {
        share.stopPublishing();
      }
      if (
        (isScreenShare(prevMedia) && isScreenShare(currentMedia)) ||
        (isFileShare(prevMedia) && isFileShare(currentMedia))
      ) {
        // Ignore, it's probably a reconnection
        return;
      }
      subsync.onVideoChange();
      store.set({
        roomMedia: currentMedia,
        roomPaused: data.paused,
        roomSubtitle: data.subtitle,
        roomLoop: data.loop,
        roomPlaybackRate: data.playbackRate,
        loading: Boolean(data.video),
        nonPlayableMedia: false,
        isLiveStream: false,
        // A skipped intro is announced right after this (REC:introSkip)
        introSkip: null,
        introSkipStart: null,
      });
      const video = player.html().getVideoEl();

      // Stop all players
      // Unless the user is sharing a file, because we play it in our <video> and capture the stream
      if (!shareSession.isFile) {
        convertApi.stopConvert();
        player.html().pauseVideo();
      }
      player.youtube().stopVideo();

      if (!shareSession.isFile) {
        player.current().clearState();
      }
      subtitles.onHostOffset(data.subtitleOffset, data.subtitleScale);
      if (data.subtitle) {
        player.current().loadSubtitles(data.subtitle);
        // Room auto-sync (waits for the cues to load; no-op unless the room setting is on)
        subsync.evaluate();
      }
      if (data.playbackRate) {
        player.current().setPlaybackRate(data.playbackRate);
      }

      if (player.isWebRTCShare()) {
        console.log(
          "exiting REC:host since we are using webRTC (fileshare or screenshare). Check setupRTCConnections()",
        );
        setLoadingFalse();
        return;
      }
      if (player.usingYoutube() && !player.youtube().isReady()) {
        console.log(
          "YT player not ready, onReady callback will retry when it is",
        );
        return;
      }
      const src = data.video;
      const time = data.videoTS;
      roomPositionRef.current = { time, at: Date.now() };
      if (isDash(src)) {
        if (!window.watchparty.dash) {
          const Dash = await import("dashjs");
          window.watchparty.dash = Dash.MediaPlayer().create();
          window.watchparty.dash.on("streamInitialized", () => {
            // for a live stream:
            // html.currenttime is time since stream start
            // html.duration is infinite
            // html.seekable ends at the live edge (see getDuration)
            // player.duration is the size of the seekable range, not a position
            const isLiveStream = Boolean(window.watchparty.dash?.isDynamic());
            console.log("DASH stream initialized: isLive %s", isLiveStream);
            store.set({ isLiveStream });
          });
        }
        window.watchparty.dash.initialize(video, src);
      } else if (isHls(src) && window.MediaSource) {
        // Prefer using hls.js if MediaSource Extensions are supported
        // otherwise fallback to native HLS support using video tag (i.e. iPhones)
        if (!window.watchparty.hls) {
          const HlsClass = (await import("hls.js")).default;
          window.watchparty.hls = new HlsClass();
          window.watchparty.hls.on(HlsClass.Events.LEVEL_LOADED, (_, data) => {
            const isLiveStream = data.details.live;
            store.set({ isLiveStream });
            console.log("HLS level loaded: isLive %s", isLiveStream);
          });
        }
        window.watchparty.hls.loadSource(src);
        window.watchparty.hls.attachMedia(video);
      } else if (isDirectVideoUrl(src)) {
        // Probes the file and plays it directly, converts it, or reports that it can't (see useConvert)
        await convertApi.playUrl(src, time);
      } else {
        await player.current().setSrcAndTime(src, time);
      }
      // Start this video. Use the current room state: REC:play/pause may have arrived while the link was probed
      if (!store.get().roomPaused) {
        player.localPlay();
      }
      // Do right before playing
      video?.addEventListener(
        "canplay",
        () => {
          setLoadingFalse();
          // The room's start, or a REC:seek that arrived while we were loading
          const position = roomPositionRef.current;
          let ts = undefined;
          // Hls and Dash reset position back to 0 so set it back here
          if (isHls(src) || isDash(src) || store.get().isLiveStream) {
            ts = position.time;
          }
          // Resync since the loading might have taken some time: to the other viewers, or (alone) to where the room
          // was, never to our own position, which was ~0 while loading (a reload used to restart converted videos)
          const s = store.get();
          player.localSeek(
            ts ??
              getJoinSeekTarget({
                tsMap: s.tsMap,
                selfId: clientId,
                participantCount: s.participants.length,
                hostTime: position.time,
                hostReceivedAt: position.at,
                now: Date.now(),
                paused: s.roomPaused,
                rate: s.roomPlaybackRate || 1,
              }),
          );
          if (data.playbackRate) {
            // Set playback rate again since it might have been lost
            console.log("setting playback rate again", data.playbackRate);
            player.current().setPlaybackRate(data.playbackRate);
          }
        },
        { once: true },
      );
    };

    const handlers: RoomSocketHandlers = {
      connect: async () => {
        store.set({
          connection: "connected",
          overlayMsg: "",
          errorMessage: "",
          successMessage: "",
          warningMessage: "",
        });
        player.setSocketConnected(true);
        call.onConnect();
        // Use the name in our state, generate one if empty
        updateName(store.get().myName || (await generateName()));
      },
      connectError: (err) => {
        if (err.message === "Invalid namespace") {
          store.set({ overlayMsg: "Couldn't load this room." });
        } else if (err.message === "password") {
          store.set({
            overlayMsg: "This room has a password, which isn't supported.",
          });
        } else {
          store.set({ overlayMsg: err?.message ?? "An error occurred" });
        }
      },
      disconnect: (reason) => {
        player.setSocketConnected(false);
        call.onDisconnect(reason);
        if (reason === "io server disconnect") {
          // the disconnection was initiated by the server, you need to reconnect manually
          store.set({ overlayMsg: "Disconnected from server." });
        } else {
          // else the socket will automatically try to reconnect
          // Use the alert pill since it's less disruptive
          store.set({ warningMessage: "Reconnecting..." });
        }
      },
      errorMessage: (err) => showMessage("errorMessage", err),
      successMessage: (msg) => showMessage("successMessage", msg),
      kicked: () => {
        if (authRef.current.role === "guest") {
          authRef.current.roomAccessLost(roomId, "kicked");
        } else {
          window.location.assign("/");
        }
      },
      "REC:roomAccess": (roomAccess) => store.set({ roomAccess }),
      "REC:accessRevoked": () =>
        authRef.current.roomAccessLost(roomId, "passwordChanged"),
      "REC:roomDeleted": (info) => {
        removeRecentRoom(roomId);
        if (info?.by?.id === clientId) {
          // We deleted it: back to Home
          toast("Room deleted.");
          navigate("/");
          return;
        }
        const by = info?.by
          ? store.get().nameMap[info.by.id] || info.by.name || null
          : null;
        store.set({ roomDeleted: { by } });
      },
      "REC:play": (_video, actor) => {
        player.localPlay();
        announce(actor, "played");
      },
      "REC:pause": (actor) => {
        player.localPause();
        announce(actor, "paused");
      },
      "REC:subtitleOffset": (data) => {
        if (data && typeof data.offset === "number") {
          subtitles.onRemoteOffset(data.offset, data.scale);
        }
      },
      "REC:seek": (time) => {
        roomPositionRef.current = { time, at: Date.now() };
        store.set({ introSkipStart: null });
        player.localSeek(time);
      },
      "REC:playbackRate": (rate) => {
        store.set({ roomPlaybackRate: rate });
        if (rate > 0) {
          player.current().setPlaybackRate(rate);
        }
      },
      "REC:subtitle": (url) => {
        subtitles.onSubtitle(url);
        subsync.evaluate();
      },
      "REC:subtitleSync": subsync.onEvent,
      "REC:loop": (loop) => store.set({ roomLoop: loop }),
      "REC:host": onHost,
      "REC:chat": chat.onMessage,
      "REC:addReaction": chat.onAddReaction,
      "REC:removeReaction": chat.onRemoveReaction,
      "REC:tsMap": (tsMap) => {
        store.set({ tsMap });
        // Drift correction (playback rate nudges / seeks) and the sync indicator
        player.onTsMap(tsMap);
        subtitles.syncToSharer();
      },
      "REC:nameMap": (nameMap) => store.set({ nameMap }),
      "REC:pictureMap": (pictureMap) => store.set({ pictureMap }),
      roster: (participants) => {
        store.set({ participants });
        share.setupRTCConnections();
      },
      chatinit: chat.onInit,
      playlist: (items) => store.set({ playlist: items }),
      "REC:videoMeta": (videoMeta) => store.set({ videoMeta }),
      "REC:introSkip": (info) => {
        const skipped =
          info && typeof info.seconds === "number" && info.seconds > 0;
        store.set({
          introSkip: skipped ? { seconds: info.seconds, at: Date.now() } : null,
          // null only hides the notice: the start stays known until someone seeks
          ...(skipped ? { introSkipStart: info.seconds } : {}),
        });
      },
      "REC:playbackIssue": (issue) =>
        store.set({ playbackIssue: { ...issue, at: Date.now() } }),
      "REC:roomSettings": (roomSettings) => {
        const was = store.get().roomSettings.autoSyncSubtitles;
        store.set({ roomSettings });
        if (roomSettings.autoSyncSubtitles && !was) {
          // Turned on with subtitles already showing: sync those too
          subsync.evaluate();
        }
      },
      "REC:readyCheck": readyCheck.onState,
      "REC:nextEpisode": (nextEpisode) =>
        store.set({ nextEpisode: { ...nextEpisode, at: Date.now() } }),
      signalSS: share.handleSignal,
      "REC:callState": call.onState,
      "REC:callSignal": call.onSignal,
      "REC:callModerated": call.onModerated,
    };

    return { updateName, displayName, handlers };
  }, [
    roomId,
    clientId,
    store,
    cmd,
    player,
    convertApi,
    share,
    chat,
    subtitles,
    subsync,
    readyCheck,
    call,
    shareSession,
    showMessage,
  ]);

  useLayoutEffect(() => {
    handlersRef.current = actions.handlers;
  }, [actions]);

  // Mount: heartbeat, autoplay check, YouTube API, then connect. Unmount: stop sharing (the socket hook disconnects).
  useEffect(() => {
    let unmounted = false;
    // Send heartbeat to the server
    const heartbeat = window.setInterval(
      () => apiFetch("/ping"),
      10 * 60 * 1000,
    );
    (async () => {
      const canAutoplay = await testAutoplay();
      if (unmounted) {
        return;
      }
      store.set({ isAutoPlayable: canAutoplay });
      player.loadYouTube();
      setReady(true);
    })();
    return () => {
      unmounted = true;
      window.clearInterval(heartbeat);
    };
    // Runs once per room page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A layout effect so this cleanup runs before the socket disconnects (CMD:leaveScreenShare still gets sent)
  const shareRef = useRef(share);
  shareRef.current = share;
  useLayoutEffect(() => () => void shareRef.current.stopPublishing(), []);

  // Theater/video fullscreen
  useEffect(() => {
    document.onfullscreenchange = () => {
      store.set({ fullScreen: Boolean(document.fullscreenElement) });
      setTimeout(() => chatRef.current?.scrollToBottom(), 100);
    };
    return () => {
      document.onfullscreenchange = null;
    };
  }, [store]);

  // room.convert also carries the live "Converting · 34% buffered" status for the player/top bar
  const convertStatus = getConvertStatus(state);
  const convertStatusKey = convertStatus
    ? `${convertStatus.label}|${convertStatus.heavy}|${convertStatus.reason}`
    : "";
  const convert = useMemo(
    () => ({ ...convertApi, status: convertStatus }),
    // convertStatus is derived from the key
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [convertApi, convertStatusKey],
  );

  return {
    state,
    store,
    clientId,
    cmd,
    socket,
    chatRef,
    player,
    convert,
    share,
    playlist,
    subtitles,
    subsync,
    readyCheck,
    call,
    showError,
    updateName: actions.updateName,
    getMediaDisplayName: actions.displayName,
  };
}

export type Room = ReturnType<typeof useRoom>;
