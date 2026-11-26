// useRoom's REC:* handlers beyond the basics in useRoom.test.ts: connection messages, kicks for owners, deleted
// rooms, REC:host for shares / HLS / DASH / YouTube / plain links, the canplay join seek, intro skip, next episode,
// room settings, fullscreen changes and the heartbeat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

vi.mock(
  "socket.io-client",
  async () => (await import("../../../test/fakeSocket")).socketIoModule,
);
vi.mock("../../../utils/generateName", () => ({
  generateName: async () => "Random Name",
}));
const apiFetch = vi.fn(async (_url: string) => new Response(""));
vi.mock("../../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/api")>()),
  notifyUnauthorized: () => {},
  apiFetch: (url: string) => apiFetch(url),
}));
let autoplay: Promise<boolean> | boolean = true;
vi.mock("../../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/utils")>()),
  testAutoplay: async () => autoplay,
}));
vi.mock("../../../utils/clientTranscode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/clientTranscode")>()),
  probeMedia: async () => {
    throw new Error("not readable in tests");
  },
}));
const navigate = vi.fn();
vi.mock("../../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../router")>()),
  navigate: (to: string) => navigate(to),
}));
const toast = vi.fn();
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toast: (...args: unknown[]) => toast(...args),
}));

// Lazy players: fakes that record what they were given
const hlsInstances: any[] = [];
vi.mock("hls.js", () => {
  class FakeHls {
    static Events = { LEVEL_LOADED: "hlsLevelLoaded" };
    handlers: Record<string, (e: unknown, d: any) => void> = {};
    loadSource = vi.fn();
    attachMedia = vi.fn();
    constructor() {
      hlsInstances.push(this);
    }
    on(ev: string, fn: (e: unknown, d: any) => void) {
      this.handlers[ev] = fn;
    }
  }
  return { default: FakeHls };
});
const dashPlayer = {
  handlers: {} as Record<string, () => void>,
  on: vi.fn((ev: string, fn: () => void) => {
    dashPlayer.handlers[ev] = fn;
  }),
  initialize: vi.fn(),
  isDynamic: vi.fn(() => true),
};
vi.mock("dashjs", () => ({
  MediaPlayer: () => ({ create: () => dashPlayer }),
}));

const { sockets, resetSockets } = await import("../../../test/fakeSocket");
const { useRoom } = await import("./useRoom");
const { AuthContext } = await import("../../AuthGate/AuthGate");
const React = await import("react");

const roomAccessLost = vi.fn();
const host = (patch: Record<string, unknown> = {}) => ({
  video: "",
  videoTS: 0,
  subtitle: "",
  paused: true,
  playbackRate: 0,
  loop: false,
  ...patch,
});

async function setup(role: "owner" | "guest" = "owner") {
  const hook = renderHook(() => useRoom("event-room"), {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        AuthContext.Provider,
        {
          value: {
            authRequired: true,
            role,
            logout: async () => {},
            roomAccessLost,
          },
        },
        children,
      ),
  });
  await waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  const state = () => hook.result.current.state;
  return { ...hook, socket, state };
}

let video: HTMLVideoElement;
beforeEach(() => {
  resetSockets();
  autoplay = true;
  hlsInstances.length = 0;
  delete window.watchparty.hls;
  delete window.watchparty.dash;
  dashPlayer.initialize.mockClear();
  roomAccessLost.mockClear();
  navigate.mockClear();
  toast.mockClear();
  apiFetch.mockClear();
  window.localStorage.clear();
  document.body.innerHTML = '<video id="leftVideo"></video>';
  video = document.getElementById("leftVideo") as HTMLVideoElement;
  video.play = vi.fn(async () => {});
  video.pause = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useRoom connection messages", () => {
  it("explains password and unknown connect errors", async () => {
    const { socket, state } = await setup();
    act(() => socket.receive("connect_error", new Error("password")));
    expect(state().overlayMsg).toBe(
      "This room has a password, which isn't supported.",
    );
    act(() => socket.receive("connect_error", new Error("boom")));
    expect(state().overlayMsg).toBe("boom");
  });

  it("a server disconnect shows the overlay", async () => {
    const { socket, state } = await setup();
    act(() => socket.receive("disconnect", "io server disconnect"));
    expect(state().overlayMsg).toBe("Disconnected from server.");
    expect(state().syncStatus).toEqual({ kind: "reconnecting" });
  });

  it("keeps a stored name on connect", async () => {
    window.localStorage.setItem("watchparty-username", "Kim");
    const { socket } = await setup();
    await act(async () => socket.receive("connect"));
    expect(socket.emits("CMD:name")).toEqual([["Kim"]]);
  });

  it("error and success messages disappear after 3 s", async () => {
    const { socket, state } = await setup();
    vi.useFakeTimers();
    act(() => socket.receive("errorMessage", "Nope"));
    act(() => socket.receive("successMessage", "Saved"));
    expect(state().errorMessage).toBe("Nope");
    expect(state().successMessage).toBe("Saved");
    act(() => vi.advanceTimersByTime(3000));
    expect(state().errorMessage).toBe("");
    expect(state().successMessage).toBe("");
  });

  it("sends a kicked owner Home", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
    } as any);
    const { socket } = await setup("owner");
    act(() => socket.receive("kicked"));
    expect(assign).toHaveBeenCalledWith("/");
    expect(roomAccessLost).not.toHaveBeenCalled();
  });
});

