import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  IconChevronDown,
  IconEyeOff,
  IconMicrophoneOff,
  IconMinus,
  IconVideo,
} from "@tabler/icons-react";
import { UserAvatar } from "../../Avatar/Avatar";
import type { Room } from "../hooks/useRoom";
import { toast } from "../ui/toast";
import { memberConnection, videoMembers } from "./callReducer";
import { CALL_PREFS, readPref, writePref } from "./logic";
import {
  isDrag,
  parseStripPrefs,
  positionFromOffset,
  stripInsets,
  stripOffset,
  tileSize,
  tilesPerColumn,
  TILE_GAP,
  type Size,
  type StripPosition,
  type StripPrefs,
} from "./tileLayout";
import { useCallVideo } from "./videoStreams";
import styles from "./VideoTiles.module.css";

/** The strip's header (grip, collapse, hide), px */
const HEADER_H = 24;

/**
 * Floating, draggable, collapsible strip of call video tiles over the player (inside PlayerArea, so it stays in
 * fullscreen). Shown only while we're in the call and someone has their camera on; hidden per device with
 * `tilesHidden`, collapsed with `tilesCollapsed` (both in state.call: while either is on, or the tab is hidden, the
 * others stop sending us video, see wantsVideo). Click a tile to enlarge it. Layout and position math: tileLayout.ts.
 */
