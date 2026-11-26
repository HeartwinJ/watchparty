// Call membership for one room: who's in the call, muted or not, camera on or not, and which socket speaks for them.
// Pure (no Socket.IO): Room (room.ts) feeds it commands and broadcasts `snapshot()` as REC:callState. In memory only,
// never serialized: a restart ends every call (clients rejoin on their own after a reload, see the grace period).
//
// The call is separate from the roster. A member whose socket drops stays in the call for `graceMs`
// ("reconnecting"), so a reload or a flaky connection rejoins silently: the client sends `join` again (same or new
// `session`) and keeps its place and mute state. A newer socket for the same clientId takes over the membership.

/** Shared limits. Tests may pass smaller values to CallMembership. */
export const CALL_LIMITS = {
  /** Full mesh: every member sends audio to every other member, so keep it small */
  maxMembers: 8,
  /** How long a member whose socket disconnected stays in the call */
  graceMs: 12_000,
  /** Largest relayed signal (JSON length): an SDP with video and many candidates stays well under this */
  signalMaxBytes: 32_000,
  /** Relayed signals per socket per window (offers, answers, ICE candidates, restarts) */
  signalMax: 300,
  signalWindowMs: 10_000,
  /** CMD:call commands per socket per window (push-to-talk sends a state change per press and release) */
  commandMax: 40,
  commandWindowMs: 10_000,
};

/** CMD:call. `session` identifies the client's call instance (a new one per page load). */
export type CallCommand =
  | { action: "join"; session: string; muted: boolean; camera: boolean }
  | { action: "leave" }
  | { action: "state"; muted?: boolean; camera?: boolean };

/**
 * CMD:callModerate (owners only): ask someone to mute or to turn their camera off (their own client does it), or
 * remove them from the call
 */
export interface CallModeration {
  action: "mute" | "camera" | "remove";
  clientId: string;
}

/** A validated CMD:callSignal. The server adds the sender's clientId and session when relaying. */
export interface CallSignalIn {
  to: string;
  /** The recipient's session this was meant for (the recipient drops signals for an older session) */
  toSession: string;
  description?: { type: "offer" | "answer" | "rollback"; sdp: string };
  candidate?: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment: string | null;
  } | null;
}

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_ID_RE =
  /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;

export const isCallSession = (v: unknown): v is string =>
  typeof v === "string" && SESSION_RE.test(v);
const isClientId = (v: unknown): v is string =>
  typeof v === "string" && CLIENT_ID_RE.test(v);

export function parseCallCommand(raw: unknown): CallCommand | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const d = raw as Record<string, unknown>;
  if (d.action === "join") {
    // `camera` is optional (an audio-only client): absent = off
    if (
      !isCallSession(d.session) ||
      typeof d.muted !== "boolean" ||
      (d.camera !== undefined && typeof d.camera !== "boolean")
    ) {
      return null;
    }
    return {
      action: "join",
      session: d.session,
      muted: d.muted,
      camera: d.camera === true,
    };
  }
  if (d.action === "leave") {
    return { action: "leave" };
  }
  if (d.action === "state") {
    // `muted` and/or `camera`: at least one, each a boolean when present
    const hasMuted = d.muted !== undefined;
    const hasCamera = d.camera !== undefined;
    if (
      (!hasMuted && !hasCamera) ||
      (hasMuted && typeof d.muted !== "boolean") ||
      (hasCamera && typeof d.camera !== "boolean")
    ) {
      return null;
    }
    const out: { action: "state"; muted?: boolean; camera?: boolean } = {
      action: "state",
    };
    if (hasMuted) {
      out.muted = d.muted as boolean;
    }
    if (hasCamera) {
      out.camera = d.camera as boolean;
    }
    return out;
  }
  return null;
}

export function parseCallModeration(raw: unknown): CallModeration | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const d = raw as Record<string, unknown>;
  if (
    (d.action !== "mute" && d.action !== "camera" && d.action !== "remove") ||
    !isClientId(d.clientId)
  ) {
    return null;
  }
  return { action: d.action, clientId: d.clientId };
}

