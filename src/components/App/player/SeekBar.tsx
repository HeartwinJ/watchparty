import { useRef, useState } from "react";
import { formatTimestamp } from "../../../utils/utils";
import styles from "./Player.module.css";

/**
 * Custom seek bar: buffered ranges under the played fill, a knob and hover line + time tooltip. Click or drag to seek
 * (committed on release), arrow keys ±5 s, Home/End.
 */
export function SeekBar(props: {
  currentTime: number;
  duration: number;
  buffered: { start: number; end: number }[];
  onSeek: (time: number) => void;
  /** Wall-clock base for live streams (formatTimestamp's zeroTime) */
  zeroTime?: number;
  disabled?: boolean;
}) {
  const { duration, onSeek, zeroTime } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const valid = Number.isFinite(duration) && duration > 0;
  const pct = (t: number) =>
    valid ? `${Math.min(100, Math.max(0, (t / duration) * 100))}%` : "0%";
  const timeAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !valid || rect.width <= 0) {
      return 0;
    }
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return f * duration;
  };
  const shown = drag ?? props.currentTime;
  const tip = drag ?? hover;
  const disabled = props.disabled || !valid;

  return (
    <div
      ref={ref}
      className={styles.seek}
      data-drag={drag !== null}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Seek"
      aria-disabled={disabled}
      aria-valuemin={0}
      aria-valuemax={valid ? Math.round(duration) : 0}
      aria-valuenow={Math.round(shown) || 0}
      aria-valuetext={
        valid
          ? `${formatTimestamp(shown, zeroTime)} of ${formatTimestamp(duration, zeroTime)}`
          : "Unknown duration"
      }
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) {
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (disabled) {
          return;
        }
        const t = timeAt(e.clientX);
        if (drag !== null) {
          setDrag(t);
        } else if (e.pointerType === "mouse") {
          setHover(t);
        }
      }}
      onPointerUp={(e) => {
        if (drag !== null) {
          onSeek(timeAt(e.clientX));
          setDrag(null);
        }
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (disabled) {
          return;
        }
        const keys: Record<string, number> = {
          ArrowLeft: -5,
          ArrowRight: 5,
          PageDown: -30,
          PageUp: 30,
        };
        if (e.key in keys) {
          e.preventDefault();
          onSeek(Math.max(0, props.currentTime + keys[e.key]));
        } else if (e.key === "Home") {
          e.preventDefault();
          onSeek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          onSeek(Math.max(0, duration - 1));
        }
      }}
    >
      <div className={styles.track}>
        {valid &&
          props.buffered.map((r, i) => (
            <div
              key={i}
              className={styles.buffered}
              style={{
                left: pct(r.start),
                width: `calc(${pct(r.end)} - ${pct(r.start)})`,
              }}
            />
          ))}
        <div className={styles.played} style={{ width: pct(shown) }} />
        {tip !== null && valid && (
          <div className={styles.hoverLine} style={{ left: pct(tip) }} />
        )}
        <div className={styles.knob} style={{ left: pct(shown) }} />
      </div>
      {tip !== null && valid && (
        <div className={styles.seekTip} style={{ left: pct(tip) }}>
          {formatTimestamp(tip, zeroTime)}
        </div>
      )}
    </div>
  );
}
