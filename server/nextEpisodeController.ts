/**
 * Room-wide, server-authoritative "next episode" card (PLAN 6d).
 *
 * Flow for one video:
 *   idle ──CMD:nextEpisode {action:"offer", url, time, duration}──▶ resolving
 *     (any viewer whose player is within `offset` seconds of the end sends it; only the first one counts)
 *   resolving ──found──▶ offered (REC:nextEpisode {state:"offered", next, startAt})
 *   resolving ──no next episode──▶ done (nothing is shown: finale, not aired yet)
 *   resolving ──lookup failed / no playable stream──▶ done (REC:nextEpisode {state:"failed"}: a toast)
 *   offered ──cancel──▶ cancelled (REC:nextEpisode {state:"cancelled", by}; stays cancelled for this video)
 *   offered ──playNow / video ended / room time reached startAt──▶ starting → the next episode is hosted
 *   offered ──someone seeks back before the card's window, a queue item is added, loop turns on──▶ idle (none)
 *   any ──the room's video changes──▶ idle (none)
 *
 * Timing: `startAt` is the video's duration as reported by the first offer, in video seconds, so each client's
 * countdown is `startAt - its own currentTime` and pausing the room pauses the countdown. The next episode starts at
 * whichever comes first: a viewer's player firing `ended` (the file was shorter than reported), or the room's time
 * (max of the CMD:ts reports) reaching `startAt` (a player that never fires `ended`).
 */
import type { NextEpisodeResolver } from "./addons/nextEpisode.ts";
import { isEpisodeMeta } from "./addons/nextEpisode.ts";

/** Offers are accepted a little before the window (clients report once a second) */
const OFFER_SLACK_S = 2;
/** The room's time counts as "ended" this close to startAt (CMD:ts is sent once a second) */
const END_EPSILON_S = 0.75;
/** Seeking back further than this before the window withdraws the card */
const SEEK_BACK_S = 5;

type Pending = { url: string; next: NextEpisodeInfo };

type Phase =
  | { phase: "idle" }
  | {
      phase: "resolving";
      video: string;
      startAt: number;
      /** Someone pressed Play now / the video ended before the lookup finished */
      startWhenReady: { by: PlaybackActor | null } | null;
    }
  | { phase: "offered"; video: string; startAt: number; pending: Pending }
  | { phase: "cancelled"; video: string }
  /** Started, no next episode, or failed: nothing more happens for this video */
  | { phase: "done"; video: string };

