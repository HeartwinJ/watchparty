/**
 * Volume boost and Night mode for the <video> element (per device, never sent to the room).
 *
 * Browsers cap element volume at 100 %, so louder means routing the element's audio through Web Audio:
 *   source → night compressor → gain (boost × night make-up) → limiter → speakers
 * The element's own volume, mute and call ducking still apply before the source node.
 *
 * Two browser rules shape this:
 * - createMediaElementSource() is permanent for an element. Once bound, every later source must be readable by Web
 *   Audio (same origin, blob/MSE, MediaStream, or loaded with CORS), or the browser plays silence. HTML.setSrcAndTime
 *   calls prepareLoad() first: cross-origin links are loaded with crossorigin="anonymous" when their server allows
 *   it, and anything else makes the page reload so that video plays normally without the boost.
 * - An AudioContext only runs after a user gesture. We never bind while it's suspended (the movie would go silent);
 *   instead we wait for the next click or key press. If a running context gets suspended later (iOS interruptions),
 *   the next gesture resumes it.
 * Nothing here runs until someone turns the boost or Night mode on.
 */

export interface BoostSettings {
  /** Gain on top of the element volume: 1 = off */
  level: number;
  /** Compress the dynamic range: quieter loud scenes, louder speech */
  night: boolean;
}

/**
 * off: not in use. on: applied. idle: on, waiting for a video. pending: on, waiting for a click or key press (the
 * browser blocks audio until then). unavailable: this video can't be boosted (its server doesn't allow it).
 */
export type BoostStatus = "off" | "on" | "idle" | "pending" | "unavailable";

export const BOOST_LEVELS = [1, 1.5, 2, 3] as const;
export const VOLUME_BOOST_KEY = "wp-volume-boost";
export const NIGHT_MODE_KEY = "wp-night-mode";
/** sessionStorage flag: the page reloaded to play a video the boost can't handle ("1", or "off" if it turned it off) */
export const BOOST_RELOAD_KEY = "wp-boost-reload";
/** sessionStorage: when that last happened (ms), so a second one in a row turns the boost off instead of looping */
export const BOOST_RELOAD_AT_KEY = "wp-boost-reload-at";
export const BOOST_RELOAD_LOOP_MS = 30_000;

/** Night mode: a gentle compressor plus make-up gain (≈ +6 dB) so speech comes up and peaks come down */
export const NIGHT = {
  threshold: -28,
  knee: 10,
  ratio: 6,
  attack: 0.005,
  release: 0.25,
  makeup: 2,
};
/** The output limiter keeps boosted peaks from clipping */
export const LIMITER = {
  threshold: -1,
  knee: 0,
  ratio: 20,
  attack: 0.001,
  release: 0.1,
};

export const isBoostActive = (s: BoostSettings) => s.level > 1 || s.night;

/** Total gain after the night compressor */
export const boostGain = (s: BoostSettings) =>
  s.level * (s.night ? NIGHT.makeup : 1);

export function parseBoostLevel(raw: string | null | undefined): number {
  const n = Number(raw);
  return (BOOST_LEVELS as readonly number[]).includes(n) ? n : 1;
}

export function readBoostSettings(): BoostSettings {
  try {
    return {
      level: parseBoostLevel(window.localStorage.getItem(VOLUME_BOOST_KEY)),
      night: window.localStorage.getItem(NIGHT_MODE_KEY) === "1",
    };
  } catch {
    return { level: 1, night: false };
  }
}

export function saveBoostSettings(s: BoostSettings) {
  try {
    window.localStorage.setItem(VOLUME_BOOST_KEY, String(s.level));
    window.localStorage.setItem(NIGHT_MODE_KEY, s.night ? "1" : "0");
  } catch {
    // Not persisted (private mode)
  }
}

/** A short label for the control bar, e.g. "200%", "Night", "150% · Night" */
export function describeBoost(s: BoostSettings): string {
  const parts: string[] = [];
  if (s.level > 1) {
    parts.push(`${Math.round(s.level * 100)}%`);
  }
  if (s.night) {
    parts.push("Night");
  }
  return parts.join(" · ");
}

/**
 * Where a source URL's audio comes from, as far as Web Audio is concerned:
 * - none: no source
 * - local: same origin, blob: (MSE, local files) or data: — always readable
 * - cross-origin: readable only if loaded with CORS
 * - native-hls: .m3u8 played by the browser itself (Safari), which Web Audio can't reliably read
 */
