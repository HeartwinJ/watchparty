// Voice call: small pure rules (join-muted, push-to-talk, mic errors, per-device preferences).

/**
 * The agreed default: join muted while the room's video is playing (so you don't talk over the movie by accident),
 * unmuted when it's paused or nothing is playing. Only applies at the moment of joining; play/pause later never
 * changes your mute state.
 */
export function joinMuted(room: {
  roomMedia: string;
  roomPaused: boolean;
}): boolean {
  return Boolean(room.roomMedia) && !room.roomPaused;
}

/** Whether the mic is open: push-to-talk sends only while the key/button is held, otherwise it's the mute toggle */
export function isTransmitting(s: {
  muted: boolean;
  pushToTalk: boolean;
  pttHeld: boolean;
}): boolean {
  return s.pushToTalk ? s.pttHeld : !s.muted;
}

/** Push-to-talk hold key. Not used by any room shortcut (shell/shortcuts.ts, logic/shortcuts.ts). */
export const PTT_KEY = "t";

/** Camera on/off while in the call (logic/shortcuts.ts resolves it, PlayerArea acts on it) */
export const CAMERA_KEY = "v";

export const isPttKey = (key: string) => key.toLowerCase() === PTT_KEY;

export type MicErrorKind =
  "blocked" | "in-use" | "no-device" | "unsupported" | "unknown";

/** Maps a getUserMedia failure to something we can explain */
export function classifyMicError(err: unknown): MicErrorKind {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "blocked";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "in-use";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-device";
    case "TypeError":
    case "NotSupportedError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export const MIC_ERROR_TEXT: Record<
  MicErrorKind,
  { title: string; hint: string }
> = {
  blocked: {
    title: "Microphone access is blocked",
    hint: "Allow the microphone for this site in your browser's address bar or site settings, then try again.",
  },
  "in-use": {
    title: "Your microphone is busy",
    hint: "Another app or tab may be using it. Close it (or pick another microphone) and try again.",
  },
  "no-device": {
    title: "No microphone found",
    hint: "Plug in a microphone or headset and try again.",
  },
  unsupported: {
    title: "Voice calls aren't available here",
    hint: "This browser can't use the microphone on this page. Calls need HTTPS and a recent browser.",
  },
  unknown: {
    title: "Couldn't start the microphone",
    hint: "Try again, or pick another microphone.",
  },
};

/** Mic constraints for voice: the browser's echo cancellation, noise suppression and auto gain on */
export function micConstraints(
  deviceId?: string | null,
): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

// Per-device preferences (localStorage, which can throw or be empty: private windows, blocked storage)
export const CALL_PREFS = {
  mic: "wp-call-mic",
  camera: "wp-call-camera",
  ducking: "wp-call-ducking",
  pushToTalk: "wp-call-ptt",
  /** "1" hides the video tiles over the player */
  tilesHidden: "wp-call-tiles-hidden",
  /** The tile strip: JSON {fx, fy, collapsed} (call/tileLayout.ts) */
  tiles: "wp-call-tiles",
} as const;

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Not remembered; fine
  }
}

/** sessionStorage marker so a reload of this tab rejoins the call (per tab, unlike localStorage) */
export const rejoinKey = (roomId: string) => `wp-call:${roomId}`;

export function readRejoin(roomId: string): { muted: boolean } | null {
  try {
    const raw = window.sessionStorage.getItem(rejoinKey(roomId));
    if (!raw) {
      return null;
    }
    const v = JSON.parse(raw) as { muted?: unknown };
    return { muted: v?.muted === true };
  } catch {
    return null;
  }
}

export function writeRejoin(roomId: string, value: { muted: boolean } | null) {
  try {
    if (value) {
      window.sessionStorage.setItem(rejoinKey(roomId), JSON.stringify(value));
    } else {
      window.sessionStorage.removeItem(rejoinKey(roomId));
    }
  } catch {
    // A reload just won't rejoin
  }
}

/** A random id for this page's call instance (matches the server's session format) */
export function newCallSession(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return Array.from({ length: 24 }, () =>
      Math.floor(Math.random() * 36).toString(36),
    ).join("");
  }
}

/**
 * Whether this device shows the call's video tiles, so the others should send it their camera (`wantsVideo`): not
 * hidden by the setting, the strip not collapsed, and the tab visible. An enlarged tile is visible too.
 */
export function wantsVideo(
  s: { tilesHidden: boolean; tilesCollapsed: boolean },
  pageVisible: boolean,
): boolean {
  return pageVisible && !s.tilesHidden && !s.tilesCollapsed;
}

/**
 * How long `wantsVideo` must hold before it's sent, ms. Showing goes quickly (video resumes within about a second);
 * hiding waits a little longer, so a quick toggle or a short tab switch doesn't flap the senders.
 */
export const WANTS_VIDEO_DELAY_MS = { show: 150, hide: 500 };

/**
 * Sends a boolean once it has held for its delay (`delays.show` for true, `delays.hide` for false), and only when it
 * differs from what was last sent. A change back before the delay cancels the pending one.
 */
export function createDebouncedFlag(
  send: (value: boolean) => void,
  delays = WANTS_VIDEO_DELAY_MS,
) {
  let sent: boolean | null = null;
  let pending: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  return {
    push(value: boolean) {
      if (value === pending) {
        return;
      }
      cancel();
      if (value === sent) {
        return;
      }
      pending = value;
      timer = setTimeout(
        () => {
          timer = undefined;
          pending = null;
          sent = value;
          send(value);
        },
        value ? delays.show : delays.hide,
      );
    },
    /** The server already has `value` (sent with `join`): forget anything pending */
    reset(value: boolean) {
      cancel();
      sent = value;
    },
    cancel,
  };
}

/** Throttles mute-state updates to the server: the latest value, at most once per `intervalMs` */
export function createStateThrottle<T>(
  send: (value: T) => void,
  intervalMs = 200,
) {
  let lastSent = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { value: T } | null = null;
  let lastValue: { value: T } | null = null;
  const flush = () => {
    timer = undefined;
    if (pending && (!lastValue || lastValue.value !== pending.value)) {
      send(pending.value);
      lastValue = pending;
      lastSent = Date.now();
    }
    pending = null;
  };
  return {
    push(value: T) {
      pending = { value };
      const wait = lastSent + intervalMs - Date.now();
      if (wait <= 0) {
        clearTimeout(timer);
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, wait);
      }
    },
    /** Forget what was sent (after a rejoin the server has the join's state) */
    reset(value: T) {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
      lastValue = { value };
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}

/**
 * Picker options for media devices. Skips devices without an id (no permission yet) and repeats of an id: some
 * systems (e.g. Linux with PipeWire) list the same camera twice, and Mantine's Select throws on duplicate values,
 * which took the whole room page down.
 */
export function deviceOptions(
  devices: Pick<MediaDeviceInfo, "deviceId" | "label">[],
  fallbackLabel: string,
): { value: string; label: string }[] {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const d of devices) {
    if (!d.deviceId || seen.has(d.deviceId)) {
      continue;
    }
    seen.add(d.deviceId);
    out.push({
      value: d.deviceId,
      label: d.label || `${fallbackLabel} ${out.length + 1}`,
    });
  }
  return out;
}