export const VideoTiles = ({
  room,
  container,
  fullscreen,
  phone,
  controls,
  reserveRight = 0,
}: {
  room: Room;
  /** The player (PlayerArea's root): the strip is positioned and clamped inside it */
  container: HTMLElement | null;
  fullscreen: boolean;
  phone: boolean;
  /** The control bar is shown (keep clear of it) */
  controls: boolean;
  /** Space along the right edge to keep clear (the open chat panel, chatPanelReserve), px */
  reserveRight?: number;
}) => {
  const { state, clientId, call } = room;
  const c = state.call;
  const video = useCallVideo(call.video);
  const members = videoMembers(c, clientId);
  // The saved position; `collapsed` lives in state.call (tilesCollapsed), so the call knows we don't show video
  const [prefs, setPrefs] = useState<StripPosition>(() =>
    parseStripPrefs(readPref(CALL_PREFS.tiles)),
  );
  const collapsed = c.tilesCollapsed;
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const player = useSize(container);
  const [stripEl, setStripEl] = useState<HTMLDivElement | null>(null);
  const strip = useSize(stripEl, members.length, collapsed, enlarged);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(
    null,
  );
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    origin: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const savePosition = (next: StripPosition) => {
    setPrefs(next);
    const saved: StripPrefs = { fx: next.fx, fy: next.fy, collapsed };
    writePref(CALL_PREFS.tiles, JSON.stringify(saved));
  };

  if (c.tilesHidden || !members.length || !player.width) {
    return null;
  }

  const insets = stripInsets({
    fullscreen,
    phone,
    controls,
    reserve: { right: reserveRight },
  });
  const available = Math.max(
    0,
    player.height - insets.top - insets.bottom - HEADER_H - TILE_GAP,
  );
  const big = members.some((m) => m.clientId === enlarged) ? enlarged : null;
  const bigSize = big
    ? tileSize(player, { phone, enlarged: true, availableHeight: available })
    : null;
  const small = tileSize(player, { phone, availableHeight: available });
  const rows = tilesPerColumn(
    small.height,
    available - (bigSize ? bigSize.height + TILE_GAP : 0),
  );
  const offset = dragOffset ?? stripOffset(prefs, strip, player, insets);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: offset,
      moved: false,
    };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) {
      return;
    }
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && !isDrag(dx, dy)) {
      return;
    }
    if (!d.moved) {
      d.moved = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    // Clamp live, so it can't be dragged out of the player
    const pos = positionFromOffset(
      { x: d.origin.x + dx, y: d.origin.y + dy },
      strip,
      player,
      insets,
    );
    setDragOffset(stripOffset(pos, strip, player, insets));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) {
      return;
    }
    drag.current = null;
    if (d.moved && dragOffset) {
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      savePosition(positionFromOffset(dragOffset, strip, player, insets));
    }
    setDragOffset(null);
  };

  const nameOf = (id: string) => state.nameMap[id] || "Someone";
  const hide = () => {
    call.setTilesHidden(true);
    toast(
      "Video tiles hidden on this device. Show them again in the call panel.",
      { id: "wp-call-tiles" },
    );
  };

  const tile = (m: CallMember, size: Size) => {
    const isMe = m.clientId === clientId;
    const stream = isMe ? video.local : video.remote[m.clientId]?.stream;
    const live = isMe ? Boolean(video.local) : video.remote[m.clientId]?.live;
    const muted = isMe ? c.muted && !c.pttHeld : m.muted;
    const reconnecting =
      memberConnection(c, m, clientId) === "reconnecting" ||
      (isMe && c.status === "joining");
    const name = nameOf(m.clientId);
    const isBig = m.clientId === big;
    return (
      <button
        key={m.clientId}
        type="button"
        className={styles.tile}
        style={{ width: size.width, height: size.height }}
        data-speaking={c.speaking.includes(m.clientId) || undefined}
        data-enlarged={isBig || undefined}
        aria-label={`${name}${isMe ? " (you)" : ""}: ${isBig ? "make smaller" : "enlarge"}`}
        aria-pressed={isBig}
        onClick={() => {
          if (!suppressClick.current) {
            setEnlarged(isBig ? null : m.clientId);
          }
        }}
      >
        {stream && live ? (
          <TileVideo stream={stream} mirrored={isMe} />
        ) : (
          <span className={styles.placeholder}>
            <UserAvatar
              id={m.clientId}
              name={name}
              picture={state.pictureMap[m.clientId]}
              size={Math.round(Math.min(size.height * 0.5, 72))}
            />
          </span>
        )}
        {reconnecting && <span className={styles.state}>Reconnecting…</span>}
        <span className={styles.label}>
          {muted && (
            <IconMicrophoneOff
              size={12}
              className={styles.muted}
              aria-label="Muted"
            />
          )}
          <span className={styles.name}>{isMe ? "You" : name}</span>
        </span>
      </button>
    );
  };

  return (
    <div
      ref={setStripEl}
      className={styles.strip}
      style={{ left: offset.x, top: offset.y }}
      data-dragging={dragOffset ? true : undefined}
      data-collapsed={collapsed || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      role="region"
      aria-label="Call video"
    >
      {collapsed ? (
        <button
          type="button"
          className={styles.pill}
          aria-label={`Show call video (${members.length})`}
          onClick={() => {
            if (!suppressClick.current) {
              call.setTilesCollapsed(false);
            }
          }}
        >
          <IconVideo size={16} aria-hidden="true" />
          <span>{members.length}</span>
          <IconChevronDown size={14} aria-hidden="true" />
        </button>
      ) : (
        <>
          <div className={styles.header}>
            <span className={styles.grip} aria-hidden="true" />
            <button
              type="button"
              className={styles.headerBtn}
              aria-label="Collapse call video"
              title="Collapse"
              onClick={() => call.setTilesCollapsed(true)}
            >
              <IconMinus size={14} />
            </button>
            <button
              type="button"
              className={styles.headerBtn}
              aria-label="Hide video tiles on this device"
              title="Hide video tiles"
              onClick={hide}
            >
              <IconEyeOff size={14} />
            </button>
          </div>
          {big && bigSize && (
            <div className={styles.big}>
              {tile(
                members.find((m) => m.clientId === big)!,
                bigSize,
              )}
            </div>
          )}
          <div
            className={styles.grid}
            style={{
              gridTemplateRows: `repeat(${rows}, ${small.height}px)`,
            }}
          >
            {members
              .filter((m) => m.clientId !== big)
              .map((m) => tile(m, small))}
          </div>
        </>
      )}
    </div>
  );
};

/** A muted, inline, autoplaying <video> for a MediaStream (call audio plays separately, through CallAudio) */
const TileVideo = ({
  stream,
  mirrored,
}: {
  stream: MediaStream;
  mirrored: boolean;
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.srcObject = stream;
    // Muted video may always autoplay; a rejected play() (tab in the background) retries on the next render
    el.play?.()?.catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      className={styles.video}
      data-mirrored={mirrored || undefined}
      autoPlay
      playsInline
      muted
    />
  );
};

/** An element's size, kept current with a ResizeObserver (`deps` re-measure when the content changes) */
function useSize(el: HTMLElement | null, ...deps: unknown[]): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) {
      return;
    }
    const update = () =>
      setSize((s) =>
        s.width === el.offsetWidth && s.height === el.offsetHeight
          ? s
          : { width: el.offsetWidth, height: el.offsetHeight },
      );
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, ...deps]);
  return size;
}