export type SourceKind = "none" | "local" | "cross-origin" | "native-hls";

export function classifySource(src: string, origin: string): SourceKind {
  if (!src) {
    return "none";
  }
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    return "cross-origin";
  }
  if (url.protocol === "blob:" || url.protocol === "data:") {
    return "local";
  }
  if (/\.m3u8$/i.test(url.pathname)) {
    return "native-hls";
  }
  return url.origin === origin ? "local" : "cross-origin";
}

/** The element's source URL, or "" when it has none (src="" would otherwise resolve to the page URL) */
export const mediaSource = (el: HTMLMediaElement) =>
  el.getAttribute("src") === "" ? "" : el.currentSrc || el.src;

/** Whether Web Audio can read what the element is playing right now (without it, the output is silence) */
export function audioTapState(
  el: HTMLMediaElement,
  origin: string,
): "none" | "ok" | "blocked" {
  if (el.srcObject) {
    return "ok";
  }
  const kind = classifySource(mediaSource(el), origin);
  // Only once media has actually loaded: an emptied element (src="" resolves to the page's own URL) must never bind
  if (kind === "none" || el.readyState < 1) {
    return "none";
  }
  if (kind === "local") {
    return "ok";
  }
  if (kind === "cross-origin" && el.crossOrigin !== null) {
    // Loaded in CORS mode: if it plays at all, it's readable
    return "ok";
  }
  return "blocked";
}

