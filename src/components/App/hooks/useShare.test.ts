// Screen/file/URL share over WebRTC: publishing, per-viewer connections, signaling and cleanup. The player, the
// converter and the room commands are fakes; RTCPeerConnection and media come from the shared browser fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  FakeStream,
  FakeTrack,
  installMediaDevices,
  installRTCPeerConnection,
  peers,
  resetPeers,
} from "../../../test/browserFakes";

vi.mock("../../../utils/iceServers", () => ({
  getIceServers: async () => [{ urls: "stun:stun.example.com:3478" }],
}));
const openFileSelector = vi.fn(async (): Promise<File[] | null> => null);
vi.mock("../../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/utils")>()),
  openFileSelector: () => openFileSelector(),
}));
let transcodeSupported = true;
vi.mock("../../../utils/clientTranscode", () => ({
  isClientTranscodeSupported: () => transcodeSupported,
}));

const { useShare, createShareSession } = await import("./useShare");
const { useStore } = await import("./useStore");
const { createInitialRoomState } = await import("../roomState");

const ME = "me";

function makeCmd() {
  return {
    leaveScreenShare: vi.fn(),
    joinScreenShare: vi.fn(),
    setVideoMeta: vi.fn(),
    signal: vi.fn(),
  };
}

let video: HTMLVideoElement;
let stream: FakeStream;

function setup(media = "") {
  const cmd = makeCmd();
  const html = { getVideoEl: () => video };
  const player = {
    current: () => ({ clearState: vi.fn() }),
    html: () => html,
    localSetMute: vi.fn(),
    localPlay: vi.fn(),
    isWebRTCShare: vi.fn(
      () =>
        media.startsWith("screenshare://") || media.startsWith("fileshare://"),
    ),
  };
  let current: unknown = null;
  const convert = {
    stopConvert: vi.fn(() => {
      current = null;
    }),
    isCurrent: vi.fn((t: unknown) => t === current),
    createTranscoder: vi.fn(
      (_src: unknown, _v: unknown, _t: number, onError: (e: Error) => void) => {
        const t = { start: vi.fn(async () => {}), onError };
        current = t;
        return t;
      },
    ),
  };
  const session = createShareSession();
  const showError = vi.fn();
  const hook = renderHook(() => {
    const [state, store] = useStore(createInitialRoomState);
    const share = useShare({
      store,
      cmd: cmd as any,
      clientId: ME,
      player: player as any,
      convert: convert as any,
      session,
      showError,
    });
    return { state, store, share };
  });
  const setMedia = (m: string) => {
    media = m;
  };
  const store = {
    set: (patch: object) => hook.result.current.store.set(patch),
  };
  return { ...hook, store, cmd, player, convert, session, showError, setMedia };
}

