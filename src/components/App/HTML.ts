import { Player } from "./Player";
import { apiFetch } from "../../utils/api";
import { retimeCues, toWebVtt, type CueLike } from "./logic/subtitles";
import { decodeSubtitleBytes } from "./logic/subtitleText";
import { AudioBoost, isBoostActive } from "./audioBoost";

export interface SubtitleTrackInfo {
  index: number;
  label: string;
  language: string;
  /** Added from the room subtitle URL (vs. embedded in the media) */
  fromRoom: boolean;
}

/**
 * The <video> player. Subtitles: the selected TextTrack is kept in "hidden" mode (cues fire but the browser doesn't
 * draw them) and the player overlay renders the active cues itself, so size/background/position follow the redesign.
 * Offsets re-time the cues in place from their original times (logic/subtitles.ts retimeCues).
 */
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class HTML implements Player {
  elId: string;
  /** Index into textTracks of the track to show (-1 = none) */
  private selectedTrack = 0;
  private subtitlesEnabled = false;
  /** User/room offset and the screen-sharer correction, in seconds */
  private subtitleOffset = 0;
  /** Time scale for frame-rate drift: cues show at original × scale + offset */
  private subtitleScale = 1;
  private sharerShift = 0;
  private cueOriginals = new WeakMap<CueLike, { start: number; end: number }>();
  /** The <track> element we added for the room subtitle */
  private roomTrack: TextTrack | null = null;
  /** Voice call ducking factor and the viewer's own volume while ducked (see setDuck) */
  private duck = 1;
  private userVolume: number | null = null;
  /** Volume boost / Night mode (audioBoost.ts) */
  readonly boost: AudioBoost;
  /** Called when the boosted element can't play a new source (see AudioBoost.prepareLoad); usePlayer reloads */
  onBoostBlocked: (() => void) | null = null;
  /** Bumped by every load, so a slow boost check never applies an outdated source */
  private loadGen = 0;

  constructor(elId: string) {
    this.elId = elId;
    this.boost = new AudioBoost(() => this.getVideoEl());
  }

  getVideoEl = (): HTMLMediaElement => {
    return document.getElementById(this.elId) as HTMLMediaElement;
  };

  getCurrentTime = () => {
    return this.getVideoEl()?.currentTime ?? 0;
  };

  getDuration = () => {
    return this.getVideoEl()?.duration ?? 0;
  };

  isMuted = () => {
    return this.getVideoEl()?.muted ?? false;
  };

  isSubtitled = () => {
    return this.getSubtitleMode() === "showing";
  };

  getPlaybackRate = (): number => {
    return this.getVideoEl()?.playbackRate ?? 1;
  };

  setPlaybackRate = (rate: number) => {
    if (this.getVideoEl()) {
      this.getVideoEl().playbackRate = rate;
    }
  };

  setSrcAndTime = async (src: string, time: number) => {
    const gen = ++this.loadGen;
    const leftVideo = this.getVideoEl();
    if (leftVideo && !this.boost.bound && !isBoostActive(this.boost.settings)) {
      // Boost off: load the way the element always has (no CORS mode)
      leftVideo.removeAttribute("crossorigin");
    } else if (leftVideo) {
      const ok = await this.boost.prepareLoad(leftVideo, src);
      if (gen !== this.loadGen) {
        return;
      }
      if (!ok) {
        this.onBoostBlocked?.();
        return;
      }
    }
    if (leftVideo) {
      leftVideo.currentTime = time;
      leftVideo.src = src;
    }
  };

  playVideo = async () => {
    if (this.getVideoEl()) {
      await this.getVideoEl().play();
    }
  };

  pauseVideo = () => {
    if (this.getVideoEl()) {
      this.getVideoEl().pause();
    }
  };

  seekVideo = (time: number) => {
    if (this.getVideoEl()) {
      this.getVideoEl().currentTime = time;
    }
  };

  shouldPlay = () => {
    const leftVideo = this.getVideoEl();
    return Boolean(leftVideo?.paused || leftVideo?.ended);
  };

  setMute = (muted: boolean) => {
    const leftVideo = this.getVideoEl();
    if (leftVideo) {
      leftVideo.muted = muted;
    }
    const audio = document.getElementById("iPhoneAudio") as HTMLAudioElement;
    if (audio) {
      audio.muted = muted;
    }
  };

  setVolume = (volume: number) => {
    this.userVolume = volume;
    if (this.getVideoEl()) {
      this.getVideoEl().volume = clamp01(volume * this.duck);
    }
  };

  getVolume = (): number => {
    if (this.duck !== 1 && this.userVolume !== null) {
      return this.userVolume;
    }
    return this.getVideoEl()?.volume ?? 1;
  };

  setDuck = (factor: number) => {
    const el = this.getVideoEl();
    if (this.duck === 1 || this.userVolume === null) {
      // Not ducked yet: the element's volume is the viewer's own
      this.userVolume = el?.volume ?? 1;
    }
    this.duck = factor;
    if (el) {
      el.volume = clamp01(this.userVolume * factor);
    }
  };

  /** mode "showing" turns subtitles on, "hidden" off; no mode toggles */
  setSubtitleMode = (mode?: TextTrackMode) => {
    this.subtitlesEnabled =
      mode === undefined ? !this.subtitlesEnabled : mode === "showing";
    this.applyTrackModes();
  };

  getSubtitleMode = (): TextTrackMode => {
    return this.subtitlesEnabled && this.getActiveSubtitleTrack()
      ? "showing"
      : "hidden";
  };

  getSubtitleTracks = (): SubtitleTrackInfo[] => {
    const tracks = this.getVideoEl()?.textTracks;
    const list: SubtitleTrackInfo[] = [];
    for (let i = 0; i < (tracks?.length ?? 0); i++) {
      const t = tracks[i];
      if (t.kind === "metadata" || t.kind === "chapters") {
        continue;
      }
      list.push({
        index: i,
        label: t.label || t.language || `Track ${i + 1}`,
        language: t.language,
        fromRoom: t === this.roomTrack,
      });
    }
    return list;
  };

  /** Shows the track at this textTracks index, or turns subtitles off with -1 */
  selectSubtitleTrack = (index: number) => {
    this.selectedTrack = index;
    this.subtitlesEnabled = index >= 0;
    this.applyTrackModes();
  };

  /**
   * The cues of a track at their original times (before any offset or sharer correction): what auto-sync aligns.
   * Empty while the track's cues haven't loaded.
   */
  getOriginalCues = (
    index = this.getSelectedSubtitleTrack(),
  ): { start: number; end: number }[] => {
    const cues = index >= 0 ? this.getVideoEl()?.textTracks[index]?.cues : null;
    if (!cues) {
      return [];
    }
    return Array.from(cues, (cue) => {
      const orig = this.cueOriginals.get(cue);
      return orig
        ? { start: orig.start, end: orig.end }
        : { start: cue.startTime, end: cue.endTime };
    });
  };

  getSelectedSubtitleTrack = () =>
    this.subtitlesEnabled ? this.selectedTrack : -1;

  /** The TextTrack whose active cues the overlay renders, if subtitles are on */
  getActiveSubtitleTrack = (): TextTrack | undefined => {
    if (!this.subtitlesEnabled) {
      return undefined;
    }
    return this.getVideoEl()?.textTracks[this.selectedTrack];
  };

  private applyTrackModes = () => {
    const tracks = this.getVideoEl()?.textTracks;
    for (let i = 0; i < (tracks?.length ?? 0); i++) {
      const want: TextTrackMode =
        this.subtitlesEnabled && i === this.selectedTrack
          ? "hidden"
          : "disabled";
      if (tracks[i].mode !== want) {
        tracks[i].mode = want;
      }
    }
    this.applyCueShift();
  };

  /** Room or "just me" subtitle offset in seconds (positive = later) and time scale (frame-rate drift, 1 = none) */
  setSubtitleOffset = (offset: number, scale = 1) => {
    this.subtitleOffset = offset;
    this.subtitleScale = scale;
    this.applyCueShift();
  };

  /** Re-times the cues of every loaded track to the current total shift */
  applyCueShift = () => {
    const tracks = this.getVideoEl()?.textTracks;
    const shift = this.subtitleOffset + this.sharerShift;
    for (let i = 0; i < (tracks?.length ?? 0); i++) {
      const cues = tracks[i].cues;
      if (cues?.length) {
        retimeCues(cues, shift, this.cueOriginals, this.subtitleScale);
      }
    }
  };

  isReady = () => {
    return Boolean(this.getVideoEl());
  };

  clearState = () => {
    this.loadGen++;
    const leftVideo = this.getVideoEl();

    // Clear src and srcObject
    leftVideo.src = "";
    leftVideo.srcObject = null;

    // Clear subtitles
    this.subtitlesEnabled = false;
    this.selectedTrack = 0;
    this.sharerShift = 0;
    this.roomTrack = null;
    leftVideo.innerHTML = "";
  };

  loadSubtitles = async (src: string) => {
    const leftVideo = this.getVideoEl();
    if (!leftVideo) {
      return;
    }
    // Clear subtitles and put new ones in
    leftVideo.innerHTML = "";
    this.roomTrack = null;
    if (!src) {
      this.subtitlesEnabled = false;
      this.applyTrackModes();
    }
    if (Boolean(src)) {
      let subtitleSrc = src;
      if (subtitleSrc) {
        const response = await apiFetch(subtitleSrc);
        const vtt = toWebVtt(decodeSubtitleBytes(await response.arrayBuffer()));
        const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        const track = document.createElement("track");
        track.kind = "captions";
        track.label = "English";
        track.srclang = "en";
        track.src = url;
        // Cues load asynchronously: apply the current offset once they're in
        track.addEventListener("load", () => this.applyCueShift());
        leftVideo.appendChild(track);
        this.roomTrack = track.track;
        const index = Array.from(leftVideo.textTracks).indexOf(track.track);
        this.selectSubtitleTrack(index >= 0 ? index : 0);
      }
    }
  };

  syncSubtitles = (sharerTime: number) => {
    // When someone shares their screen, our timestamp doesn't match the subtitles, so shift them by the difference
    const leftVideo = this.getVideoEl();
    if (!leftVideo || !Number.isFinite(sharerTime)) {
      return;
    }
    const shift = leftVideo.currentTime - sharerTime;
    if (shift && shift !== this.sharerShift) {
      this.sharerShift = shift;
      this.applyCueShift();
    }
  };

  getTimeRanges = (): { start: number; end: number }[] => {
    const leftVideo = this.getVideoEl();
    const buffers = [];
    const rangeCount = leftVideo?.buffered.length;
    for (let i = 0; i < rangeCount; i++) {
      const start = leftVideo?.buffered.start(i);
      const end = leftVideo?.buffered.end(i);
      buffers.push({ start, end });
    }
    return buffers;
  };

  setLoop = (loop: boolean): void => {
    const leftVideo = this.getVideoEl();
    leftVideo.loop = loop;
  };
}
