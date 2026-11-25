import { Player } from "./Player";
import { apiFetch } from "../../utils/api";
import { retimeCues, toWebVtt, type CueLike } from "./logic/subtitles";

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
export class HTML implements Player {
  elId: string;
  /** Index into textTracks of the track to show (-1 = none) */
  private selectedTrack = 0;
  private subtitlesEnabled = false;
  /** User/room offset and the screen-sharer correction, in seconds */
  private subtitleOffset = 0;
  private sharerShift = 0;
  private cueOriginals = new WeakMap<CueLike, { start: number; end: number }>();
  /** The <track> element we added for the room subtitle */
  private roomTrack: TextTrack | null = null;

  constructor(elId: string) {
    this.elId = elId;
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
    const leftVideo = this.getVideoEl();
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
    if (this.getVideoEl()) {
      this.getVideoEl().volume = volume;
    }
  };

  getVolume = (): number => {
    return this.getVideoEl()?.volume ?? 1;
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

  /** Room or "just me" subtitle offset in seconds (positive = later) */
  setSubtitleOffset = (offset: number) => {
    this.subtitleOffset = offset;
    this.applyCueShift();
  };

  /** Re-times the cues of every loaded track to the current total shift */
  applyCueShift = () => {
    const tracks = this.getVideoEl()?.textTracks;
    const shift = this.subtitleOffset + this.sharerShift;
    for (let i = 0; i < (tracks?.length ?? 0); i++) {
      const cues = tracks[i].cues;
      if (cues?.length) {
        retimeCues(cues, shift, this.cueOriginals);
      }
    }
  };

  isReady = () => {
    return Boolean(this.getVideoEl());
  };

  clearState = () => {
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
        const vtt = toWebVtt(await response.text());
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