export interface NextEpisodeHost {
  /** The room's current video URL */
  video(): string | null;
  videoMeta(): VideoMeta | null;
  playlistLength(): number;
  loop(): boolean;
  /** Seconds before the end at which the card shows (RoomSettings.nextEpisodeOffset) */
  offset(): number;
  resolver(): NextEpisodeResolver | null;
  emit(state: NextEpisodeState): void;
  /** Hosts the next episode for the whole room (by = who pressed Play now, null when automatic) */
  play(url: string, meta: VideoMeta, by: PlaybackActor | null): void;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export class NextEpisodeController {
  private host: NextEpisodeHost;
  private state: Phase = { phase: "idle" };

  constructor(host: NextEpisodeHost) {
    this.host = host;
  }

  /** What a viewer who just connected should see (only a live card; cancelled/failed are one-off events) */
  public snapshot(): NextEpisodeState {
    const s = this.state;
    if (s.phase === "offered" && s.video === this.host.video()) {
      return { state: "offered", next: s.pending.next, startAt: s.startAt };
    }
    return { state: "none" };
  }

  /** CMD:nextEpisode handler. `raw` is untrusted. */
  public command(raw: unknown, by: PlaybackActor) {
    if (!isObject(raw)) {
      return;
    }
    switch (raw.action) {
      case "offer":
        return this.offer(raw.url, raw.time, raw.duration);
      case "ended":
        return this.ended(raw.url);
      case "playNow":
        return this.playNow(by);
      case "cancel":
        return this.cancel(by);
    }
  }

  /** The room's video changed: forget everything about the old one (clients go back to "none" too) */
  public reset() {
    const wasIdle = this.state.phase === "idle";
    this.state = { phase: "idle" };
    if (!wasIdle) {
      this.host.emit({ state: "none" });
    }
  }

  /** Called with the room's time after every CMD:ts */
  public tick(roomTime: number) {
    const s = this.state;
    if (s.phase !== "offered" || !this.current(s.video)) {
      return;
    }
    if (this.blocked()) {
      // An explicit queue (or loop) wins over the next episode
      this.withdraw();
      return;
    }
    if (roomTime >= s.startAt - END_EPSILON_S) {
      this.start(null);
    }
  }

  /** Called on CMD:seek: seeking back before the card's window withdraws it (it comes back near the end) */
  public seek(time: number) {
    const s = this.state;
    if (
      (s.phase === "offered" || s.phase === "resolving") &&
      time < s.startAt - this.host.offset() - SEEK_BACK_S
    ) {
      this.withdraw();
    }
  }

  private current(video: string) {
    return video === this.host.video();
  }

  private blocked() {
    return this.host.playlistLength() > 0 || this.host.loop();
  }

  private withdraw() {
    const wasOffered = this.state.phase === "offered";
    this.state = { phase: "idle" };
    if (wasOffered) {
      this.host.emit({ state: "none" });
    }
  }

  private offer(url: unknown, time: unknown, duration: unknown) {
    const video = this.host.video();
    const meta = this.host.videoMeta();
    const resolver = this.host.resolver();
    if (
      this.state.phase !== "idle" ||
      !video ||
      url !== video ||
      !isEpisodeMeta(meta) ||
      !resolver ||
      this.blocked() ||
      !finite(time) ||
      !finite(duration) ||
      time < 0 ||
      duration <= 0 ||
      time > duration + 1 ||
      duration - time > this.host.offset() + OFFER_SLACK_S
    ) {
      return;
    }
    const resolving: Phase = {
      phase: "resolving",
      video,
      startAt: duration,
      startWhenReady: null,
    };
    this.state = resolving;
    resolver(meta)
      .catch(() => ({ kind: "failed" as const, meta: null, thumbnail: null }))
      .then((result) => {
        // Dropped if the video changed, the room seeked back, or anything else moved on meanwhile
        if (this.state !== resolving || !this.current(video)) {
          return;
        }
        if (result.kind === "none") {
          this.state = { phase: "done", video };
          return;
        }
        if (result.kind === "failed") {
          this.state = { phase: "done", video };
          this.host.emit({
            state: "failed",
            next: result.meta
              ? { meta: result.meta, thumbnail: result.thumbnail }
              : null,
          });
          return;
        }
        const pending: Pending = {
          url: result.url,
          next: { meta: result.meta, thumbnail: result.thumbnail },
        };
        const startWhenReady = resolving.startWhenReady;
        this.state = {
          phase: "offered",
          video,
          startAt: resolving.startAt,
          pending,
        };
        if (startWhenReady) {
          this.start(startWhenReady.by);
          return;
        }
        this.host.emit({
          state: "offered",
          next: pending.next,
          startAt: resolving.startAt,
        });
      });
  }

  private ended(url: unknown) {
    const s = this.state;
    if (typeof url !== "string" || s.phase === "idle" || s.video !== url) {
      return;
    }
    if (!this.current(url)) {
      return;
    }
    if (s.phase === "resolving") {
      s.startWhenReady ??= { by: null };
    } else if (s.phase === "offered") {
      this.start(null);
    }
  }

  private playNow(by: PlaybackActor) {
    const s = this.state;
    if (s.phase === "idle" || !this.current(s.video)) {
      return;
    }
    if (s.phase === "resolving") {
      s.startWhenReady = { by };
    } else if (s.phase === "offered") {
      this.start(by);
    }
  }

  private cancel(by: PlaybackActor) {
    const s = this.state;
    if (
      (s.phase !== "offered" && s.phase !== "resolving") ||
      !this.current(s.video)
    ) {
      return;
    }
    this.state = { phase: "cancelled", video: s.video };
    this.host.emit({ state: "cancelled", by });
  }

  private start(by: PlaybackActor | null) {
    const s = this.state;
    if (s.phase !== "offered") {
      return;
    }
    if (this.blocked()) {
      this.withdraw();
      return;
    }
    this.state = { phase: "done", video: s.video };
    this.host.emit({ state: "starting", next: s.pending.next, by });
    // Hosting the new video calls reset(), which leaves us idle for it
    this.host.play(s.pending.url, s.pending.next.meta, by);
  }
}