const optString = (v: unknown, max: number): string | null | undefined =>
  v === undefined || v === null
    ? null
    : typeof v === "string" && v.length <= max
      ? v
      : undefined;

/**
 * Validates a CMD:callSignal and rebuilds it from the known fields only (nothing else is forwarded). Exactly one of
 * `description` / `candidate` (a null candidate = end of candidates). Null when invalid or too large.
 */
export function parseCallSignal(
  raw: unknown,
  maxBytes = CALL_LIMITS.signalMaxBytes,
): CallSignalIn | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const d = raw as Record<string, unknown>;
  if (!isClientId(d.to) || !isCallSession(d.toSession)) {
    return null;
  }
  const out: CallSignalIn = { to: d.to, toSession: d.toSession };
  const hasDescription = d.description !== undefined;
  const hasCandidate = d.candidate !== undefined;
  if (hasDescription === hasCandidate) {
    return null;
  }
  if (hasDescription) {
    const desc = d.description as Record<string, unknown> | null;
    if (
      !desc ||
      typeof desc !== "object" ||
      (desc.type !== "offer" &&
        desc.type !== "answer" &&
        desc.type !== "rollback") ||
      typeof desc.sdp !== "string" ||
      desc.sdp.length > maxBytes
    ) {
      return null;
    }
    out.description = { type: desc.type, sdp: desc.sdp };
  } else if (d.candidate === null) {
    out.candidate = null;
  } else {
    const c = d.candidate as Record<string, unknown>;
    if (!c || typeof c !== "object" || typeof c.candidate !== "string") {
      return null;
    }
    const sdpMid = optString(c.sdpMid, 64);
    const usernameFragment = optString(c.usernameFragment, 256);
    const idx = c.sdpMLineIndex;
    const sdpMLineIndex =
      idx === undefined || idx === null
        ? null
        : Number.isInteger(idx) && (idx as number) >= 0 && (idx as number) < 64
          ? (idx as number)
          : undefined;
    if (
      c.candidate.length > 2048 ||
      sdpMid === undefined ||
      usernameFragment === undefined ||
      sdpMLineIndex === undefined
    ) {
      return null;
    }
    out.candidate = {
      candidate: c.candidate,
      sdpMid,
      sdpMLineIndex,
      usernameFragment,
    };
  }
  if (JSON.stringify(out).length > maxBytes) {
    return null;
  }
  return out;
}

/** A fixed-window counter per key (socket id): at most `max` events per `windowMs`. */
export function createWindowLimiter(max: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key: string, now = Date.now()): boolean {
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
        if (windows.size > 1000) {
          for (const [k, v] of windows) {
            if (now - v.start >= windowMs) {
              windows.delete(k);
            }
          }
        }
      }
      w.count++;
      return w.count <= max;
    },
    forget(key: string) {
      windows.delete(key);
    },
  };
}

interface Member {
  clientId: string;
  session: string;
  muted: boolean;
  camera: boolean;
  joinedAt: number;
  /** The socket that speaks for this member, null while it's gone (grace period) */
  socketId: string | null;
  /** When the grace period ends (only while socketId is null) */
  graceUntil: number | null;
}

export type JoinOutcome = "joined" | "rejoined" | "full";

export class CallMembership {
  private members = new Map<string, Member>();
  private graceMs: number;
  private maxMembers: number;

  constructor(opts: { graceMs?: number; maxMembers?: number } = {}) {
    this.graceMs = opts.graceMs ?? CALL_LIMITS.graceMs;
    this.maxMembers = opts.maxMembers ?? CALL_LIMITS.maxMembers;
  }

