import { describe, expect, it } from "vitest";
import {
  callReducer,
  inCall,
  initialCallState,
  memberConnection,
  remoteMembers,
  videoMembers,
  type CallUiState,
} from "./callReducer";

const ME = "me";
const member = (clientId: string, extra: Partial<CallMember> = {}) => ({
  clientId,
  session: `${clientId}-session`,
  muted: false,
  camera: false,
  joinedAt: 1,
  reconnecting: false,
  wantsVideo: true,
  ...extra,
});
const start = () => initialCallState({ pushToTalk: false, ducking: false });
const server = (s: CallUiState, members: CallMember[]) =>
  callReducer(s, { type: "server", state: { members }, selfId: ME });

describe("callReducer", () => {
  it("joins once the server lists us with our session", () => {
    let s = callReducer(start(), {
      type: "joining",
      session: "me-session",
      muted: true,
    });
    expect(s.status).toBe("joining");
    expect(s.muted).toBe(true);
    // A state from before our join doesn't drop us while joining
    s = server(s, [member("bob")]);
    expect(s.status).toBe("joining");
    s = server(s, [member("bob"), member(ME)]);
    expect(s.status).toBe("joined");
    expect(inCall(s)).toBe(true);
    expect(remoteMembers(s, ME).map((m) => m.clientId)).toEqual(["bob"]);
  });

  it("leaves when the server stops listing us, or lists another session (another tab)", () => {
    const joined = server(
      callReducer(start(), {
        type: "joining",
        session: "me-session",
        muted: false,
      }),
      [member(ME)],
    );
    expect(server(joined, []).status).toBe("idle");
    const other = server(joined, [member(ME, { session: "other-tab" })]);
    expect(other.status).toBe("idle");
    expect(other.session).toBeNull();
  });

  it("prunes peers and speaking of departed members", () => {
    let s = server(
      callReducer(start(), {
        type: "joining",
        session: "me-session",
        muted: false,
      }),
      [member(ME), member("bob"), member("cat")],
    );
    s = callReducer(s, { type: "peer", clientId: "bob", status: "connected" });
    s = callReducer(s, { type: "peer", clientId: "cat", status: "connecting" });
    s = callReducer(s, { type: "speaking", ids: ["cat", "bob"] });
    expect(s.speaking).toEqual(["bob", "cat"]);
    s = server(s, [member(ME), member("bob")]);
    expect(s.peers).toEqual({ bob: "connected" });
    expect(s.speaking).toEqual(["bob"]);
  });

  it("keeps the same object for no-op updates", () => {
    const s = start();
    expect(callReducer(s, { type: "muted", muted: false })).toBe(s);
    expect(callReducer(s, { type: "speaking", ids: [] })).toBe(s);
    expect(callReducer(s, { type: "ptt", held: false })).toBe(s);
    expect(callReducer(s, { type: "peer", clientId: "x", status: null })).toBe(
      s,
    );
  });

  it("left clears this device's call but keeps the membership list", () => {
    let s = server(
      callReducer(start(), {
        type: "joining",
        session: "me-session",
        muted: false,
      }),
      [member(ME), member("bob")],
    );
    s = callReducer(s, { type: "ptt", held: true });
    s = callReducer(s, { type: "left" });
    expect(s.status).toBe("idle");
    expect(s.pttHeld).toBe(false);
    expect(s.peers).toEqual({});
    expect(s.members).toHaveLength(2);
  });

  it("describes each member's connection", () => {
    let s = server(
      callReducer(start(), {
        type: "joining",
        session: "me-session",
        muted: false,
      }),
      [member(ME), member("bob"), member("cat", { reconnecting: true })],
    );
    s = callReducer(s, {
      type: "peer",
      clientId: "bob",
      status: "reconnecting",
    });
    expect(memberConnection(s, s.members[0], ME)).toBe("connected");
    expect(memberConnection(s, s.members[1], ME)).toBe("reconnecting");
    expect(memberConnection(s, s.members[2], ME)).toBe("reconnecting");
    s = callReducer(s, { type: "peer", clientId: "bob", status: null });
    expect(memberConnection(s, s.members[1], ME)).toBe("connecting");
  });

  it("gives tiles to members with their camera on, us by our own camera state, only in the call", () => {
    const members = [
      member(ME, { camera: false }),
      member("bob", { camera: true }),
      member("cat"),
    ];
    // Not in the call: no peer connections, no tiles
    expect(videoMembers(server(start(), members), ME)).toEqual([]);
    let s = server(
      callReducer(start(), {
        type: "joining",
        session: "me-session",
        muted: false,
      }),
      members,
    );
    expect(videoMembers(s, ME).map((m) => m.clientId)).toEqual(["bob"]);
    // Our toggle shows at once, before the server echoes it
    s = callReducer(s, { type: "patch", patch: { camera: true } });
    expect(videoMembers(s, ME).map((m) => m.clientId)).toEqual([ME, "bob"]);
    // Leaving turns our camera state off
    s = callReducer(s, { type: "left" });
    expect(s.camera).toBe(false);
    expect(videoMembers(s, ME)).toEqual([]);
  });
});
