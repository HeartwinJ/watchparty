// Call audio on this device: plays each remote member's audio, measures levels (mic meter, speaking rings) with
// AnalyserNodes, and runs speaking detection locally. Mutable, not React state.
import { classifyMicError, micConstraints, type MicErrorKind } from "./logic";
import { rmsDb, SpeakingDetector } from "./speaking";

interface Source {
  track: MediaStreamTrack;
  analyser: AnalyserNode | null;
  node: MediaStreamAudioSourceNode | null;
  detector: SpeakingDetector;
  /** Remote sources play through an <audio> element (Chrome also needs one for WebAudio to get remote audio) */
  element: HTMLAudioElement | null;
  db: number;
}

const TICK_MS = 60;

export class CallAudio {
  private ctx: AudioContext | null = null;
  private sources = new Map<string, Source>();
  private buffer = new Float32Array(1024);
  private timer: number | undefined;
  private speaking = "";
  /** Called with the sorted clientIds speaking, when that changes */
  onSpeaking: (ids: string[]) => void = () => {};
  /** Called every tick with whether a remote member is speaking (ducking) */
  onTick: (remoteSpeaking: boolean) => void = () => {};
  /** Called when the browser refused to play call audio (autoplay policy) */
  onBlocked: () => void = () => {};
  private localId: string | null = null;

  /** Creates/resumes the AudioContext. Call from a user gesture when possible. */
  async start(): Promise<void> {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctx) {
        this.ctx = new Ctx();
      }
    }
    try {
      await this.ctx?.resume();
    } catch {
      // Resumed on the next gesture
    }
    if (this.timer === undefined) {
      this.timer = window.setInterval(this.tick, TICK_MS);
    }
  }

  /** Plays remote audio that autoplay blocked; call from a click */
  async unblock(): Promise<boolean> {
    await this.start();
    let ok = true;
    for (const s of this.sources.values()) {
      if (s.element) {
        try {
          await s.element.play();
        } catch {
          ok = false;
        }
      }
    }
    return ok;
  }

  private analyse(track: MediaStreamTrack) {
    if (!this.ctx) {
      return { analyser: null, node: null };
    }
    try {
      const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      node.connect(analyser);
      return { analyser, node };
    } catch (e) {
      console.warn("[call] can't analyse audio", e);
      return { analyser: null, node: null };
    }
  }

  /** This device's mic (meter + our own speaking ring) */
  setLocal(id: string, track: MediaStreamTrack | null) {
    if (this.localId) {
      this.remove(this.localId);
    }
    this.localId = track ? id : null;
    if (track) {
      this.sources.set(id, {
        track,
        ...this.analyse(track),
        detector: new SpeakingDetector(),
        element: null,
        db: -100,
      });
    }
  }

  addRemote(id: string, track: MediaStreamTrack) {
    if (track.kind !== "audio") {
      return;
    }
    this.remove(id);
    const element = new Audio();
    element.autoplay = true;
    element.srcObject = new MediaStream([track]);
    element.play().catch((e: unknown) => {
      if ((e as { name?: string })?.name === "NotAllowedError") {
        this.onBlocked();
      }
    });
    this.sources.set(id, {
      track,
      ...this.analyse(track),
      detector: new SpeakingDetector(),
      element,
      db: -100,
    });
  }

  remove(id: string) {
    const s = this.sources.get(id);
    if (!s) {
      return;
    }
    this.sources.delete(id);
    s.node?.disconnect();
    if (s.element) {
      s.element.pause();
      s.element.srcObject = null;
    }
  }

  /** Current level of a source in dBFS (-100 when unknown) */
  levelOf(id: string): number {
    return this.sources.get(id)?.db ?? -100;
  }

  private tick = () => {
    const now = performance.now();
    const speaking: string[] = [];
    let remoteSpeaking = false;
    for (const [id, s] of this.sources) {
      if (s.analyser) {
        s.analyser.getFloatTimeDomainData(this.buffer);
        // A disabled (muted) track is silent, so a muted mic never shows as speaking
        s.db = s.track.enabled ? rmsDb(this.buffer) : -100;
      }
      if (s.detector.update(s.db, now)) {
        speaking.push(id);
        if (id !== this.localId) {
          remoteSpeaking = true;
        }
      }
    }
    const key = speaking.sort().join(",");
    if (key !== this.speaking) {
      this.speaking = key;
      this.onSpeaking(speaking);
    }
    this.onTick(remoteSpeaking);
  };

  close() {
    window.clearInterval(this.timer);
    this.timer = undefined;
    for (const id of [...this.sources.keys()]) {
      this.remove(id);
    }
    this.localId = null;
    this.speaking = "";
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

export type MicResult =
  | { ok: true; stream: MediaStream; deviceId: string | null }
  | { ok: false; error: MicErrorKind };

/**
 * Opens the mic (voice constraints). A remembered device that's gone falls back to the default one.
 */
export async function openMic(deviceId?: string | null): Promise<MicResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: "unsupported" };
  }
  const attempt = async (id?: string | null): Promise<MicResult> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(id),
      video: false,
    });
    const settings = stream.getAudioTracks()[0]?.getSettings?.();
    return { ok: true, stream, deviceId: settings?.deviceId ?? id ?? null };
  };
  try {
    return await attempt(deviceId);
  } catch (e) {
    const kind = classifyMicError(e);
    if (deviceId && kind === "no-device") {
      try {
        return await attempt(null);
      } catch (e2) {
        return { ok: false, error: classifyMicError(e2) };
      }
    }
    return { ok: false, error: kind };
  }
}

/** The microphones (labels only appear once mic permission was granted) */
export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices?.enumerateDevices();
    return (all ?? []).filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}
