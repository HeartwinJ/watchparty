import { useState } from "react";
import {
  IconCheck,
  IconEye,
  IconLink,
  IconSearch,
  IconUpload,
  IconUsers,
} from "@tabler/icons-react";
import { apiFetch } from "../../../utils/api";
import { openFileSelector, serverPath } from "../../../utils/utils";
import type { Room } from "../hooks/useRoom";
import {
  SUBTITLE_OFFSET_SLIDER_MAX,
  describeOffset,
  describeScale,
  effectiveOffset,
  formatOffset,
  parseOffsetInput,
  type SubtitleBackground,
  type SubtitleSize,
} from "../logic/subtitles";
import type { SubtitleStyle } from "./useSubtitleStyle";
import type { useTextTracks } from "./useTextTracks";
import { AutoSyncButton } from "../subsync/AutoSyncButton";
import { AudioBoostSection } from "./AudioBoostSection";
import styles from "./Player.module.css";

const SIZES: [SubtitleSize, string][] = [
  ["s", "S"],
  ["m", "M"],
  ["l", "L"],
  ["xl", "XL"],
];
const BACKGROUNDS: [SubtitleBackground, string][] = [
  ["none", "None"],
  ["shadow", "Shadow"],
  ["box", "Box"],
];

/** Uploads a .srt/.vtt file and returns its URL on our server (same as the subtitle modal) */
async function uploadSubtitleFile(): Promise<string | undefined> {
  const files = await openFileSelector(".srt,.vtt");
  const file = files?.[0];
  if (!file) {
    return undefined;
  }
  const resp = await apiFetch("/subtitle", {
    method: "POST",
    body: await file.text(),
    headers: { "Content-Type": "text/plain" },
  });
  const json = await resp.json();
  return serverPath + "/subtitle/" + json.hash;
}

/**
 * The CC menu: track list (auto tracks from room state first, then the room/embedded tracks), loading a file or URL,
 * the audio track when the converter found several, volume boost / Night mode, the timing offset (6b) and the subtitle
 * style.
 */
