import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Loader } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconArrowsMinimize,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRewindBackward10,
  IconRewindForward10,
  IconVolume,
} from "@tabler/icons-react";
import type { Room } from "../hooks/useRoom";
import { VIDEO_ELEMENT_ID, YOUTUBE_ELEMENT_ID } from "../hooks/usePlayer";
import { useRoomUi } from "../ui/RoomUi";
import { IdleTimer, LEAVE_HIDE_MS } from "../logic/autoHide";
import { TapDetector, getTapZone, seekForZone } from "../logic/gestures";
import { resolveShortcut } from "../logic/shortcuts";
import { formatOffset } from "../logic/subtitles";
import { ControlBar, type MenuName } from "./ControlBar";
import { NextEpisodeCard } from "../nextEpisode/NextEpisodeCard";
import { ChatOverlay } from "./ChatOverlay";
import { QuickChat } from "./QuickChat";
import { ReadyCheckPill } from "./ReadyCheckPill";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SubtitleCues } from "./SubtitleCues";
import { usePlaybackState } from "./usePlaybackState";
import { useSubtitleStyle } from "./useSubtitleStyle";
import { useTextTracks } from "./useTextTracks";
import styles from "./Player.module.css";

/** Fired by the overflow menu to open the shortcuts overlay (shell/shortcuts.ts requestShortcutsOverlay) */
const SHOW_SHORTCUTS_EVENT = "wp:show-shortcuts";

type Tap = { x: number; width: number; touch: boolean };

/**
 * The player: YouTube iframe / <video>, rendered subtitles, overlay controls with auto-hide, chat bubbles + quick chat,
 * keyboard shortcuts and gestures. It fills its `position: relative` parent and is the fullscreen target (so controls,
 * menus and chat keep working in fullscreen).
 */