  /**
   * Joins (or rejoins, keeping the original join time) from `socketId`. A member that's still listed (in its grace
   * period, or from another socket of the same clientId) is taken over by this socket. `muted` and `camera` are the
   * client's state: it decides the join-muted rule itself and keeps its state across a rejoin.
   */
  join(
    clientId: string,
    socketId: string,
    cmd: { session: string; muted: boolean; camera?: boolean },
    now: number,
  ): JoinOutcome {
    const camera = cmd.camera === true;
    const existing = this.members.get(clientId);
    if (existing) {
      existing.socketId = socketId;
      existing.graceUntil = null;
      existing.session = cmd.session;
      existing.muted = cmd.muted;
      existing.camera = camera;
      return "rejoined";
    }
    if (this.members.size >= this.maxMembers) {
      return "full";
    }
    this.members.set(clientId, {
      clientId,
      session: cmd.session,
      muted: cmd.muted,
      camera,
      joinedAt: now,
      socketId,
      graceUntil: null,
    });
    return "joined";
  }

  /** Removes a member (leave, removed by an owner, kicked from the room). Returns whether they were in the call. */
  remove(clientId: string): boolean {
    return this.members.delete(clientId);
  }

  /** `leave` from a socket: only the socket that speaks for the member can leave for it */
  leave(clientId: string, socketId: string): boolean {
    const m = this.members.get(clientId);
    if (!m || m.socketId !== socketId) {
      return false;
    }
    return this.members.delete(clientId);
  }

  /** Mute and/or camera, from the member's own socket. Returns whether anything changed. */
  setState(
    clientId: string,
    socketId: string,
    patch: { muted?: boolean; camera?: boolean },
  ): boolean {
    const m = this.members.get(clientId);
    if (!m || m.socketId !== socketId) {
      return false;
    }
    let changed = false;
    if (patch.muted !== undefined && patch.muted !== m.muted) {
      m.muted = patch.muted;
      changed = true;
    }
    if (patch.camera !== undefined && patch.camera !== m.camera) {
      m.camera = patch.camera;
      changed = true;
    }
    return changed;
  }

  /** The member's socket disconnected: keep them for the grace period. Returns whether anything changed. */
  disconnect(clientId: string, socketId: string, now: number): boolean {
    const m = this.members.get(clientId);
    if (!m || m.socketId !== socketId) {
      return false;
    }
    m.socketId = null;
    m.graceUntil = now + this.graceMs;
    return true;
  }

  /** Removes members whose grace period is over; returns their clientIds */
  expire(now: number): string[] {
    const gone: string[] = [];
    for (const m of this.members.values()) {
      if (m.graceUntil !== null && m.graceUntil <= now) {
        gone.push(m.clientId);
      }
    }
    for (const id of gone) {
      this.members.delete(id);
    }
    return gone;
  }

  /** When the next grace period ends, or null */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const m of this.members.values()) {
      if (m.graceUntil !== null && (next === null || m.graceUntil < next)) {
        next = m.graceUntil;
      }
    }
    return next;
  }

  /** The member's current socket id (null while reconnecting or not a member) */
  socketOf(clientId: string): string | null {
    return this.members.get(clientId)?.socketId ?? null;
  }

  sessionOf(clientId: string): string | null {
    return this.members.get(clientId)?.session ?? null;
  }

  has(clientId: string): boolean {
    return this.members.has(clientId);
  }

  /** Signals only flow between two connected members, from the socket that speaks for the sender */
  canRelay(from: string, fromSocketId: string, to: string): boolean {
    if (from === to) {
      return false;
    }
    const a = this.members.get(from);
    const b = this.members.get(to);
    return Boolean(a && b && a.socketId === fromSocketId && b.socketId);
  }

  get size() {
    return this.members.size;
  }

  /** REC:callState, in join order */
  snapshot(): CallState {
    return {
      members: [...this.members.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((m) => ({
          clientId: m.clientId,
          session: m.session,
          muted: m.muted,
          camera: m.camera,
          joinedAt: m.joinedAt,
          reconnecting: m.socketId === null,
        })),
    };
  }
}
