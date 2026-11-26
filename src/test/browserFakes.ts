// Small fakes for browser APIs that happy-dom lacks (media streams, WebRTC, WebAudio, layout observers, fullscreen,
// visualViewport, matchMedia). Each `install*` stubs a global with `vi.stubGlobal`/`defineProperty`; call
// `vi.unstubAllGlobals()` (or the returned restore function) in `afterEach` when a test needs a clean window.
import { vi, type Mock } from "vitest";

// --- Media ---

export class FakeTrack {
  kind: string;
  id: string;
  enabled = true;
  readyState: "live" | "ended" = "live";
  muted = false;
  label: string;
  contentHint = "";
  onended: (() => void) | null = null;
  private listeners = new Map<string, Set<(e?: unknown) => void>>();
  private static seq = 0;
  constructor(kind = "audio", label?: string) {
    this.kind = kind;
    this.id = `${kind}-${++FakeTrack.seq}`;
    this.label = label ?? (kind === "video" ? "Desk cam" : "Desk mic");
  }
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = () =>
    this.kind === "video"
      ? { deviceId: "cam-1", height: 720, width: 1280 }
      : { deviceId: "mic-1" };
  getConstraints = () => ({});
  applyConstraints = vi.fn(async () => {});
  clone = () => new FakeTrack(this.kind, this.label);
  addEventListener(type: string, fn: (e?: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e?: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  /** Fires `type` (e.g. "ended", "mute") on the listeners and the `on<type>` handler */
  dispatch(type: string) {
    if (type === "ended") this.readyState = "ended";
    this.listeners.get(type)?.forEach((fn) => fn({ type }));
    const handler = (this as any)[`on${type}`];
    if (typeof handler === "function") handler({ type });
  }
}

export class FakeStream {
  id = `stream-${Math.random().toString(36).slice(2)}`;
  tracks: FakeTrack[];
  active = true;
  constructor(tracks: FakeTrack[] | FakeStream = []) {
    this.tracks = Array.isArray(tracks) ? [...tracks] : [...tracks.tracks];
  }
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks.filter((t) => t.kind === "audio");
  getVideoTracks = () => this.tracks.filter((t) => t.kind === "video");
  addTrack = (t: FakeTrack) => {
    this.tracks.push(t);
  };
  removeTrack = (t: FakeTrack) => {
    this.tracks = this.tracks.filter((x) => x !== t);
  };
  clone = () => new FakeStream(this.tracks.map((t) => t.clone()));
  addEventListener() {}
  removeEventListener() {}
}

export interface FakeMediaDevices {
  getUserMedia: Mock<(c: any) => Promise<FakeStream>>;
  getDisplayMedia: Mock<(c?: any) => Promise<FakeStream>>;
  enumerateDevices: Mock<() => Promise<unknown[]>>;
  /** Tracks handed out by getUserMedia/getDisplayMedia, oldest first */
  tracks: FakeTrack[];
}

/** Installs `MediaStream` and `navigator.mediaDevices` fakes. getUserMedia returns one track per requested kind. */
export function installMediaDevices(): FakeMediaDevices {
  vi.stubGlobal("MediaStream", FakeStream);
  const devices: FakeMediaDevices = {
    tracks: [],
    getUserMedia: vi.fn(async (c: { audio?: unknown; video?: unknown }) => {
      const out: FakeTrack[] = [];
      if (c?.audio) out.push(new FakeTrack("audio"));
      if (c?.video) out.push(new FakeTrack("video"));
      devices.tracks.push(...out);
      return new FakeStream(out);
    }),
    getDisplayMedia: vi.fn(async (c: { audio?: unknown } = {}) => {
      const out = [new FakeTrack("video", "Screen 1")];
      if (c?.audio) out.push(new FakeTrack("audio", "Tab audio"));
      devices.tracks.push(...out);
      return new FakeStream(out);
    }),
    enumerateDevices: vi.fn(async () => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk mic" },
      { kind: "videoinput", deviceId: "cam-1", label: "Desk cam" },
    ]),
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (c: any) => devices.getUserMedia(c),
      getDisplayMedia: (c: any) => devices.getDisplayMedia(c),
      enumerateDevices: () => devices.enumerateDevices(),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  return devices;
}

// --- WebRTC ---

export function fakeSender(kind: string, track: FakeTrack | null) {
  const sender = {
    kind,
    track,
    replaceTrack: vi.fn(async (t: FakeTrack | null) => {
      sender.track = t;
    }),
    getParameters: () => ({ encodings: [{}] as Record<string, unknown>[] }),
    setParameters: vi.fn(async (_p: unknown) => {}),
  };
  return sender;
}

/** Every FakePC created since the last `resetPeers()`, oldest first */
export const peers: FakePC[] = [];
export function resetPeers() {
  peers.length = 0;
}

export class FakePC {
  config: unknown;
  senders: ReturnType<typeof fakeSender>[] = [];
  transceivers: {
    sender: ReturnType<typeof fakeSender>;
    receiver: { track: FakeTrack };
    direction: string;
    setCodecPreferences?: (c: unknown) => void;
  }[] = [];
  closed = false;
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onnegotiationneeded: ((e?: unknown) => void) | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  candidates: unknown[] = [];
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor(config?: unknown) {
    this.config = config;
    peers.push(this);
  }
  addTransceiver(trackOrKind: FakeTrack | string, _init?: unknown) {
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const sender = fakeSender(track?.kind ?? (trackOrKind as string), track);
    this.senders.push(sender);
    const t = {
      sender,
      receiver: { track: new FakeTrack(sender.kind) },
      direction: "sendrecv",
      setCodecPreferences: vi.fn(),
    };
    this.transceivers.push(t);
    return t;
  }
  addTrack(track: FakeTrack, ..._streams: unknown[]) {
    return this.addTransceiver(track).sender;
  }
  removeTrack(sender: unknown) {
    this.senders = this.senders.filter((s) => s !== sender);
  }
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getReceivers() {
    return this.transceivers.map((t) => t.receiver);
  }
  getConfiguration() {
    return (this.config as object) ?? {};
  }
  setConfiguration(c: unknown) {
    this.config = c;
  }
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0 offer" }));
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "v=0 answer" }));
  setLocalDescription = vi.fn(async (d?: { type: string; sdp: string }) => {
    this.localDescription = d ?? {
      type: this.signalingState === "have-remote-offer" ? "answer" : "offer",
      sdp: "v=0 implicit",
    };
    this.signalingState =
      this.localDescription.type === "offer" ? "have-local-offer" : "stable";
  });
  setRemoteDescription = vi.fn(async (d: { type: string; sdp: string }) => {
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
  });
  addIceCandidate = vi.fn(async (c: unknown) => {
    this.candidates.push(c);
  });
  restartIce = vi.fn();
  getStats = vi.fn(async () => new Map());
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  /** Sets connectionState and fires the handler/listeners */
  setConnectionState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
    this.listeners
      .get("connectionstatechange")
      ?.forEach((fn) => fn({ type: "connectionstatechange" }));
  }
  /** Delivers a remote track like the browser would */
  emitTrack(track: FakeTrack, stream = new FakeStream([track])) {
    const e = { track, streams: [stream], transceiver: undefined };
    this.ontrack?.(e);
    this.listeners.get("track")?.forEach((fn) => fn(e));
  }
}