export const PlayerArea = ({ room }: { room: Room }) => {
  const { state, store, player, subtitles, cmd } = room;
  const ui = useRoomUi();
  const phone = useMediaQuery("(max-width: 48em)") ?? false;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [quickChat, setQuickChat] = useState(false);
  // Stable, so SubtitleCues doesn't re-subscribe on every render
  const getVideoEl = useCallback(() => player.html().getVideoEl(), [player]);
  const [shortcuts, setShortcuts] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [flash, setFlash] = useState<{ play: boolean; key: number } | null>(
    null,
  );
  const [osd, setOsd] = useState<{ text: string; key: number } | null>(null);
  const [ripple, setRipple] = useState<{
    side: "left" | "right";
    key: number;
  } | null>(null);
  const [subtitleStyle, setSubtitleStyle] = useSubtitleStyle();
  const playback = usePlaybackState(room);
  const tracks = useTextTracks(room);

  const idleRef = useRef<IdleTimer | null>(null);
  if (!idleRef.current) {
    idleRef.current = new IdleTimer(setIdle);
  }
  const idleTimer = idleRef.current;
  useEffect(() => () => idleTimer.dispose(), [idleTimer]);

  const hasMedia = Boolean(state.roomMedia);
  const paused = playback.paused || !hasMedia;
  useEffect(() => idleTimer.setHold("paused", paused), [idleTimer, paused]);
  useEffect(
    () => idleTimer.setHold("menu", menu !== null || shortcuts),
    [idleTimer, menu, shortcuts],
  );
  useEffect(
    () => idleTimer.setHold("quick-chat", quickChat),
    [idleTimer, quickChat],
  );
  useEffect(
    () => idleTimer.setHold("hover-controls", hovering),
    [idleTimer, hovering],
  );

  // Register the container as the fullscreen target and track fullscreen changes
  useEffect(() => {
    player.setContainer(container);
    const onChange = () => {
      setFullscreen(player.isFullscreen());
      idleTimer.poke();
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      player.setContainer(null);
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [player, container, idleTimer]);

  const showOsd = useCallback((text: string) => {
    setOsd({ text, key: Date.now() });
  }, []);
  useEffect(() => {
    if (!osd) {
      return;
    }
    const t = window.setTimeout(() => setOsd(null), 1400);
    return () => window.clearTimeout(t);
  }, [osd]);

  // "Alex paused" etc.: toasts aren't visible in element fullscreen, so show them on the video
  useEffect(() => {
    if (state.playerNotice && player.isFullscreen()) {
      showOsd(state.playerNotice.text);
    }
  }, [state.playerNotice, player, showOsd]);

  const togglePlay = useCallback(() => {
    if (!store.get().roomMedia || player.isPauseDisabled()) {
      return;
    }
    const willPlay = player.current().shouldPlay();
    player.roomTogglePlay();
    setFlash({ play: willPlay, key: Date.now() });
    idleTimer.poke();
  }, [store, player, idleTimer]);

  const quickChatAllowed = fullscreen || ui.sidebarCollapsed;
  const openChat = useCallback(() => {
    if (quickChatAllowed) {
      setQuickChat(true);
    } else {
      // Sidebar is open: use its chat input
      room.chatRef.current?.focusInput();
    }
  }, [quickChatAllowed, room.chatRef]);

  // Keyboard shortcuts (ignored while typing or in a modal; see logic/shortcuts.ts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveShortcut(e);
      if (!action) {
        return;
      }
      idleTimer.poke();
      const s = store.get();
      const media = Boolean(s.roomMedia);
      switch (action.type) {
        case "escape":
          if (shortcuts) {
            setShortcuts(false);
          } else if (quickChat) {
            setQuickChat(false);
          }
          return;
        case "showShortcuts":
          e.preventDefault();
          setShortcuts((v) => !v);
          return;
        case "chat":
          e.preventDefault();
          openChat();
          return;
      }
      if (!media) {
        return;
      }
      switch (action.type) {
        case "togglePlay":
          e.preventDefault();
          togglePlay();
          break;
        case "seekBy":
          if (player.hasDuration() && !player.isWebRTCShare()) {
            e.preventDefault();
            player.roomSeekBy(action.seconds);
            showOsd(action.seconds > 0 ? "+10 s" : "−10 s");
          }
          break;
        case "volumeBy": {
          e.preventDefault();
          const cur = player.current();
          const base = cur.isMuted() ? 0 : cur.getVolume();
          player.localSetVolume(base + action.delta);
          showOsd(`Volume ${Math.round(player.current().getVolume() * 100)}%`);
          break;
        }
        case "toggleMute":
          player.localToggleMute();
          showOsd(player.current().isMuted() ? "Muted" : "Unmuted");
          break;
        case "toggleFullscreen":
          e.preventDefault();
          player.toggleFullscreen();
          break;
        case "subtitleOffsetBy":
          if (player.usingNative()) {
            const v = subtitles.nudgeOffset(action.delta);
            showOsd(
              `Subtitles ${formatOffset(v)} · ${s.subtitleScope === "me" ? "just me" : "everyone"}`,
            );
          }
          break;
      }
    };
    const onShowShortcuts = () => setShortcuts(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHOW_SHORTCUTS_EVENT, onShowShortcuts);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHOW_SHORTCUTS_EVENT, onShowShortcuts);
    };
  }, [
    store,
    player,
    subtitles,
    idleTimer,
    togglePlay,
    openChat,
    showOsd,
    shortcuts,
    quickChat,
  ]);

  // Close the quick chat if it no longer applies (left fullscreen with the sidebar open)
  useEffect(() => {
    if (!quickChatAllowed) {
      setQuickChat(false);
    }
  }, [quickChatAllowed]);

  // Click / tap on the video. Desktop: click = play/pause for everyone, double-click = fullscreen.
  // Touch: tap = show/hide controls, double-tap left/right = ∓10 s with a ripple, centre = fullscreen.
  const handlers = useRef({
    single: (_t: Tap) => {},
    double: (_t: Tap) => {},
  });
  handlers.current.single = (t) => {
    if (t.touch) {
      if (idleTimer.isIdle()) {
        idleTimer.poke();
      } else {
        idleTimer.hideNow();
      }
    } else {
      togglePlay();
    }
  };
  handlers.current.double = (t) => {
    const zone = t.touch ? getTapZone(t.x, t.width) : "center";
    const seconds = seekForZone(zone);
    if (seconds && hasMedia && player.hasDuration()) {
      player.roomSeekBy(seconds);
      setRipple({ side: seconds < 0 ? "left" : "right", key: Date.now() });
    } else {
      player.toggleFullscreen();
    }
  };
  const tapRef = useRef<TapDetector<Tap> | null>(null);
  if (!tapRef.current) {
    tapRef.current = new TapDetector<Tap>(
      (t) => handlers.current.single(t),
      (t) => handlers.current.double(t),
    );
  }
  useEffect(() => () => tapRef.current?.cancel(), []);
  const menuOpenAtDown = useRef(false);

  useEffect(() => {
    if (!ripple) {
      return;
    }
    const t = window.setTimeout(() => setRipple(null), 600);
    return () => window.clearTimeout(t);
  }, [ripple]);

  const showChatOverlay =
    ui.chatOverlayEnabled && (fullscreen || ui.sidebarCollapsed) && hasMedia;
  const native = player.usingNative();

  return (
    <div
      ref={setContainer}
      className={styles.player}
      data-idle={idle && hasMedia}
      data-fullscreen={fullscreen}
      onPointerMove={(e) => {
        if (e.pointerType === "mouse") {
          idleTimer.poke();
        }
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse" && !paused) {
          idleTimer.poke(LEAVE_HIDE_MS);
        }
      }}
    >
      <iframe
        style={{
          display: player.usingYoutube() && !state.loading ? "block" : "none",
        }}
        title="YouTube"
        id={YOUTUBE_ELEMENT_ID}
        className={styles.media}
        allowFullScreen
        frameBorder="0"
        allow="autoplay; encrypted-media; picture-in-picture"
        src="https://www.youtube.com/embed/?enablejsapi=1&controls=0&rel=0"
      />
      <video
        style={{ display: native ? "block" : "none" }}
        id={VIDEO_ELEMENT_ID}
        className={styles.media}
        onEnded={(e) => player.onVideoEnded(e.currentTarget.src)}
        onWaiting={() => player.setBuffering(true)}
        onPlaying={() => player.setBuffering(false)}
        onCanPlay={() => player.setBuffering(false)}
        onEmptied={() => player.setBuffering(false)}
        playsInline
      />

      {native && (
        <SubtitleCues
          track={tracks.active}
          getMedia={getVideoEl}
          style={subtitleStyle}
          lift={hasMedia}
        />
      )}

      <div
        className={styles.gestures}
        aria-hidden="true"
        onPointerDown={() => {
          menuOpenAtDown.current = menu !== null || shortcuts;
        }}
        onPointerUp={(e) => {
          if (e.button !== 0 || menuOpenAtDown.current) {
            // The first click outside an open menu only closes it
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          tapRef.current?.tap({
            x: e.clientX - rect.left,
            width: rect.width,
            touch: e.pointerType !== "mouse",
          });
        }}
      />

      {hasMedia && (
        <>
          <div className={styles.scrimBottom} />
          {fullscreen && <div className={styles.scrimTop} />}
        </>
      )}

      {fullscreen && hasMedia && (
        <div className={styles.overlayTop}>
          <div className={styles.overlayTitle}>
            {room.getMediaDisplayName(state.roomMedia)}
          </div>
          <button
            className={styles.btn}
            aria-label="Exit fullscreen"
            onClick={() => player.toggleFullscreen()}
          >
            <IconArrowsMinimize size={22} />
          </button>
        </div>
      )}

      {!state.isAutoPlayable && hasMedia && (
        // The browser blocked sound until this page is interacted with. The scrim covers the controls, so a click
        // anywhere on it unmutes (not just on the button), instead of silently swallowing clicks.
        <div
          className={styles.unmute}
          onClick={(e) => {
            e.stopPropagation();
            store.set({ isAutoPlayable: true });
            player.localSetMute(false);
            player.localSetVolume(1);
          }}
        >
          <Button size="lg" leftSection={<IconVolume />}>
            Unmute
          </Button>
        </div>
      )}

      {(state.loading || !hasMedia || state.nonPlayableMedia) &&
        !state.isLiveStream && (
          <div className={styles.center}>
            {state.loading && hasMedia && (
              <Loader color="var(--wp-on-video)" aria-label="Loading video" />
            )}
            {!hasMedia && !state.loading && (
              <div className={styles.emptyCard}>
                <h3>Nothing playing</h3>
                <span>Pick a video, paste a link, or share your screen.</span>
                <Button variant="light" onClick={ui.openPicker}>
                  Play something
                </Button>
              </div>
            )}
            {!state.loading && state.nonPlayableMedia && (
              <div className={styles.emptyCard} data-tone="danger">
                <h3>This link isn't a video</h3>
                <span>
                  It needs to point to a video file or stream, not a web page.
                </span>
              </div>
            )}
          </div>
        )}

      {flash && (
        <div key={flash.key} className={styles.flash} aria-hidden="true">
          {flash.play ? (
            <IconPlayerPlayFilled size={32} />
          ) : (
            <IconPlayerPauseFilled size={32} />
          )}
        </div>
      )}
      {osd && (
        <div key={osd.key} className={styles.osdTop} role="status">
          {osd.text}
        </div>
      )}
      <ReadyCheckPill
        state={state.readyCheck}
        nameMap={state.nameMap}
        pictureMap={state.pictureMap}
        clientId={room.clientId}
        onSkip={room.readyCheck.skip}
      />
      {ripple && (
        <div
          key={ripple.key}
          className={styles.ripple}
          data-side={ripple.side}
          aria-hidden="true"
        >
          <span>
            {ripple.side === "left" ? (
              <IconRewindBackward10 size={28} />
            ) : (
              <IconRewindForward10 size={28} />
            )}
            10 s
          </span>
        </div>
      )}

      {showChatOverlay && (
        <ChatOverlay
          chat={state.chat}
          nameMap={state.nameMap}
          clientId={room.clientId}
          mediaName={(u) => room.getMediaDisplayName(u)}
          chatting={quickChat}
        />
      )}
      {quickChat && (
        <QuickChat
          onSend={(msg) => cmd.sendChat(msg)}
          onClose={() => setQuickChat(false)}
        />
      )}

      <NextEpisodeCard room={room} />

      {hasMedia && (
        <ControlBar
          room={room}
          playback={playback}
          menu={menu}
          setMenu={setMenu}
          container={container}
          fullscreen={fullscreen}
          phone={phone}
          showMiniSync={fullscreen || ui.sidebarCollapsed}
          tracks={tracks}
          subtitleStyle={subtitleStyle}
          setSubtitleStyle={setSubtitleStyle}
          onTogglePlay={togglePlay}
          onHoverChange={setHovering}
        />
      )}

      {shortcuts && <ShortcutsOverlay onClose={() => setShortcuts(false)} />}
    </div>
  );
};
