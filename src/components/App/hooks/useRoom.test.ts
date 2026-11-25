// Integration test for the room hooks: a fake socket drives REC:* events and records CMD:* emits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

type Listener = (...args: any[]) => void;

class FakeSocket {
  listeners = new Map<string, Listener[]>();
  emitted: [string, ...unknown[]][] = [];
  disconnected = false;
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push([event, ...args]);
    return this;
  }
  disconnect() {
    this.disconnected = true;
    return this;
  }
  /** Simulates an event from the server */
  receive(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
  emits(event: string) {
    return this.emitted.filter(([e]) => e === event).map(([, ...a]) => a);
  }
}

const sockets: FakeSocket[] = [];
const ioMock = vi.fn((..._args: unknown[]) => {
  const s = new FakeSocket();
  sockets.push(s);
  return s;
});
vi.mock("socket.io-client", () => ({ default: ioMock }));

vi.mock("../../../utils/generateName", () => ({
  generateName: async () => "Random Name",
}));

const notifyUnauthorized = vi.fn();
vi.mock("../../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/api")>()),
  notifyUnauthorized: () => notifyUnauthorized(),
  apiFetch: vi.fn(async () => new Response("")),
}));

vi.mock("../../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/utils")>()),
  testAutoplay: async () => true,
}));

// Probing reads the media with mediabunny; tests decide what it "finds" (default: unreadable → play directly)
const probeMedia = vi.fn(async (_url: string): Promise<unknown> => {
  throw new Error("not readable in tests");
});
vi.mock("../../../utils/clientTranscode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/clientTranscode")>()),
  probeMedia: (url: string) => probeMedia(url),
}));

const { useRoom } = await import("./useRoom");

async function setup() {
  const hook = renderHook(() => useRoom("happy-room"));
  await waitFor(() => expect(sockets).toHaveLength(1));
  return { ...hook, socket: sockets[0] };
}

beforeEach(() => {
  sockets.length = 0;
  ioMock.mockClear();
  notifyUnauthorized.mockClear();
  window.localStorage.clear();
  document.body.innerHTML = '<video id="leftVideo"></video>';
});

afterEach(() => {
  cleanup();
});