export function installRTCPeerConnection() {
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal(
    "RTCSessionDescription",
    class {
      type: string;
      sdp: string;
      constructor(d: { type: string; sdp: string }) {
        this.type = d.type;
        this.sdp = d.sdp;
      }
    },
  );
  vi.stubGlobal(
    "RTCIceCandidate",
    class {
      constructor(c: Record<string, unknown>) {
        Object.assign(this, c);
      }
    },
  );
}

// --- WebAudio ---

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  /** The RMS level (0..1) every analyser reports; set it to make "speech" */
  level = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamSource = vi.fn((_s: unknown) => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createMediaElementSource = vi.fn((_e: unknown) => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createGain = vi.fn(() => ({
    gain: { value: 1, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createAnalyser = vi.fn(() => {
    const ctx = this;
    return {
      fftSize: 2048,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData(buf: Float32Array) {
        // A square wave at ±level has RMS = level
        for (let i = 0; i < buf.length; i++)
          buf[i] = i % 2 ? ctx.level : -ctx.level;
      },
    };
  });
}

export function installAudioContext() {
  FakeAudioContext.instances = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return FakeAudioContext;
}

// --- Layout & viewport ---

export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  targets = new Set<Element>();
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  /** Calls every observer's callback (after the test changed the elements' sizes) */
  static trigger() {
    for (const ro of FakeResizeObserver.instances) {
      ro.callback(
        [...ro.targets].map((target) => ({ target }) as ResizeObserverEntry),
        ro as unknown as ResizeObserver,
      );
    }
  }
}

export function installResizeObserver() {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return FakeResizeObserver;
}

/** Gives an element a fixed layout size (happy-dom reports 0 for everything) */
export function setElementSize(
  el: Element,
  width: number,
  height: number,
  left = 0,
  top = 0,
) {
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(el, "offsetWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(el, "offsetHeight", {
    configurable: true,
    value: height,
  });
  el.getBoundingClientRect = () =>
    ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON() {},
    }) as DOMRect;
}

/**
 * `window.matchMedia` that answers from `matches` (query → boolean; unknown queries don't match). Returns a setter
 * that changes an answer and notifies the listeners.
 */
export function installMatchMedia(matches: Record<string, boolean> = {}) {
  const lists = new Map<
    string,
    { matches: boolean; listeners: Set<(e: { matches: boolean }) => void> }
  >();
  const get = (query: string) => {
    if (!lists.has(query))
      lists.set(query, {
        matches: Boolean(matches[query]),
        listeners: new Set(),
      });
    return lists.get(query)!;
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const l = get(query);
      return {
        get matches() {
          return l.matches;
        },
        media: query,
        onchange: null,
        addEventListener: (_t: string, fn: any) => l.listeners.add(fn),
        removeEventListener: (_t: string, fn: any) => l.listeners.delete(fn),
        addListener: (fn: any) => l.listeners.add(fn),
        removeListener: (fn: any) => l.listeners.delete(fn),
        dispatchEvent: () => true,
      };
    }),
  );
  return (query: string, value: boolean) => {
    const l = get(query);
    l.matches = value;
    l.listeners.forEach((fn) => fn({ matches: value }));
  };
}