/** Whether the server lets this page read the file (a 1-byte CORS request). Never logs the URL. */
export async function corsReadable(
  src: string,
  timeoutMs = 6000,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(src, {
      mode: "cors",
      credentials: "omit",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

function defaultContext(): AudioContext | null {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return Ctx ? new Ctx() : null;
}

interface Graph {
  night: DynamicsCompressorNode;
  gain: GainNode;
}

export class AudioBoost {
  settings: BoostSettings = { level: 1, night: false };
  status: BoostStatus = "off";
  onStatus: ((status: BoostStatus) => void) | null = null;
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private listening = false;
  /** The last source checked for CORS by reloadWithCors (checked once per source) */
  private corsChecked: string | null = null;
  private readonly getEl: () => HTMLMediaElement | null;
  private readonly createContext: () => AudioContext | null;
  private readonly checkCors: (src: string) => Promise<boolean>;
  private readonly origin: () => string;

  constructor(
    getEl: () => HTMLMediaElement | null,
    opts: {
      createContext?: () => AudioContext | null;
      corsReadable?: (src: string) => Promise<boolean>;
      origin?: () => string;
    } = {},
  ) {
    this.getEl = getEl;
    this.createContext = opts.createContext ?? defaultContext;
    this.checkCors = opts.corsReadable ?? ((src) => corsReadable(src));
    this.origin = opts.origin ?? (() => window.location.origin);
  }

  /** The element's audio goes through Web Audio (permanent for this element) */
  get bound() {
    return this.graph !== null;
  }

  set = (patch: Partial<BoostSettings>) => {
    this.settings = { ...this.settings, ...patch };
    this.refresh();
  };

  /** Binds when possible, applies the settings and updates the status. Safe to call often. */
  refresh = () => {
    const active = isBoostActive(this.settings);
    const ctx = this.ctx;
    if (this.graph && ctx) {
      this.applyParams();
      const running = this.ensureRunning(ctx);
      this.setStatus(!active ? "off" : running ? "on" : "pending");
      return;
    }
    if (!active) {
      this.stopListening();
      this.setStatus("off");
      return;
    }
    const el = this.getEl();
    const tap = el ? audioTapState(el, this.origin()) : "none";
    if (!el || tap === "none") {
      this.setStatus("idle");
      return;
    }
    if (tap === "blocked") {
      const src = mediaSource(el);
      const kind = classifySource(src, this.origin());
      if (kind === "cross-origin" && el.crossOrigin === null) {
        // Maybe its server allows CORS: check, and reload it in CORS mode if so
        if (this.corsChecked !== src) {
          this.setStatus("idle");
          void this.reloadWithCors(el);
          return;
        }
      }
      this.setStatus("unavailable");
      return;
    }
    this.ctx ??= this.createContext();
    if (!this.ctx) {
      this.setStatus("unavailable");
      return;
    }
    this.ctx.onstatechange = () => this.refresh();
    if (!this.ensureRunning(this.ctx)) {
      // Binding now would mute the movie until the browser lets audio start
      this.setStatus("pending");
      return;
    }
    this.graph = this.build(this.ctx, el);
    this.applyParams();
    this.setStatus("on");
  };

  /**
   * Before the element loads `src`. While the boost is on (or bound), cross-origin links whose server allows it are
   * loaded with crossorigin="anonymous" so Web Audio can read them; otherwise the element loads as it always has.
   * Returns false only when the bound element can't play `src` (the caller then reloads the page).
   */
  prepareLoad = async (el: HTMLMediaElement, src: string) => {
    const bound = this.bound;
    if (!bound && !isBoostActive(this.settings)) {
      el.removeAttribute("crossorigin");
      return true;
    }
    const kind = classifySource(src, this.origin());
    if (kind === "none" || kind === "local") {
      return true;
    }
    if (kind === "cross-origin" && (await this.checkCors(src))) {
      el.crossOrigin = "anonymous";
      return true;
    }
    if (bound) {
      return false;
    }
    el.removeAttribute("crossorigin");
    return true;
  };

  /**
   * The boost was turned on during a cross-origin video loaded without CORS: if its server allows CORS, load it again
   * in CORS mode where it was (the next loadedmetadata binds), else it's unavailable for this video.
   */
  private async reloadWithCors(el: HTMLMediaElement) {
    const src = mediaSource(el);
    if (this.corsChecked === src) {
      return;
    }
    this.corsChecked = src;
    const ok = await this.checkCors(src);
    if (mediaSource(el) !== src) {
      return;
    }
    if (!isBoostActive(this.settings)) {
      // Turned off meanwhile: check again if it's turned back on
      this.corsChecked = null;
      return;
    }
    if (!ok) {
      this.setStatus("unavailable");
      return;
    }
    const time = el.currentTime;
    const paused = el.paused;
    el.crossOrigin = "anonymous";
    el.src = src;
    el.currentTime = time;
    if (!paused) {
      el.play().catch(() => {});
    }
  }

  /**
   * Stops listening for gestures and, once the element has left the page, closes the AudioContext. While the element
   * is still in the page (e.g. React re-running effects) the graph stays: the element is bound to it for good.
   */
  dispose = () => {
    this.stopListening();
    if (this.graph && this.getEl()?.isConnected) {
      return;
    }
    if (this.ctx) {
      this.ctx.onstatechange = null;
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.graph = null;
  };

  private build(ctx: AudioContext, el: HTMLMediaElement): Graph {
    const source = ctx.createMediaElementSource(el);
    const night = ctx.createDynamicsCompressor();
    const gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    source.connect(night);
    night.connect(gain);
    gain.connect(limiter);
    limiter.connect(ctx.destination);
    return { night, gain };
  }

  private applyParams() {
    const { night, gain } = this.graph!;
    const on = this.settings.night;
    // Off = a transparent compressor (ratio 1 at 0 dB)
    night.threshold.value = on ? NIGHT.threshold : 0;
    night.knee.value = on ? NIGHT.knee : 0;
    night.ratio.value = on ? NIGHT.ratio : 1;
    night.attack.value = NIGHT.attack;
    night.release.value = NIGHT.release;
    gain.gain.value = boostGain(this.settings);
  }

  /** True if running; otherwise asks to resume now and on the next gesture */
  private ensureRunning(ctx: AudioContext) {
    if (ctx.state === "running") {
      this.stopListening();
      return true;
    }
    ctx.resume().catch(() => {});
    this.listen();
    return false;
  }

  private onGesture = () => {
    // Must run synchronously inside the gesture for the browser to allow it
    this.ctx?.resume().then(this.refresh, () => {});
  };

  private listen() {
    if (this.listening) {
      return;
    }
    this.listening = true;
    document.addEventListener("pointerdown", this.onGesture, true);
    document.addEventListener("keydown", this.onGesture, true);
  }

  private stopListening() {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    document.removeEventListener("pointerdown", this.onGesture, true);
    document.removeEventListener("keydown", this.onGesture, true);
  }

  private setStatus(status: BoostStatus) {
    if (status !== this.status) {
      this.status = status;
      this.onStatus?.(status);
    }
  }
}