export function SubtitlesMenu(props: {
  room: Room;
  tracks: ReturnType<typeof useTextTracks>;
  style: SubtitleStyle;
  setStyle: (patch: Partial<SubtitleStyle>) => void;
  onClose: () => void;
}) {
  const { room, tracks, style, setStyle } = props;
  const { state, player, subtitles, cmd } = room;
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const youtube = player.usingYoutube();
  const offset = effectiveOffset(
    state.roomSubtitleOffset,
    state.localSubtitleOffset,
  );
  const autoTracks = state.subtitleTracks ?? [];
  const roomTrack = tracks.tracks.find((t) => t.fromRoom);
  const off = tracks.selected < 0;
  const ytOn = youtube && player.youtube().isSubtitled();

  const pickRoomSubtitle = (u: string) => {
    cmd.setSubtitle(u);
  };

  return (
    <>
      <div className={styles.menuSection}>
        <div className={styles.menuLabel}>Subtitles</div>
        <div role="menu" aria-label="Subtitle tracks">
          <button
            className={styles.menuItem}
            role="menuitemradio"
            aria-checked={youtube ? !ytOn : off}
            onClick={() => {
              if (youtube) {
                player.youtube().setSubtitleMode("hidden");
              } else {
                player.html().selectSubtitleTrack(-1);
              }
              tracks.refresh();
            }}
          >
            <IconCheck size={16} className={styles.check} />
            <span className={styles.grow}>Off</span>
          </button>
          {youtube ? (
            <button
              className={styles.menuItem}
              role="menuitemradio"
              aria-checked={ytOn}
              onClick={() => {
                player.youtube().setSubtitleMode("showing");
                tracks.refresh();
              }}
            >
              <IconCheck size={16} className={styles.check} />
              <span className={styles.grow}>
                YouTube captions
                <small>Provided by YouTube</small>
              </span>
            </button>
          ) : (
            <>
              {autoTracks.map((t) => (
                <button
                  key={t.id}
                  className={styles.menuItem}
                  role="menuitemradio"
                  aria-checked={
                    state.roomSubtitle === t.url &&
                    !off &&
                    roomTrack?.index === tracks.selected
                  }
                  onClick={() => pickRoomSubtitle(t.url)}
                >
                  <IconCheck size={16} className={styles.check} />
                  <span className={styles.grow}>
                    {t.label}
                    {t.detail && <small>{t.detail}</small>}
                  </span>
                  {t.source !== "manual" && (
                    <span className={styles.badge}>Auto</span>
                  )}
                </button>
              ))}
              {tracks.tracks
                .filter(
                  (t) =>
                    !t.fromRoom ||
                    !autoTracks.some((a) => a.url === state.roomSubtitle),
                )
                .map((t) => (
                  <button
                    key={t.index}
                    className={styles.menuItem}
                    role="menuitemradio"
                    aria-checked={tracks.selected === t.index}
                    onClick={() => {
                      player.html().selectSubtitleTrack(t.index);
                      tracks.refresh();
                      room.subsync.evaluate();
                    }}
                  >
                    <IconCheck size={16} className={styles.check} />
                    <span className={styles.grow}>
                      {t.fromRoom ? "Room subtitles" : t.label}
                      <small>
                        {t.fromRoom
                          ? "Loaded for everyone"
                          : "Embedded in the file"}
                      </small>
                    </span>
                  </button>
                ))}
              <button
                className={styles.menuItem}
                role="menuitem"
                onClick={async () => {
                  const u = await uploadSubtitleFile();
                  if (u) {
                    pickRoomSubtitle(u);
                  }
                }}
              >
                <IconUpload size={16} />
                <span className={styles.grow}>Load a .srt / .vtt file…</span>
              </button>
              <button
                className={styles.menuItem}
                role="menuitem"
                aria-expanded={urlOpen}
                onClick={() => setUrlOpen((v) => !v)}
              >
                <IconLink size={16} />
                <span className={styles.grow}>From a URL…</span>
              </button>
              {urlOpen && (
                <form
                  className={styles.urlRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (url.trim()) {
                      pickRoomSubtitle(url.trim());
                      setUrl("");
                      setUrlOpen(false);
                    }
                  }}
                >
                  <input
                    type="url"
                    aria-label="Subtitle URL"
                    placeholder="https://…/subtitles.vtt"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <button type="submit" className={styles.step}>
                    Load
                  </button>
                </form>
              )}
              {/* Keyless title search (subtitleSearch/); the OpenSubtitles API file-name search is linked from it */}
              <button
                className={styles.menuItem}
                role="menuitem"
                onClick={() => {
                  props.onClose();
                  // The search is a page-level modal; leave fullscreen so it's visible
                  if (player.isFullscreen()) {
                    player.toggleFullscreen();
                  }
                  subtitles.openSearch();
                }}
              >
                <IconSearch size={16} />
                <span className={styles.grow}>Search subtitles…</span>
              </button>
            </>
          )}
        </div>
      </div>

      {state.audioTracks && state.audioTracks.length > 1 && (
        <div className={styles.menuSection}>
          <div className={styles.menuLabel}>Audio</div>
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

      {!youtube && <AudioBoostSection room={room} />}

      {!youtube && (
        <div className={styles.menuSection}>
          <div className={styles.menuLabel}>
            <span id="wp-offset-label">Timing offset</span>
            <button
              className={styles.linkBtn}
              onClick={subtitles.resetOffset}
              aria-label="Reset subtitle offset"
            >
              Reset
            </button>
          </div>
          <div className={styles.offsetRow}>
            <button
              className={styles.step}
              aria-label="Subtitles 0.1 seconds earlier"
              onClick={() => subtitles.nudgeOffset(-0.1)}
            >
              −0.1
            </button>
            <div className={styles.offsetValue}>
              <OffsetInput
                offset={offset}
                onChange={(v) => subtitles.setOffset(v)}
              />
              <small aria-live="polite">{describeOffset(offset)}</small>
              {subtitles.getTiming().scale !== 1 && (
                <small title="Corrects a frame-rate mismatch: subtitles timed for the first rate, video at the second. Reset clears it.">
                  {describeScale(subtitles.getTiming().scale)}
                </small>
              )}
            </div>
            <button
              className={styles.step}
              aria-label="Subtitles 0.1 seconds later"
              onClick={() => subtitles.nudgeOffset(0.1)}
            >
              +0.1
            </button>
          </div>
          <input
            type="range"
            className={`${styles.range} ${styles.offsetSlider}`}
            min={-SUBTITLE_OFFSET_SLIDER_MAX}
            max={SUBTITLE_OFFSET_SLIDER_MAX}
            step={0.1}
            value={Math.max(
              -SUBTITLE_OFFSET_SLIDER_MAX,
              Math.min(SUBTITLE_OFFSET_SLIDER_MAX, offset),
            )}
            aria-labelledby="wp-offset-label"
            aria-valuenow={offset}
            aria-valuetext={formatOffset(offset)}
            style={
              {
                "--pct": `${((offset + SUBTITLE_OFFSET_SLIDER_MAX) / (2 * SUBTITLE_OFFSET_SLIDER_MAX)) * 100}%`,
              } as React.CSSProperties
            }
            onChange={(e) => subtitles.setOffset(Number(e.target.value))}
          />
          <div className={styles.ticks} aria-hidden="true">
            <span>−10 s</span>
            <span>0</span>
            <span>+10 s</span>
          </div>
          <div className={styles.hintRow}>
            <span>Keyboard</span>
            <span>
              <kbd className={styles.kbd}>[</kbd>{" "}
              <kbd className={styles.kbd}>]</kbd> ±0.1 s · or type a value
            </span>
          </div>
          <AutoSyncButton room={room} hasTrack={!off} />
          <div
            className={styles.seg}
            role="group"
            aria-label="Offset applies to"
            style={{ marginTop: 10 }}
          >
            <button
              aria-pressed={state.subtitleScope === "everyone"}
              onClick={() => subtitles.setScope("everyone")}
            >
              <IconUsers size={15} />
              Everyone
            </button>
            <button
              aria-pressed={state.subtitleScope === "me"}
              onClick={() => subtitles.setScope("me")}
            >
              <IconEye size={15} />
              Just me
            </button>
          </div>
          <div className={styles.scopeNote}>
            {state.subtitleScope === "everyone"
              ? "Synced to the room and saved for this file, so it comes back next time it loads."
              : "Only on this device. Reset to follow the room again."}
          </div>
        </div>
      )}

      {!youtube && (
        <div className={styles.menuSection}>
          <div className={styles.menuLabel}>Style</div>
          <div className={styles.styleGrid}>
            <span id="wp-sub-size">Size</span>
            <div
              className={styles.seg}
              role="group"
              aria-labelledby="wp-sub-size"
            >
              {SIZES.map(([v, label]) => (
                <button
                  key={v}
                  aria-pressed={style.size === v}
                  onClick={() => setStyle({ size: v })}
                >
                  {label}
                </button>
              ))}
            </div>
            <span id="wp-sub-bg">Background</span>
            <div
              className={styles.seg}
              role="group"
              aria-labelledby="wp-sub-bg"
            >
              {BACKGROUNDS.map(([v, label]) => (
                <button
                  key={v}
                  aria-pressed={style.background === v}
                  onClick={() => setStyle({ background: v })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The offset value, editable: click it and type seconds ("-45.5") or minutes:seconds ("1:30"), then Enter. Esc or an
 * invalid value puts the current offset back. Larger than the slider's ±10 s is fine.
 */
function OffsetInput({
  offset,
  onChange,
}: {
  offset: number;
  onChange: (offset: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) {
      const parsed = parseOffsetInput(draft);
      if (parsed !== undefined && parsed !== offset) {
        onChange(parsed);
      }
    }
    setDraft(null);
  };
  return (
    <input
      className={styles.offsetInput}
      type="text"
      inputMode="decimal"
      spellCheck={false}
      aria-label="Subtitle offset in seconds"
      title="Type an offset in seconds (e.g. -45.5) or minutes:seconds (1:30)"
      value={draft ?? formatOffset(offset)}
      onFocus={(e) => {
        setDraft(offset === 0 ? "0" : String(offset));
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          // Revert without closing the menu
          e.stopPropagation();
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