/** A `window.visualViewport` whose height/offsetTop the test can change (`update` fires "resize") */
export function installVisualViewport(height = 800, offsetTop = 0) {
  const listeners = new Map<string, Set<() => void>>();
  const vv = {
    height,
    width: 1200,
    offsetTop,
    offsetLeft: 0,
    scale: 1,
    addEventListener: (t: string, fn: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: () => void) =>
      listeners.get(t)?.delete(fn),
    update(patch: { height?: number; offsetTop?: number }) {
      Object.assign(vv, patch);
      listeners.get("resize")?.forEach((fn) => fn());
      listeners.get("scroll")?.forEach((fn) => fn());
    },
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: vv,
  });
  return vv;
}

/**
 * Element fullscreen: `requestFullscreen` sets `document.fullscreenElement` and fires `fullscreenchange`,
 * `exitFullscreen` clears it. Returns the mocks.
 */
export function installFullscreen() {
  let current: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => current,
  });
  const request = vi.fn(async function (this: Element) {
    current = this;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  const exit = vi.fn(async () => {
    current = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  Object.defineProperty(Element.prototype, "requestFullscreen", {
    configurable: true,
    writable: true,
    value: request,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    writable: true,
    value: exit,
  });
  return {
    request,
    exit,
    /** Sets the fullscreen element directly (e.g. the browser left fullscreen on Esc) */
    set(el: Element | null) {
      current = el;
      document.dispatchEvent(new Event("fullscreenchange"));
    },
  };
}

/** Makes `HTMLMediaElement.play/pause/load` work (happy-dom's play() never resolves playing state) */
export function installMediaElement() {
  const proto = HTMLMediaElement.prototype as any;
  const play = vi.fn(async function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  });
  const pause = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
  Object.defineProperty(proto, "play", {
    configurable: true,
    writable: true,
    value: play,
  });
  Object.defineProperty(proto, "pause", {
    configurable: true,
    writable: true,
    value: pause,
  });
  return { play, pause };
}