beforeEach(() => {
  installMediaDevices();
  installRTCPeerConnection();
  resetPeers();
  transcodeSupported = true;
  openFileSelector.mockReset();
  document.body.innerHTML = '<video id="leftVideo"></video>';
  video = document.getElementById("leftVideo") as HTMLVideoElement;
  stream = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
  (video as any).captureStream = vi.fn(() => stream);
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:file");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useShare publishing", () => {
  it("starts a screen share with a display stream and joins the share", async () => {
    const { result, cmd, session } = setup();
    await act(() => result.current.share.startScreenShare());
    expect(navigator.mediaDevices.getDisplayMedia).toBeDefined();
    expect(session.localStream).toBeDefined();
    expect(session.isFile).toBe(false);
    expect(result.current.state.isPublishing).toBe(true);
    expect(cmd.joinScreenShare).toHaveBeenCalledWith(false);
  });

  it("does nothing without getDisplayMedia", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });
    const { result, cmd } = setup();
    await act(() => result.current.share.startScreenShare());
    expect(cmd.joinScreenShare).not.toHaveBeenCalled();
  });

  it("shares a picked file through our own <video>", async () => {
    const file = new File(["x"], "movie.mp4");
    openFileSelector.mockResolvedValueOnce([file]);
    const { result, cmd, session } = setup();
    await act(() => result.current.share.startFileShare());
    expect(video.src).toBe("blob:file");
    expect(session.file).toBe(file);
    expect(session.isFile).toBe(true);
    expect(cmd.joinScreenShare).toHaveBeenCalledWith(true);
  });

  it("does nothing when no file is picked", async () => {
    const { result, cmd } = setup();
    await act(() => result.current.share.startFileShare());
    expect(cmd.joinScreenShare).not.toHaveBeenCalled();
  });

  it("doesn't publish when the video can't be captured", async () => {
    openFileSelector.mockResolvedValueOnce([new File(["x"], "a.mp4")]);
    (video as any).captureStream = () => undefined;
    const { result, cmd } = setup();
    await act(() => result.current.share.startFileShare());
    expect(cmd.joinScreenShare).not.toHaveBeenCalled();
    expect(result.current.state.isPublishing).toBe(false);
  });

  it("converts a file before sharing it when asked", async () => {
    const file = new File(["x"], "movie.mkv");
    openFileSelector.mockResolvedValueOnce([file]);
    const { result, cmd, convert } = setup();
    await act(() => result.current.share.startFileShare({ convert: true }));
    expect(convert.createTranscoder).toHaveBeenCalledWith(
      file,
      video,
      0,
      expect.any(Function),
    );
    expect(cmd.joinScreenShare).toHaveBeenCalledWith(true);
  });

  it("refuses to convert where the browser can't", async () => {
    transcodeSupported = false;
    openFileSelector.mockResolvedValueOnce([new File(["x"], "a.mkv")]);
    const { result, cmd, showError } = setup();
    await act(() => result.current.share.startFileShare({ convert: true }));
    expect(showError).toHaveBeenCalledWith(
      "Your browser doesn't support converting videos",
    );
    expect(cmd.joinScreenShare).not.toHaveBeenCalled();
  });

  it("shows the converter's error when it can't start", async () => {
    openFileSelector.mockResolvedValueOnce([new File(["x"], "a.mkv")]);
    const { result, convert, showError, cmd } = setup();
    convert.createTranscoder.mockImplementationOnce(() => {
      const t = {
        start: vi.fn(async () => {
          throw new Error("No decoder for DTS");
        }),
      };
      convert.isCurrent.mockImplementation((x) => x === t);
      return t as any;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(() => result.current.share.startFileShare({ convert: true }));
    expect(showError).toHaveBeenCalledWith("No decoder for DTS");
    expect(cmd.joinScreenShare).not.toHaveBeenCalled();
  });

  it("uses a generic message for non-Error failures", async () => {
    openFileSelector.mockResolvedValueOnce([new File(["x"], "a.mkv")]);
    const { result, convert, showError } = setup();
    convert.createTranscoder.mockImplementationOnce(() => {
      const t = {
        start: vi.fn(async () => {
          throw "nope";
        }),
      };
      convert.isCurrent.mockImplementation((x) => x === t);
      return t as any;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(() => result.current.share.startFileShare({ convert: true }));
    expect(showError).toHaveBeenCalledWith("Unable to convert this file");
  });

  it("stays quiet when the conversion was cancelled while starting", async () => {
    openFileSelector.mockResolvedValueOnce([new File(["x"], "a.mkv")]);
    const { result, convert, showError, cmd } = setup();
    convert.createTranscoder.mockImplementationOnce(() => {
      const t = { start: vi.fn(async () => {}) };
      // Something else replaced the transcoder
      convert.isCurrent.mockReturnValue(false);
      return t as any;
    });
    await act(() => result.current.share.startFileShare({ convert: true }));
    expect(showError).not.toHaveBeenCalled();
    expect(cmd.joinScreenShare).not.toHaveBeenCalled();
  });

  it("stops publishing when the conversion fails mid-share", async () => {
    openFileSelector.mockResolvedValueOnce([new File(["x"], "a.mkv")]);
    const { result, convert, showError, cmd } = setup();
    await act(() => result.current.share.startFileShare({ convert: true }));
    const onError = convert.createTranscoder.mock.calls[0][3];
    await act(async () => onError(new Error("decoder crashed")));
    expect(showError).toHaveBeenCalledWith(
      "Conversion failed: decoder crashed",
    );
    expect(cmd.leaveScreenShare).toHaveBeenCalled();
    expect(result.current.state.isPublishing).toBe(false);
  });

  it("shares a URL converted and re-attaches its metadata", async () => {
    const { result, cmd, convert } = setup();
    const meta = { source: "aiostreams", title: "Spring" } as any;
    let started = false;
    await act(async () => {
      started = await result.current.share.startUrlShare(
        "https://cdn.example.com/a.mkv",
        { startTime: 42, meta },
      );
    });
    expect(started).toBe(true);
    expect(convert.createTranscoder.mock.calls[0][2]).toBe(42);
    expect(cmd.setVideoMeta).toHaveBeenCalledWith(`fileshare://${ME}`, meta);
  });

  it("a URL share without metadata doesn't send any", async () => {
    const { result, cmd } = setup();
    await act(async () => {
      await result.current.share.startUrlShare("https://cdn.example.com/a.mkv");
    });
    expect(cmd.setVideoMeta).not.toHaveBeenCalled();
  });

  it("stopPublishing stops the tracks, closes connections and unmutes", async () => {
    const { result, cmd, player, session, convert } = setup();
    await act(() => result.current.share.startScreenShare());
    const tracks = session.localStream!.getTracks() as unknown as FakeTrack[];
    const consumer = { close: vi.fn() };
    const pub = { close: vi.fn() };
    session.consumerConn = consumer as any;
    session.publisherConns = { bob: pub as any };
    await act(() => result.current.share.stopPublishing());
    expect(convert.stopConvert).toHaveBeenCalled();
    expect(cmd.leaveScreenShare).toHaveBeenCalled();
    expect(player.localSetMute).toHaveBeenCalledWith(false);
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(consumer.close).toHaveBeenCalled();
    expect(pub.close).toHaveBeenCalled();
    expect(session.publisherConns).toEqual({});
    expect(session.localStream).toBeUndefined();
    expect(result.current.state.isPublishing).toBe(false);
  });

  it("stopPublishing without a share doesn't tell the room", async () => {
    const { result, cmd } = setup();
    await act(() => result.current.share.stopPublishing());
    expect(cmd.leaveScreenShare).not.toHaveBeenCalled();
  });
});

describe("useShare connections", () => {
  it("does nothing unless the room is showing a share", async () => {
    const { result } = setup("https://example.com/a.mp4");
    await act(() => result.current.share.setupRTCConnections());
    expect(peers).toHaveLength(0);
  });

  it("as the screen sharer: one publisher connection per member plus our own viewer connection", async () => {
    const { result, store, session, cmd } = setup("screenshare://me");
    await act(() => result.current.share.startScreenShare());
    act(() =>
      store.set({
        participants: [{ id: ME, isScreenShare: true }, { id: "bob" }],
      }),
    );
    await act(() => result.current.share.setupRTCConnections());
    expect(Object.keys(session.publisherConns).sort()).toEqual(["bob", ME]);
    expect(session.consumerConn).toBeDefined();
    const bobPc = session.publisherConns.bob as any;
    expect(bobPc.senders).toHaveLength(2);

    // ICE candidates and offers go to that viewer as the sharer
    bobPc.onicecandidate({ candidate: { candidate: "c1" } });
    bobPc.onicecandidate({ candidate: null });
    expect(cmd.signal).toHaveBeenCalledTimes(1);
    expect(cmd.signal).toHaveBeenLastCalledWith(
      "bob",
      { ice: { candidate: "c1" } },
      true,
    );
    await bobPc.onnegotiationneeded();
    expect(cmd.signal).toHaveBeenLastCalledWith(
      "bob",
      { sdp: { type: "offer", sdp: "v=0 offer" } },
      true,
    );

    // Calling again doesn't create duplicates; members who left are closed and dropped
    const before = peers.length;
    act(() => store.set({ participants: [{ id: ME, isScreenShare: true }] }));
    await act(() => result.current.share.setupRTCConnections());
    expect(peers.length).toBe(before);
    expect(bobPc.closed).toBe(true);
    expect(session.publisherConns.bob).toBeUndefined();
  });

  it("stops sharing when the captured track ends", async () => {
    const { result, store, session, cmd } = setup("screenshare://me");
    await act(() => result.current.share.startScreenShare());
    act(() => store.set({ participants: [{ id: ME, isScreenShare: true }] }));
    await act(() => result.current.share.setupRTCConnections());
    const track = session.localStream!.getVideoTracks()[0] as any;
    await act(async () => track.onended());
    expect(cmd.leaveScreenShare).toHaveBeenCalled();
  });

  it("as a file sharer: no connection to ourselves and no viewer connection", async () => {
    openFileSelector.mockResolvedValueOnce([new File(["x"], "a.mp4")]);
    const { result, store, session } = setup("fileshare://me");
    await act(() => result.current.share.startFileShare());
    act(() =>
      store.set({
        participants: [{ id: ME, isScreenShare: true }, { id: "bob" }],
      }),
    );
    await act(() => result.current.share.setupRTCConnections());
    expect(Object.keys(session.publisherConns)).toEqual(["bob"]);
    expect(session.consumerConn).toBeUndefined();
  });

  it("as a viewer: connects to the sharer and plays the received stream", async () => {
    const { result, store, session, cmd, player } = setup("screenshare://alex");
    act(() =>
      store.set({
        participants: [{ id: "alex", isScreenShare: true }, { id: ME }],
      }),
    );
    await act(() => result.current.share.setupRTCConnections());
    expect(Object.keys(session.publisherConns)).toEqual([]);
    const pc = session.consumerConn as any;
    pc.onicecandidate({ candidate: { candidate: "v1" } });
    pc.onicecandidate({ candidate: null });
    expect(cmd.signal).toHaveBeenCalledTimes(1);
    expect(cmd.signal).toHaveBeenLastCalledWith(
      "alex",
      { ice: { candidate: "v1" } },
      undefined,
    );
    const remote = new FakeStream([new FakeTrack("video")]);
    // happy-dom only accepts its own MediaStream here
    let srcObject: unknown = null;
    Object.defineProperty(video, "srcObject", {
      configurable: true,
      get: () => srcObject,
      set: (v) => (srcObject = v),
    });
    pc.ontrack({ streams: [remote] });
    expect(video.srcObject).toBe(remote);
    expect(player.localPlay).toHaveBeenCalled();
  });

  it("bails out if the share ended while waiting for ICE servers", async () => {
    const { result, player } = setup("screenshare://alex");
    player.isWebRTCShare.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await act(() => result.current.share.setupRTCConnections());
    expect(peers).toHaveLength(0);
  });
});

describe("useShare signaling", () => {
  async function viewer() {
    const ctx = setup("screenshare://alex");
    act(() =>
      ctx.store.set({
        participants: [{ id: "alex", isScreenShare: true }, { id: ME }],
      }),
    );
    await act(() => ctx.result.current.share.setupRTCConnections());
    return { ...ctx, pc: ctx.session.consumerConn as any };
  }

  it("ignores messages for a connection that doesn't exist", async () => {
    const { result, cmd } = setup("screenshare://alex");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(() =>
      result.current.share.handleSignal({
        msg: { ice: {} as any },
        from: "nobody",
        sharer: false,
      }),
    );
    expect(warn).toHaveBeenCalled();
    expect(cmd.signal).not.toHaveBeenCalled();
  });

  it("adds ICE candidates from the sharer", async () => {
    const { result, pc } = await viewer();
    await act(() =>
      result.current.share.handleSignal({
        msg: { ice: { candidate: "x" } as any },
        from: "alex",
        sharer: true,
      }),
    );
    expect(pc.addIceCandidate).toHaveBeenCalled();
  });

  it("answers the sharer's offer (extmap-allow-mixed stripped) and sends the answer back", async () => {
    const { result, pc, cmd } = await viewer();
    await act(() =>
      result.current.share.handleSignal({
        msg: {
          sdp: {
            type: "offer",
            sdp: "v=0\r\na=extmap-allow-mixed\r\nm=video 9\r\n",
          },
        },
        from: "alex",
        sharer: true,
      }),
    );
    expect(pc.setRemoteDescription.mock.calls[0][0].sdp).not.toContain(
      "extmap-allow-mixed",
    );
    expect(pc.createAnswer).toHaveBeenCalled();
    expect(cmd.signal).toHaveBeenLastCalledWith(
      "alex",
      { sdp: pc.localDescription },
      false,
    );
  });

  it("handles an offer with no sdp text and an answer with no sdp", async () => {
    const { result, pc } = await viewer();
    pc.createAnswer.mockResolvedValueOnce({ type: "answer" });
    await act(() =>
      result.current.share.handleSignal({
        msg: { sdp: { type: "offer" } as any },
        from: "alex",
        sharer: true,
      }),
    );
    expect(pc.setRemoteDescription.mock.calls[0][0].sdp).toBe("");
  });

  it("the sharer applies a viewer's answer", async () => {
    const { result, store, session } = setup("screenshare://me");
    await act(() => result.current.share.startScreenShare());
    act(() =>
      store.set({
        participants: [{ id: ME, isScreenShare: true }, { id: "bob" }],
      }),
    );
    await act(() => result.current.share.setupRTCConnections());
    const pc = session.publisherConns.bob as any;
    await act(() =>
      result.current.share.handleSignal({
        msg: { sdp: { type: "answer", sdp: "v=0 a" } },
        from: "bob",
        sharer: false,
      }),
    );
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: "answer", sdp: "v=0 a" }),
    );
  });
});