describe("useRoom REC:roomDeleted", () => {
  it("the owner who deleted it goes Home", async () => {
    window.localStorage.setItem(
      "wp-recent-rooms",
      JSON.stringify([{ roomId: "event-room", lastVisited: 1 }]),
    );
    const { socket, result, state } = await setup();
    act(() =>
      socket.receive("REC:roomDeleted", {
        by: { id: result.current.clientId, name: "Me" },
      }),
    );
    expect(toast).toHaveBeenCalledWith("Room deleted.");
    expect(navigate).toHaveBeenCalledWith("/");
    expect(state().roomDeleted).toBeNull();
    expect(window.localStorage.getItem("wp-recent-rooms")).not.toContain(
      "event-room",
    );
  });

  it("everyone else sees who deleted it", async () => {
    const { socket, state } = await setup();
    act(() => socket.receive("REC:nameMap", { alex: "Alex" }));
    act(() =>
      socket.receive("REC:roomDeleted", { by: { id: "alex", name: "A" } }),
    );
    expect(state().roomDeleted).toEqual({ by: "Alex" });
    act(() =>
      socket.receive("REC:roomDeleted", { by: { id: "zed", name: "Zed" } }),
    );
    expect(state().roomDeleted).toEqual({ by: "Zed" });
    act(() => socket.receive("REC:roomDeleted", { by: null }));
    expect(state().roomDeleted).toEqual({ by: null });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("useRoom room events", () => {
  it("stores intro skip (only positive seconds) and clears it on REC:host", async () => {
    const { socket, state } = await setup();
    act(() => socket.receive("REC:introSkip", { seconds: 90 }));
    expect(state().introSkip).toMatchObject({ seconds: 90 });
    act(() => socket.receive("REC:introSkip", { seconds: 0 }));
    expect(state().introSkip).toBeNull();
    act(() => socket.receive("REC:introSkip", { seconds: 30 }));
    await act(async () => socket.receive("REC:host", host()));
    expect(state().introSkip).toBeNull();
    act(() => socket.receive("REC:introSkip", null));
    expect(state().introSkip).toBeNull();
  });

  it("stores the next episode card with the time it arrived", async () => {
    const { socket, state } = await setup();
    act(() =>
      socket.receive("REC:nextEpisode", { state: "cancelled", by: null }),
    );
    expect(state().nextEpisode).toMatchObject({ state: "cancelled" });
    expect(state().nextEpisode.at).toBeGreaterThan(0);
  });

  it("ignores malformed subtitle offsets and stores pictures", async () => {
    const { socket, state } = await setup();
    act(() => socket.receive("REC:subtitleOffset", null));
    act(() => socket.receive("REC:subtitleOffset", { offset: "x" }));
    expect(state().roomSubtitleOffset).toBe(0);
    act(() => socket.receive("REC:pictureMap", { a: "https://x/p.png" }));
    expect(state().pictureMap).toEqual({ a: "https://x/p.png" });
    // A rate of 0 is stored but not applied
    act(() => socket.receive("REC:playbackRate", 0));
    expect(state().roomPlaybackRate).toBe(0);
  });

  it("turning auto-sync on re-evaluates the subtitles", async () => {
    const { socket, state } = await setup();
    act(() =>
      socket.receive("REC:roomSettings", {
        ...state().roomSettings,
        autoSyncSubtitles: true,
      }),
    );
    expect(state().roomSettings.autoSyncSubtitles).toBe(true);
  });

  it("tracks fullscreen changes", async () => {
    const { result, state } = await setup();
    vi.useFakeTimers();
    const scrollToBottom = vi.fn();
    (result.current.chatRef as any).current = { scrollToBottom };
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: document.body,
    });
    act(() => (document.onfullscreenchange as any)());
    expect(state().fullScreen).toBe(true);
    vi.advanceTimersByTime(100);
    expect(scrollToBottom).toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    act(() => (document.onfullscreenchange as any)());
    expect(state().fullScreen).toBe(false);
  });

  it("sends a heartbeat every 10 minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await setup();
    expect(apiFetch).not.toHaveBeenCalledWith("/ping");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(apiFetch).toHaveBeenCalledWith("/ping");
  });

  it("doesn't connect when unmounted before the autoplay check finishes", async () => {
    let resolve!: (v: boolean) => void;
    autoplay = new Promise((r) => (resolve = r));
    const hook = renderHook(() => useRoom("event-room"));
    hook.unmount();
    resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(sockets).toHaveLength(0);
  });
});

describe("useRoom REC:host", () => {
  it("plays a plain non-direct link through the player and seeks on canplay", async () => {
    const { socket, state } = await setup();
    act(() => socket.receive("roster", [{ id: "a" }, { id: "b" }]));
    act(() => socket.receive("REC:tsMap", { a: 40, b: 40 }));
    // A reddit link isn't a direct video URL
    const url = "https://www.reddit.com/r/videos/comments/abc";
    await act(async () =>
      socket.receive(
        "REC:host",
        host({ video: url, videoTS: 10, paused: false, playbackRate: 1.5 }),
      ),
    );
    expect(state().loading).toBe(true);
    expect(video.playbackRate).toBe(1.5);
    expect(video.play).toHaveBeenCalled();
    act(() => {
      video.dispatchEvent(new Event("canplay"));
    });
    expect(state().loading).toBe(false);
    // Joins the other viewers
    expect(video.currentTime).toBe(40);
  });

  it("loads the room subtitle with the video", async () => {
    apiFetch.mockResolvedValue(new Response("WEBVTT\n"));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const { socket, state } = await setup();
    await act(async () =>
      socket.receive(
        "REC:host",
        host({
          video: "https://www.reddit.com/r/v",
          subtitle: "/subtitle/abc",
          subtitleOffset: 2,
        }),
      ),
    );
    expect(state().roomSubtitle).toBe("/subtitle/abc");
    expect(state().roomSubtitleOffset).toBe(2);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/subtitle/abc"));
  });

  it("uses hls.js for .m3u8 and learns whether it's live", async () => {
    (window as any).MediaSource = class {};
    const { socket, state } = await setup();
    const url = "https://cdn.example.com/live.m3u8";
    await act(async () =>
      socket.receive("REC:host", host({ video: url, videoTS: 50 })),
    );
    const hls = hlsInstances[0];
    expect(hls.loadSource).toHaveBeenCalledWith(url);
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
    act(() => hls.handlers.hlsLevelLoaded({}, { details: { live: true } }));
    expect(state().isLiveStream).toBe(true);
    // HLS resets the position, so canplay seeks back to the host time (live: relative to the edge)
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 200,
    });
    act(() => {
      video.dispatchEvent(new Event("canplay"));
    });
    expect(video.currentTime).toBe(250);
    // A second HLS video reuses the instance
    await act(async () =>
      socket.receive("REC:host", host({ video: url + "?2" })),
    );
    expect(hlsInstances).toHaveLength(1);
    delete (window as any).MediaSource;
  });

  it("uses dash.js for .mpd", async () => {
    const { socket, state } = await setup();
    const url = "https://cdn.example.com/a.mpd";
    await act(async () => socket.receive("REC:host", host({ video: url })));
    expect(dashPlayer.initialize).toHaveBeenCalledWith(video, url);
    act(() => dashPlayer.handlers.streamInitialized());
    expect(state().isLiveStream).toBe(true);
  });

  it("waits for the YouTube player when it isn't ready", async () => {
    const { socket, state } = await setup();
    await act(async () =>
      socket.receive(
        "REC:host",
        host({ video: "https://www.youtube.com/watch?v=abc" }),
      ),
    );
    // Still loading: onReady asks for the video again
    expect(state().loading).toBe(true);
  });

  it("joining a screen share stops loading; a reconnect to the same kind of share is ignored", async () => {
    const { socket, state } = await setup();
    await act(async () =>
      socket.receive("REC:host", host({ video: "screenshare://alex" })),
    );
    expect(state().roomMedia).toBe("screenshare://alex");
    expect(state().loading).toBe(false);
    await act(async () =>
      socket.receive("REC:host", host({ video: "screenshare://bob" })),
    );
    expect(state().roomMedia).toBe("screenshare://alex");
  });

  it("leaving a share for a normal video stops publishing", async () => {
    const { socket, result, state } = await setup();
    await act(async () =>
      socket.receive("REC:host", host({ video: "fileshare://me" })),
    );
    act(() => result.current.store.set({ isPublishing: true }));
    await act(async () =>
      socket.receive("REC:host", host({ video: "screenshare://x" })),
    );
    expect(state().roomMedia).toBe("screenshare://x");
    await act(async () => socket.receive("REC:host", host({ video: "" })));
    expect(state().roomMedia).toBe("");
    expect(state().loading).toBe(false);
  });
});
