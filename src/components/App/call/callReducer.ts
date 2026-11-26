// The room page's view of the voice call (state.call): server membership (REC:callState) plus this device's own
// status, peers and who's speaking. Pure; useCall dispatches into it.
import type { MicErrorKind } from "./logic";
import type { PeerStatus } from "./negotiation";

export type CallStatus = "idle" | "joining" | "joined";

export interface CallUiState {
  /** idle: not in the call; joining: sent `join`, waiting for the server to list us; joined: in the call */
  status: CallStatus;
  /** Our session while joining/joined */
  session: string | null;
  /** Everyone in the call (REC:callState), us included */
  members: CallMember[];
  /** This device's mute toggle (push-to-talk ignores it) */
  muted: boolean;
  /** Push-to-talk key/button held */
  pttHeld: boolean;
  /** Per-device preferences (localStorage) */
  pushToTalk: boolean;
  ducking: boolean;
  /** Connection to each other member, by clientId */
  peers: Record<string, PeerStatus>;
  /** clientIds speaking right now (us included), sorted */
  speaking: string[];
  /** Getting the mic / ICE servers before `join` is sent */
  busy: boolean;
  /** Why the mic couldn't start (shown in the call panel) */
  micError: MicErrorKind | null;
  /** The browser blocked call audio from playing until the user interacts */
  audioBlocked: boolean;
}

export const initialCallState = (prefs: {
  pushToTalk: boolean;
  ducking: boolean;
}): CallUiState => ({
  status: "idle",
  session: null,
  members: [],
  muted: false,
  pttHeld: false,
  pushToTalk: prefs.pushToTalk,
  ducking: prefs.ducking,
  peers: {},
  speaking: [],
  busy: false,
  micError: null,
  audioBlocked: false,
});

export type CallAction =
  | { type: "server"; state: CallState; selfId: string }
  | { type: "joining"; session: string; muted: boolean }
  | { type: "left" }
  | { type: "muted"; muted: boolean }
  | { type: "ptt"; held: boolean }
  | { type: "peer"; clientId: string; status: PeerStatus | null }
  | { type: "speaking"; ids: string[] }
  | {
      type: "patch";
      patch: Partial<
        Pick<
          CallUiState,
          "busy" | "micError" | "audioBlocked" | "pushToTalk" | "ducking"
        >
      >;
    };

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function callReducer(s: CallUiState, a: CallAction): CallUiState {
  switch (a.type) {
    case "server": {
      const members = Array.isArray(a.state?.members) ? a.state.members : [];
      const me = members.find((m) => m.clientId === a.selfId);
      let status = s.status;
      if (s.status === "joining" && me && me.session === s.session) {
        status = "joined";
      } else if (s.status === "joined" && (!me || me.session !== s.session)) {
        // Removed, timed out, or another tab took over: we're out
        status = "idle";
      }
      const ids = new Set(members.map((m) => m.clientId));
      const peers: Record<string, PeerStatus> = {};
      if (status !== "idle") {
        for (const [id, p] of Object.entries(s.peers)) {
          if (ids.has(id)) {
            peers[id] = p;
          }
        }
      }
      const speaking = s.speaking.filter(
        (id) => ids.has(id) && status !== "idle",
      );
      return {
        ...s,
        members,
        status,
        session: status === "idle" ? null : s.session,
        pttHeld: status === "idle" ? false : s.pttHeld,
        peers,
        speaking: sameList(speaking, s.speaking) ? s.speaking : speaking,
      };
    }
    case "joining":
      return {
        ...s,
        status: "joining",
        session: a.session,
        muted: a.muted,
        busy: false,
        micError: null,
      };
    case "left":
      return {
        ...s,
        status: "idle",
        session: null,
        pttHeld: false,
        peers: {},
        speaking: [],
        busy: false,
        audioBlocked: false,
      };
    case "muted":
      return s.muted === a.muted ? s : { ...s, muted: a.muted };
    case "ptt":
      return s.pttHeld === a.held ? s : { ...s, pttHeld: a.held };
    case "peer": {
      if (s.peers[a.clientId] === (a.status ?? undefined)) {
        return s;
      }
      const peers = { ...s.peers };
      if (a.status) {
        peers[a.clientId] = a.status;
      } else {
        delete peers[a.clientId];
      }
      return { ...s, peers };
    }
    case "speaking": {
      const ids = [...a.ids].sort();
      return sameList(ids, s.speaking) ? s : { ...s, speaking: ids };
    }
    case "patch":
      return { ...s, ...a.patch };
  }
}

/** Whether this device is in the call (or rejoining it) */
export const inCall = (s: CallUiState) => s.status !== "idle";

/** Members other than us that we should hold a peer connection with */
export const remoteMembers = (s: CallUiState, selfId: string) =>
  s.members.filter((m) => m.clientId !== selfId);

/** Shown on a member: "reconnecting" when either their socket or our connection to them is recovering */
export function memberConnection(
  s: CallUiState,
  member: CallMember,
  selfId: string,
): PeerStatus {
  if (member.clientId === selfId) {
    return "connected";
  }
  if (member.reconnecting) {
    return "reconnecting";
  }
  return s.peers[member.clientId] ?? "connecting";
}
