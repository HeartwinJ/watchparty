import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { IntroSkipNotice } from "../introSkip/IntroSkipNotice";
import { ChatOverlay } from "./ChatOverlay";
import { ChatPanel } from "./ChatPanel";
import {
  chatKeyTarget,
  chatPanelAllowed,
  chatPanelReserve,
  chatPanelWidth,
} from "./chatPanel";
import { useChatPanel } from "./useChatPanel";
import { QuickChat } from "./QuickChat";
import { ReadyCheckPill } from "./ReadyCheckPill";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SubtitleCues } from "./SubtitleCues";
import { usePlaybackState } from "./usePlaybackState";
import { useSubtitleStyle } from "./useSubtitleStyle";
import { useTextTracks } from "./useTextTracks";
import styles from "./Player.module.css";
import { inCall } from "../call/callReducer";
import { VideoTiles } from "../call/VideoTiles";

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
  const [hoveringPanel, setHoveringPanel] = useState(false);
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
  // Keep this viewer's subtitles on (or off) for the next episode, once its tracks are in
  useEffect(() => {
    subtitles.applyCarry();
  }, [
    subtitles,
    tracks.tracks,
    tracks.selected,
    state.subtitleTracks,
    state.subtitleTracksFor,
    state.videoMeta,
    state.roomSubtitle,
    state.loading,
  ]);

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
  const playerWidth = useElementWidth(container);

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
  // The chat panel over the video (fullscreen / sidebar collapsed); starts collapsed every time (chatPanel.ts)
  const panelAllowed = chatPanelAllowed({
    fullscreen,
    sidebarCollapsed: ui.sidebarCollapsed,
    phoneLayout: phone,
    playerWidth,
  });
  const chatPanel = useChatPanel({
    allowed: panelAllowed,
    fullscreen,
    chat: state.chat,
    chatInitCount: state.chatInitCount,
    currentTab: state.currentTab,
    clientId: room.clientId,
    store,
  });
  const panelOpen = chatPanel.open;
  const panelChatRef = chatPanel.chatRef;
  const togglePanel = chatPanel.toggle;
  const closePanel = chatPanel.close;
  useEffect(
    () => idleTimer.setHold("chat-panel", panelOpen && hoveringPanel),
    [idleTimer, panelOpen, hoveringPanel],
  );
  useEffect(() => {
    if (!panelOpen) {
      setHoveringPanel(false);
      // A picker left open would show again on the next open
      panelChatRef.current?.closePickers();
      return;
    }
    setQuickChat(false);
    panelChatRef.current?.scrollToBottom();
    // Opening focuses the input, except on touch screens, where that would pop the keyboard over the video
    const coarse =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    if (!coarse) {
      panelChatRef.current?.focusInput();
    }
  }, [panelOpen, panelChatRef]);

  const openChat = useCallback(() => {
    switch (chatKeyTarget({ quickChatAllowed, panelOpen })) {
      case "panel":
        panelChatRef.current?.focusInput();
        break;
      case "quick":
        setQuickChat(true);
        break;
      case "sidebar":
        // Sidebar is open: use its chat input
        room.chatRef.current?.focusInput();
        break;
    }
  }, [quickChatAllowed, panelOpen, panelChatRef, room.chatRef]);

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
          } else if (panelOpen && panelChatRef.current?.closePickers()) {
            // The panel's emoji or reaction picker was open (focus outside the panel): close only that
          } else if (panelOpen && menu === null) {
            // Outside fullscreen only: in fullscreen the browser takes Esc to exit it (which closes the panel too)
            closePanel();
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
        case "chatPanel":
          e.preventDefault();
          if (panelAllowed) {
            togglePanel();
          } else {
            openChat();
          }
          return;
        case "toggleMute":
          // In a voice call, M is the mic (the movie keeps its volume control); otherwise it mutes the video
          if (inCall(s.call)) {
            e.preventDefault();
            if (s.call.pushToTalk) {
              showOsd("Push to talk is on: hold T to talk");
            } else {
              showOsd(room.call.toggleMute() ? "Mic muted" : "Mic on");
            }
            return;
          }
          break;
        case "toggleCamera":
          // V: only in a voice call
          if (inCall(s.call)) {
            e.preventDefault();
            const turningOn = !(s.call.camera || s.call.cameraBusy);
            if (!turningOn) {
              showOsd("Camera off");
            }
            void room.call.toggleCamera().then((on) => {
              if (turningOn) {
                showOsd(on ? "Camera on" : "Camera unavailable");
              }
            });
          }
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
    room.call,
    panelOpen,
    panelAllowed,
    togglePanel,
    closePanel,
    panelChatRef,
    menu,
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
  const panelOpenAtDown = useRef(false);

  useEffect(() => {
    if (!ripple) {
      return;
    }
    const t = window.setTimeout(() => setRipple(null), 600);
    return () => window.clearTimeout(t);
  }, [ripple]);

  const showChatOverlay =
    ui.chatOverlayEnabled &&
    (fullscreen || ui.sidebarCollapsed) &&
    hasMedia &&
    !panelOpen;
  // The open panel's share of the right edge: tiles, the next-episode card and the centred pills keep clear of it
  const panelReserve = chatPanelReserve(panelOpen, playerWidth);
  const native = player.usingNative();

  return (
    <div
      ref={setContainer}
      className={styles.player}
      data-idle={idle && hasMedia}
      data-fullscreen={fullscreen}
      data-chat-panel={panelOpen ? "open" : undefined}
      style={
        { "--wp-chat-reserve": `${panelReserve}px` } as React.CSSProperties
      }
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
          panelOpenAtDown.current = panelOpen;
        }}
        onPointerUp={(e) => {
          if (e.button !== 0 || menuOpenAtDown.current) {
            // The first click outside an open menu only closes it
            return;
          }
          if (panelOpenAtDown.current) {
            // Clicking / tapping the video with the chat panel open closes it (and doesn't pause)
            tapRef.current?.cancel();
            closePanel();
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

      {/* Quick chat shows the last messages itself; the bubbles resume (new messages only) when it closes */}
      {showChatOverlay && !quickChat && (
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
          container={container}
          compact={phone}
          chat={state.chat}
          nameMap={state.nameMap}
          clientId={room.clientId}
        />
      )}

      {chatPanel.mounted && (
        <ChatPanel
          room={room}
          open={panelOpen}
          width={chatPanelWidth(playerWidth)}
          container={container}
          chatRef={panelChatRef}
          onClose={closePanel}
          onHoverChange={setHoveringPanel}
        />
      )}

      <NextEpisodeCard room={room} />
      <IntroSkipNotice room={room} />

      <VideoTiles
        room={room}
        container={container}
        fullscreen={fullscreen}
        phone={phone}
        controls={hasMedia}
        reserveRight={panelReserve}
      />

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
          chatPanel={
            panelAllowed
              ? {
                  open: panelOpen,
                  unread: chatPanel.unread,
                  onToggle: togglePanel,
                }
              : undefined
          }
        />
      )}

      {shortcuts && <ShortcutsOverlay onClose={() => setShortcuts(false)} />}
    </div>
  );
};

/** The element's width in px (0 until measured), kept current with a ResizeObserver */
function useElementWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) {
      setWidth(0);
      return;
    }
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}