describe("useRoom", () => {
  it("connects to the room namespace with the client id", async () => {
    const { result } = await setup();
    expect(ioMock.mock.calls[0][0]).toMatch(/\/happy-room$/);
    expect(ioMock.mock.calls[0][1]).toMatchObject({
      transports: ["websocket"],
      withCredentials: true,
      query: { clientId: result.current.clientId, roomId: "happy-room" },
    });
  });

  it("on connect, marks connected and sends a generated name", async () => {
    const { result, socket } = await setup();
    expect(result.current.state.connection).toBe("starting");
    await act(async () => socket.receive("connect"));
    expect(result.current.state.connection).toBe("connected");
    expect(socket.emits("CMD:name")).toEqual([["Random Name"]]);
    expect(window.localStorage.getItem("watchparty-username")).toBe(
      "Random Name",
    );
  });

  it("returns to the login screen on an unauthorized connect_error", async () => {
    const { result, socket } = await setup();
    act(() => socket.receive("connect_error", new Error("unauthorized")));
    expect(notifyUnauthorized).toHaveBeenCalledOnce();
    expect(socket.disconnected).toBe(true);
    expect(result.current.state.overlayMsg).toBe("");
  });

  it("shows other connection errors in the overlay", async () => {
    const { result, socket } = await setup();
    act(() => socket.receive("connect_error", new Error("Invalid namespace")));
    expect(result.current.state.overlayMsg).toBe("Couldn't load this room.");
    act(() => socket.receive("disconnect", "transport close"));
    expect(result.current.state.warningMessage).toBe("Reconnecting...");
  });

  it("applies roster, names, playlist and chat events", async () => {
    const { result, socket } = await setup();
    act(() => {
      socket.receive("roster", [{ id: "a" }, { id: "b" }]);
      socket.receive("REC:nameMap", { a: "Alex" });
      socket.receive("playlist", [
        { url: "https://h/1.mp4", name: "1", duration: 0, type: "file" },
      ]);
      socket.receive("chatinit", [{ id: "a", timestamp: "1", msg: "hi" }]);
      socket.receive("REC:chat", { id: "b", timestamp: "2", msg: "yo" });
      socket.receive("REC:addReaction", {
        user: "a",
        value: "👍",
        msgId: "b",
        msgTimestamp: "2",
      });
    });
    const { state } = result.current;
    expect(state.participants).toHaveLength(2);
    expect(state.nameMap).toEqual({ a: "Alex" });
    expect(state.playlist).toHaveLength(1);
    expect(state.chat.map((m) => m.msg)).toEqual(["hi", "yo"]);
    expect(state.chat[1].reactions).toEqual({ "👍": ["a"] });
    act(() =>
      socket.receive("REC:removeReaction", {
        user: "a",
        value: "👍",
        msgId: "b",
        msgTimestamp: "2",
      }),
    );
    expect(result.current.state.chat[1].reactions).toEqual({ "👍": [] });
  });

  it("loads host state and follows play/pause/seek/rate/loop", async () => {
    const { result, socket } = await setup();
    const video = document.getElementById("leftVideo") as HTMLVideoElement;
    video.play = vi.fn(async () => {});
    video.pause = vi.fn();
    await act(async () =>
      socket.receive("REC:host", {
        video: "https://example.com/movie.mp4",
        videoTS: 12,
        subtitle: "",
        paused: true,
        playbackRate: 0,
        loop: false,
      }),
    );
    expect(result.current.state.roomMedia).toBe(
      "https://example.com/movie.mp4",
    );
    expect(result.current.state.roomPaused).toBe(true);
    expect(video.src).toBe("https://example.com/movie.mp4");

    await act(async () => socket.receive("REC:play"));
    expect(result.current.state.roomPaused).toBe(false);
    expect(video.play).toHaveBeenCalled();

    act(() => socket.receive("REC:pause"));
    expect(result.current.state.roomPaused).toBe(true);
    expect(video.pause).toHaveBeenCalled();

    act(() => socket.receive("REC:seek", 42));
    expect(video.currentTime).toBe(42);

    act(() => socket.receive("REC:playbackRate", 1.5));
    expect(result.current.state.roomPlaybackRate).toBe(1.5);
    expect(video.playbackRate).toBe(1.5);

    act(() => socket.receive("REC:loop", true));
    expect(result.current.state.roomLoop).toBe(true);
  });

  it("corrects drift on REC:tsMap and reports the sync status", async () => {
    const { result, socket } = await setup();
    const video = document.getElementById("leftVideo") as HTMLVideoElement;
    video.play = vi.fn(async () => {});
    await act(async () =>
      socket.receive("REC:host", {
        video: "https://example.com/movie.mp4",
        videoTS: 0,
        subtitle: "",
        paused: false,
        playbackRate: 0,
        loop: false,
      }),
    );
    const me = result.current.clientId;
    act(() => {
      result.current.store.set({ loading: false });
      socket.receive("connect");
    });
    // 1 s behind: nudge to 1.05x and show "catching up"
    act(() => socket.receive("REC:tsMap", { [me]: 10, other: 11 }));
    expect(video.playbackRate).toBe(1.05);
    expect(result.current.state.syncStatus).toEqual({
      kind: "catching-up",
      behind: 1,
    });
    act(() => socket.receive("REC:tsMap", { [me]: 11, other: 11 }));
    expect(video.playbackRate).toBe(1);
    expect(result.current.state.syncStatus).toEqual({ kind: "in-sync" });
    // Far behind: seek to the room instead
    act(() => socket.receive("REC:tsMap", { [me]: 11, other: 20 }));
    expect(video.currentTime).toBe(20);
    expect(video.playbackRate).toBe(1);
    act(() => socket.receive("disconnect", "transport close"));
    expect(result.current.state.syncStatus).toEqual({ kind: "reconnecting" });
  });

  it("announces who played/paused and applies remote subtitle offsets", async () => {
    const { result, socket } = await setup();
    const video = document.getElementById("leftVideo") as HTMLVideoElement;
    video.play = vi.fn(async () => {});
    video.pause = vi.fn();
    await act(async () =>
      socket.receive("REC:host", {
        video: "https://example.com/movie.mp4",
        videoTS: 0,
        subtitle: "",
        paused: false,
        playbackRate: 1,
        loop: false,
        subtitleOffset: 0.5,
      }),
    );
    expect(result.current.state.roomSubtitleOffset).toBe(0.5);
    act(() => socket.receive("REC:nameMap", { a: "Alex" }));
    act(() => socket.receive("REC:pause", { id: "a" }));
    expect(result.current.state.roomPaused).toBe(true);
    expect(result.current.state.playerNotice?.text).toBe("Alex paused");
    await act(async () =>
      socket.receive("REC:play", "https://example.com/movie.mp4", {
        id: "b",
        name: "Sam",
      }),
    );
    expect(result.current.state.playerNotice?.text).toBe("Sam played");
    // Our own echo (or an old server without an actor) doesn't announce anything
    const before = result.current.state.playerNotice;
    act(() => socket.receive("REC:pause", { id: result.current.clientId }));
    act(() => socket.receive("REC:pause"));
    expect(result.current.state.playerNotice).toBe(before);

    act(() =>
      socket.receive("REC:subtitleOffset", {
        offset: -1.2,
        actor: { id: "a" },
      }),
    );
    expect(result.current.state.roomSubtitleOffset).toBe(-1.2);
  });

  it("sends subtitle offsets for everyone, keeps 'just me' local", async () => {
    const { result, socket } = await setup();
    act(() => {
      result.current.subtitles.nudgeOffset(0.1);
      result.current.subtitles.nudgeOffset(0.1);
    });
    expect(socket.emits("CMD:subtitleOffset")).toEqual([[0.1], [0.2]]);
    expect(result.current.state.roomSubtitleOffset).toBe(0.2);
    act(() => {
      result.current.subtitles.setScope("me");
      result.current.subtitles.nudgeOffset(-0.5);
    });
    expect(result.current.state.localSubtitleOffset).toBeCloseTo(-0.3);
    expect(result.current.subtitles.getOffset()).toBeCloseTo(-0.3);
    expect(socket.emits("CMD:subtitleOffset")).toHaveLength(2);
    act(() => result.current.subtitles.resetOffset());
    expect(result.current.subtitles.getOffset()).toBe(0.2);
  });

  it("sends typed commands", async () => {
    const { result, socket } = await setup();
    act(() => {
      result.current.store.set({
        playlist: [
          { url: "https://h/1.mp4", name: "1", duration: 0, type: "file" },
        ],
      });
    });
    act(() => {
      result.current.playlist.play(0);
      result.current.playlist.move(1, 0);
      result.current.player.roomSetPlaybackRate(2);
      result.current.player.roomSetLoop(true);
      result.current.updateName("Sam");
    });
    expect(socket.emitted).toEqual([
      ["CMD:host", "https://h/1.mp4"],
      ["CMD:playlistDelete", 0],
      ["CMD:playlistMove", { index: 1, toIndex: 0 }],
      ["CMD:playbackRate", 2],
      ["CMD:loop", true],
      ["CMD:name", "Sam"],
    ]);
  });

  it("advances the playlist when the video ends", async () => {
    const { result, socket } = await setup();
    act(() => {
      result.current.store.set({
        loading: false,
        roomMedia: "https://h/a.mp4",
        playlist: [{ url: "u", name: "n", duration: 0, type: "file" }],
      });
    });
    act(() => result.current.player.onVideoEnded("https://h/a.mp4"));
    expect(socket.emits("CMD:playlistNext")).toEqual([["https://h/a.mp4"]]);
  });

  it("stores REC:videoMeta and REC:playbackIssue", async () => {
    const { result, socket } = await setup();
    const meta = {
      source: "aiostreams",
      type: "movie",
      id: "tt1",
      imdbId: "tt1",
      season: null,
      episode: null,
      title: "Example",
      episodeTitle: null,
      poster: null,
      bingeGroup: null,
    };
    act(() => socket.receive("REC:videoMeta", meta));
    expect(result.current.state.videoMeta).toEqual(meta);
    act(() =>
      socket.receive("REC:playbackIssue", {
        userId: "x",
        name: "Alex",
        reason: "HEVC",
      }),
    );
    expect(result.current.state.playbackIssue).toMatchObject({
      name: "Alex",
      reason: "HEVC",
    });
    act(() => socket.receive("REC:videoMeta", null));
    expect(result.current.state.videoMeta).toBeNull();
  });

  it("restores queued metadata when playing a playlist item", async () => {
    const { result, socket } = await setup();
    const meta = { source: "aiostreams", type: "movie", id: "tt1", title: "X" };
    act(() => {
      result.current.store.set({
        playlist: [
          {
            url: "https://h/1.mkv#wp-name=X",
            name: "X",
            duration: 0,
            type: "file",
            meta: meta as VideoMeta,
          },
        ],
      });
    });
    act(() => result.current.playlist.play(0));
    expect(socket.emits("CMD:videoMeta")).toEqual([
      [{ url: "https://h/1.mkv#wp-name=X", meta }],
    ]);
  });

  it("probes direct links, and reports a stream this browser can't play", async () => {
    probeMedia.mockImplementationOnce(async () => ({
      container: "matroska",
      containerNative: false,
      video: {
        id: 1,
        codec: "avc",
        height: 1080,
        native: true,
        copy: true,
        decode: true,
      },
      audio: [
        {
          id: 2,
          codec: "dts",
          language: "eng",
          name: null,
          channels: 6,
          default: true,
          original: false,
          commentary: false,
          native: false,
          copy: false,
          decode: false,
        },
      ],
      transcodeSupported: true,
      encodeVideo: true,
      encodeAudio: true,
    }));
    const { result, socket } = await setup();
    const video = document.getElementById("leftVideo") as HTMLVideoElement;
    video.play = vi.fn(async () => {});
    await act(async () =>
      socket.receive("REC:host", {
        video: "https://example.com/movie.mkv",
        videoTS: 0,
        subtitle: "",
        paused: true,
        playbackRate: 0,
        loop: false,
      }),
    );
    await waitFor(() =>
      expect(result.current.state.playback).toEqual({
        mode: "fail",
        reason: "DTS audio isn't supported in this browser",
      }),
    );
    expect(socket.emits("CMD:playbackIssue")).toEqual([
      [{ reason: "DTS audio isn't supported in this browser" }],
    ]);
    // Still tries (e.g. video without sound)
    expect(video.src).toBe("https://example.com/movie.mkv");
  });

  it("plays directly without probing when auto-convert is off", async () => {
    window.localStorage.setItem("wp-auto-convert", "0");
    const { result, socket } = await setup();
    expect(result.current.state.convertEnabled).toBe(false);
    probeMedia.mockClear();
    await act(async () =>
      socket.receive("REC:host", {
        video: "https://example.com/movie.mkv",
        videoTS: 0,
        subtitle: "",
        paused: true,
        playbackRate: 0,
        loop: false,
      }),
    );
    expect(probeMedia).not.toHaveBeenCalled();
    expect(result.current.state.playback).toEqual({ mode: "direct" });
    act(() => result.current.convert.setConvertEnabled(true));
    expect(window.localStorage.getItem("wp-auto-convert")).toBe("1");
    expect(result.current.state.convertEnabled).toBe(true);
  });

  it("disconnects on unmount", async () => {
    const { unmount, socket } = await setup();
    unmount();
    expect(socket.disconnected).toBe(true);
  });
});
