export abstract class Player {
  public abstract getCurrentTime: () => number;
  public abstract getDuration: () => number;
  public abstract isMuted: () => boolean;
  public abstract getPlaybackRate: () => number;
  public abstract setPlaybackRate: (rate: number) => void;
  public abstract setSrcAndTime: (src: string, time: number) => Promise<void>;
  public abstract playVideo: () => Promise<void>;
  public abstract pauseVideo: () => void;
  public abstract seekVideo: (time: number) => void;
  public abstract shouldPlay: () => boolean;
  public abstract setMute: (muted: boolean) => void;
  public abstract getVolume: () => number;
  public abstract setVolume: (volume: number) => void;
  /**
   * Voice call ducking: plays at the viewer's volume × factor (1 = normal). getVolume/setVolume keep working with
   * the viewer's own volume, so ducking never overwrites it.
   */
  public abstract setDuck: (factor: number) => void;
  public abstract isSubtitled: () => boolean;
  public abstract getSubtitleMode: () => TextTrackMode;
  public abstract setSubtitleMode: (mode?: TextTrackMode) => void;
  public abstract isReady: () => boolean;
  public abstract clearState: () => void;
  public abstract loadSubtitles: (src: string) => void;
  public abstract syncSubtitles: (sharerTime: number) => void;
  /** Subtitle offset in seconds (positive = later). No-op where it isn't supported (YouTube). */
  public abstract setSubtitleOffset: (offset: number) => void;
  public abstract getTimeRanges: () => { start: number; end: number }[];
  public abstract setLoop: (loop: boolean) => void;
  public abstract getVideoEl: () => HTMLMediaElement;
}
