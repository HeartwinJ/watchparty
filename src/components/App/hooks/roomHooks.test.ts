// The small room hooks on their own (useChat, usePlaylist, useSubtitles) and the typed command emitters.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRoomCommands } from "../socketEvents";
import { useStore } from "./useStore";
import { createInitialRoomState, type RoomState } from "../roomState";
import { useChat } from "./useChat";
import { usePlaylist } from "./usePlaylist";
import { useSubtitles } from "./useSubtitles";
import { FakeSocket } from "../../../test/fakeSocket";

function useRoomStore(init: Partial<RoomState> = {}) {
  return useStore(() => ({ ...createInitialRoomState(), ...init }));
}

describe("createRoomCommands", () => {
  it("is a no-op before the socket exists", () => {
    const cmd = createRoomCommands(() => undefined);
    expect(() => cmd.play()).not.toThrow();
  });

  it("emits every command with its typed payload", () => {
    const socket = new FakeSocket();
    const cmd = createRoomCommands(() => socket as any);
    const meta = { source: "aiostreams" } as any;
    cmd.setName("Sam");
    cmd.setMedia("https://x/a.mp4");
    cmd.stopVideo();
    cmd.play();
    cmd.pause();
    cmd.seek(5);
    cmd.setPlaybackRate(1.5);
    cmd.setPlaybackRate(2, { hold: true });
    cmd.setLoop(true);
    cmd.reportTime(3);
    cmd.reportDuration(100);
    cmd.sendChat("hi");
    cmd.sendChatV2({ msg: "hi" } as any);
    cmd.addReaction({ value: "👍", msgId: "a", msgTimestamp: "1" });
    cmd.removeReaction({ value: "👍", msgId: "a", msgTimestamp: "1" });
    cmd.joinScreenShare(true);
    cmd.leaveScreenShare();
    cmd.setSubtitle("/subtitle/x");
    cmd.setSubtitleOffset(1.5);
    cmd.setSubtitleTiming({ offset: 1, scale: 1.04 });
    cmd.subtitleSync({ action: "failed" } as any);
    cmd.askHost();
    cmd.playlistNext("https://x/a.mp4");
    cmd.playlistAdd("https://x/b.mp4");
    cmd.playlistAddItem({ url: "https://x/c.mp4", name: "C" });
    cmd.playlistMove(0, 2);
    cmd.playlistDelete(1);
    cmd.setVideoMeta("https://x/a.mp4", meta);
    cmd.reportPlaybackIssue("no audio");
    cmd.setRoomSettings({ title: "Movie night" });
    cmd.setRoomPassword({ action: "regenerate" });
    cmd.kickUser("bob");
    cmd.deleteRoom();
    cmd.reportReadyState({ ready: true });
    cmd.skipReadyCheck();
    cmd.nextEpisode({ action: "cancel" });
    cmd.signal("bob", { ice: {} as any }, true);
    cmd.call({ action: "join" } as any);
    cmd.callSignal("bob", "s1", { description: {} } as any);
    cmd.moderateCall("bob", "mute" as any);
    expect(socket.emitted).toEqual([
      ["CMD:name", "Sam"],
      ["CMD:host", "https://x/a.mp4"],
      ["CMD:host", ""],
      ["CMD:play"],
      ["CMD:pause"],
      ["CMD:seek", 5],
      ["CMD:playbackRate", 1.5],
      ["CMD:playbackRate", 2, { hold: true }],
      ["CMD:loop", true],
      ["CMD:ts", 3],
      ["CMD:duration", 100],
      ["CMD:chat", "hi"],
      ["CMD:chatV2", { msg: "hi" }],
      ["CMD:addReaction", { value: "👍", msgId: "a", msgTimestamp: "1" }],
      ["CMD:removeReaction", { value: "👍", msgId: "a", msgTimestamp: "1" }],
      ["CMD:joinScreenShare", { file: true }],
      ["CMD:leaveScreenShare"],
      ["CMD:subtitle", "/subtitle/x"],
      ["CMD:subtitleOffset", 1.5],
      ["CMD:subtitleTiming", { offset: 1, scale: 1.04 }],
      ["CMD:subtitleSync", { action: "failed" }],
      ["CMD:askHost"],
      ["CMD:playlistNext", "https://x/a.mp4"],
      ["CMD:playlistAdd", "https://x/b.mp4"],
      ["CMD:playlistAdd", { url: "https://x/c.mp4", name: "C" }],
      ["CMD:playlistMove", { index: 0, toIndex: 2 }],
      ["CMD:playlistDelete", 1],
      ["CMD:videoMeta", { url: "https://x/a.mp4", meta }],
      ["CMD:playbackIssue", { reason: "no audio" }],
      ["CMD:roomSettings", { title: "Movie night" }],
      ["CMD:roomPassword", { action: "regenerate" }],
      ["CMD:kickUser", { userToBeKicked: "bob" }],
      ["CMD:deleteRoom"],
      ["CMD:readyState", { ready: true }],
      ["CMD:readyCheckSkip"],
      ["CMD:nextEpisode", { action: "cancel" }],
      ["signalSS", { to: "bob", msg: { ice: {} }, sharer: true }],
      ["CMD:call", { action: "join" }],
      ["CMD:callSignal", { to: "bob", toSession: "s1", description: {} }],
      ["CMD:callModerate", { action: "mute", clientId: "bob" }],
    ]);
  });
});

describe("usePlaylist", () => {
  function setup(playlist: PlaylistVideo[]) {
    const cmd = {
      setMedia: vi.fn(),
      setVideoMeta: vi.fn(),
      playlistDelete: vi.fn(),
      playlistAdd: vi.fn(),
      playlistAddItem: vi.fn(),
      playlistMove: vi.fn(),
    };
    const { result } = renderHook(() => {
      const [, store] = useRoomStore({ playlist });
      return usePlaylist({ store, cmd: cmd as any });
    });
    return { p: result.current, cmd };
  }
  const meta = { source: "aiostreams", title: "Spring" } as any;

  it("plays an item now, restoring its metadata, and removes it", () => {
    const { p, cmd } = setup([
      { url: "https://x/a.mp4", name: "A" } as PlaylistVideo,
      { url: "https://x/b.mp4", name: "B", meta } as PlaylistVideo,
    ]);
    p.play(0);
    expect(cmd.setMedia).toHaveBeenLastCalledWith("https://x/a.mp4");
    expect(cmd.setVideoMeta).not.toHaveBeenCalled();
    expect(cmd.playlistDelete).toHaveBeenLastCalledWith(0);
    p.play(1);
    expect(cmd.setVideoMeta).toHaveBeenCalledWith("https://x/b.mp4", meta);
    // Out of range: nothing
    cmd.setMedia.mockClear();
    p.play(5);
    expect(cmd.setMedia).not.toHaveBeenCalled();
  });

  it("adds, moves and removes", () => {
    const { p, cmd } = setup([]);
    p.add("https://x/a.mp4");
    p.addItem({ url: "https://x/b.mp4", name: "B" });
    p.move(1, 0);
    p.remove(2);
    expect(cmd.playlistAdd).toHaveBeenCalledWith("https://x/a.mp4");
    expect(cmd.playlistAddItem).toHaveBeenCalledWith({
      url: "https://x/b.mp4",
      name: "B",
    });
    expect(cmd.playlistMove).toHaveBeenCalledWith(1, 0);
    expect(cmd.playlistDelete).toHaveBeenCalledWith(2);
  });
});

describe("useChat", () => {
  const play = vi.fn(async () => {});
  beforeEach(() => {
    play.mockClear();
    vi.stubGlobal(
      "Audio",
      vi.fn(function () {
        return { play };
      }),
    );
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function setup(init: Partial<RoomState> = {}) {
    const chatRef = { current: null as any };
    const hook = renderHook(() => {
      const [state, store] = useRoomStore(init);
      return { state, store, chat: useChat({ store, chatRef }) };
    });
    return { ...hook, chatRef };
  }
  const msg = (id: string, ts: string, extra: Partial<ChatMessage> = {}) =>
    ({ id, timestamp: ts, msg: "hi", ...extra }) as ChatMessage;

  it("counts unread messages and plays a sound when the chat tab isn't showing", () => {
    const { result } = setup({ currentTab: "people" });
    act(() => result.current.chat.onMessage(msg("a", "1")));
    expect(result.current.state.unreadCount).toBe(1);
    expect(play).toHaveBeenCalled();
  });

  it("no sound or unread count while reading the chat, and none for system lines", () => {
    const { result } = setup({ currentTab: "chat" });
    act(() => result.current.chat.onMessage(msg("a", "1")));
    expect(result.current.state.unreadCount).toBe(0);
    expect(play).not.toHaveBeenCalled();
    act(() => result.current.store.set({ currentTab: "none" }));
    act(() => result.current.chat.onMessage(msg("a", "2", { system: true })));
    expect(play).not.toHaveBeenCalled();
  });

  it("respects the 'disable chat sound' setting", () => {
    window.localStorage.setItem(
      "watchparty-setting",
      JSON.stringify({ disableChatSound: true }),
    );
    const { result } = setup({ currentTab: "people" });
    act(() => result.current.chat.onMessage(msg("a", "1")));
    expect(play).not.toHaveBeenCalled();
  });

  it("counts chat inits", () => {
    const { result } = setup();
    act(() => result.current.chat.onInit([msg("a", "1")]));
    act(() => result.current.chat.onInit([]));
    expect(result.current.state.chatInitCount).toBe(2);
    expect(result.current.state.chat).toEqual([]);
  });

  it("scrolls down when a reaction lands on the last message near the bottom", () => {
    vi.useFakeTimers();
    const { result, chatRef } = setup({
      chat: [msg("a", "1"), msg("b", "2")],
    });
    const scrollToBottom = vi.fn();
    chatRef.current = { state: { isNearBottom: true }, scrollToBottom };
    const reaction = (msgId: string, ts: string) => ({
      user: "c",
      value: "🎉",
      msgId,
      msgTimestamp: ts,
    });
    // Unknown message: ignored
    act(() => result.current.chat.onAddReaction(reaction("zz", "9")));
    // Not the last message: no scroll
    act(() => result.current.chat.onAddReaction(reaction("a", "1")));
    vi.runAllTimers();
    expect(scrollToBottom).not.toHaveBeenCalled();
    act(() => result.current.chat.onAddReaction(reaction("b", "2")));
    vi.runAllTimers();
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(result.current.state.chat[1].reactions).toEqual({ "🎉": ["c"] });
  });
});

describe("useSubtitles", () => {
  function setup(init: Partial<RoomState> = {}, youtube = false) {
    const html = { setSubtitleOffset: vi.fn() };
    const current = { loadSubtitles: vi.fn(), syncSubtitles: vi.fn() };
    const player = {
      html: () => html,
      current: () => current,
      usingNative: () => !youtube,
      usingYoutube: () => youtube,
    };
    const cmd = { setSubtitleOffset: vi.fn(), setSubtitleTiming: vi.fn() };
    const hook = renderHook(() => {
      const [state, store] = useRoomStore(init);
      return {
        state,
        store,
        subs: useSubtitles({
          store,
          player: player as any,
          clientId: "me",
          cmd: cmd as any,
        }),
      };
    });
    return { ...hook, html, current, cmd };
  }

  it("loads a room subtitle", () => {
    const { result, current } = setup();
    act(() => result.current.subs.onSubtitle("/subtitle/a"));
    expect(result.current.state.roomSubtitle).toBe("/subtitle/a");
    expect(current.loadSubtitles).toHaveBeenCalledWith("/subtitle/a");
  });

  it("follows another sharer's timing, not our own share", () => {
    const { result, current } = setup({
      roomSubtitle: "/subtitle/a",
      participants: [{ id: "alex", isScreenShare: true }],
      tsMap: { alex: 42 },
    });
    result.current.subs.syncToSharer();
    expect(current.syncSubtitles).toHaveBeenCalledWith(42);
    current.syncSubtitles.mockClear();
    act(() =>
      result.current.store.set({
        participants: [{ id: "me", isScreenShare: true }],
      }),
    );
    result.current.subs.syncToSharer();
    act(() => result.current.store.set({ roomSubtitle: "" }));
    result.current.subs.syncToSharer();
    expect(current.syncSubtitles).not.toHaveBeenCalled();
  });

  it("opens the modal on the native player and search except on YouTube", () => {
    const native = setup();
    act(() => native.result.current.subs.openModal());
    expect(native.result.current.state.isSubtitleModalOpen).toBe(true);
    act(() => native.result.current.subs.openSearch());
    expect(native.result.current.state.isSubtitleSearchOpen).toBe(true);

    const yt = setup({}, true);
    act(() => yt.result.current.subs.openModal());
    act(() => yt.result.current.subs.openSearch());
    expect(yt.result.current.state.isSubtitleModalOpen).toBe(false);
    expect(yt.result.current.state.isSubtitleSearchOpen).toBe(false);
  });

  it("'Just me' timing stays local and Reset drops it", () => {
    const { result, cmd, html } = setup({
      roomSubtitleOffset: 1,
      roomSubtitleScale: 1.04,
    });
    act(() => result.current.subs.setScope("me"));
    // Same scope again: nothing
    act(() => result.current.subs.setScope("me"));
    expect(result.current.state.localSubtitleOffset).toBe(1);
    act(() => {
      result.current.subs.setTiming(2, 0.96);
    });
    expect(result.current.subs.getTiming()).toEqual({ offset: 2, scale: 0.96 });
    act(() => {
      result.current.subs.nudgeOffset(0.1);
    });
    expect(result.current.subs.getTiming()).toEqual({
      offset: 2.1,
      scale: 0.96,
    });
    expect(cmd.setSubtitleOffset).not.toHaveBeenCalled();
    expect(cmd.setSubtitleTiming).not.toHaveBeenCalled();
    act(() => result.current.subs.resetOffset());
    expect(result.current.state.localSubtitleOffset).toBeNull();
    expect(html.setSubtitleOffset).toHaveBeenLastCalledWith(1, 1.04);
    act(() => result.current.subs.setScope("everyone"));
    expect(result.current.state.subtitleScope).toBe("everyone");
    // An auto-sync wand result for everyone is marked as such
    act(() => {
      result.current.subs.setTiming(3.2, 1, { auto: true });
    });
    expect(cmd.setSubtitleTiming).toHaveBeenLastCalledWith({
      offset: 3.2,
      scale: 1,
      auto: true,
    });
  });

  it("a local override without a scale uses 1", () => {
    const { result } = setup({
      localSubtitleOffset: 3,
      localSubtitleScale: null,
    });
    expect(result.current.subs.getTiming()).toEqual({ offset: 3, scale: 1 });
  });

  it("remote offsets keep the scale when none is sent", () => {
    const { result, html } = setup({ roomSubtitleScale: 1.04 });
    act(() => result.current.subs.onRemoteOffset(2));
    expect(html.setSubtitleOffset).toHaveBeenLastCalledWith(2, 1.04);
    act(() => result.current.subs.onRemoteOffset(1, 1));
    expect(html.setSubtitleOffset).toHaveBeenLastCalledWith(1, 1);
    act(() => result.current.subs.onHostOffset(undefined));
    expect(html.setSubtitleOffset).toHaveBeenLastCalledWith(0, 1);
  });
});

describe("useSubtitles: keeping subtitles for the next episode", () => {
  const ep = (n: number): VideoMeta => ({
    source: "aiostreams",
    type: "series",
    id: `tt1:1:${n}`,
    imdbId: "tt1",
    season: 1,
    episode: n,
    title: "Show",
    episodeTitle: null,
    poster: null,
    bingeGroup: null,
  });
  type T = {
    index: number;
    label: string;
    language: string;
    fromRoom: boolean;
  };

  function setup(init: Partial<RoomState> = {}, youtube = false) {
    let tracks: T[] = [];
    let selected = -1;
    const html = {
      setSubtitleOffset: vi.fn(),
      getSubtitleTracks: () => tracks,
      getSelectedSubtitleTrack: () => selected,
      selectSubtitleTrack: vi.fn((i: number) => (selected = i)),
    };
    const current = { loadSubtitles: vi.fn() };
    const player = {
      html: () => html,
      current: () => current,
      usingNative: () => !youtube,
      usingYoutube: () => youtube,
    };
    const cmd = { setSubtitle: vi.fn() };
    const hook = renderHook(() => {
      const [state, store] = useRoomStore(init);
      return {
        state,
        store,
        subs: useSubtitles({
          store,
          player: player as any,
          clientId: "me",
          cmd: cmd as any,
        }),
      };
    });
    const r = () => hook.result.current;
    /** REC:host + REC:videoMeta for the next video, as useRoom does it */
    const change = (meta: VideoMeta | null) => {
      r().subs.captureCarry();
      tracks = [];
      selected = -1;
      act(() =>
        r().store.set({
          roomMedia: "https://cdn/next",
          roomSubtitle: "",
          loading: true,
        }),
      );
      r().subs.applyCarry();
      act(() => r().store.set({ videoMeta: meta }));
      r().subs.onVideoMeta();
      r().subs.applyCarry();
    };
    return {
      r,
      html,
      current,
      cmd,
      change,
      setTracks: (t: T[], sel = selected) => {
        tracks = t;
        selected = sel;
      },
    };
  }

  const roomTrack: T = {
    index: 0,
    label: "English",
    language: "en",
    fromRoom: true,
  };

  it("picks the next episode's auto subtitle in the same language", () => {
    const { r, cmd, change, setTracks } = setup({
      roomMedia: "https://cdn/1",
      roomSubtitle: "https://subs/de1",
      videoMeta: ep(1),
      subtitleTracks: [
        { id: "a", label: "English", lang: "en", url: "https://subs/en1" },
        { id: "b", label: "German", lang: "de", url: "https://subs/de1" },
      ],
      subtitleTracksFor: ep(1).id,
    });
    setTracks([roomTrack], 0);
    change(ep(2));
    // The old title's auto subtitles are still in the store: not used
    expect(cmd.setSubtitle).not.toHaveBeenCalled();
    act(() =>
      r().store.set({
        subtitleTracks: [
          { id: "c", label: "English", lang: "en", url: "https://subs/en2" },
          { id: "d", label: "German", lang: "de", url: "https://subs/de2" },
        ],
        subtitleTracksFor: ep(2).id,
      }),
    );
    r().subs.applyCarry();
    expect(cmd.setSubtitle).toHaveBeenCalledWith("https://subs/de2");
    // Done: once only
    r().subs.applyCarry();
    expect(cmd.setSubtitle).toHaveBeenCalledTimes(1);
  });

  it("selects the same embedded track language again", () => {
    const { r, html, change, setTracks } = setup({
      roomMedia: "https://cdn/1.mkv",
    });
    setTracks(
      [
        { index: 0, label: "Deutsch", language: "de", fromRoom: false },
        { index: 1, label: "English", language: "en", fromRoom: false },
      ],
      1,
    );
    change(null);
    setTracks([
      { index: 0, label: "English", language: "eng", fromRoom: false },
    ]);
    r().subs.applyCarry();
    expect(html.selectSubtitleTrack).toHaveBeenLastCalledWith(0);
  });

  it("keeps the room subtitle off for a viewer who had it off", () => {
    const { r, html, change, setTracks } = setup({
      roomMedia: "https://cdn/1",
      roomSubtitle: "https://subs/en1",
      videoMeta: ep(1),
    });
    setTracks([roomTrack], -1);
    change(ep(2));
    // Someone else's carry loads the new room subtitle, which selects itself
    setTracks([roomTrack], 0);
    act(() => r().store.set({ roomSubtitle: "https://subs/en2" }));
    r().subs.applyCarry();
    expect(html.selectSubtitleTrack).toHaveBeenLastCalledWith(-1);
  });

  it("waits for the metadata, and forgets the choice for another title", () => {
    const { r, cmd, change, setTracks } = setup({
      roomMedia: "https://cdn/1",
      roomSubtitle: "/subtitle/x",
      videoMeta: ep(1),
    });
    setTracks([roomTrack], 0);
    // A pick sends REC:videoMeta null first, then the metadata
    change(null);
    act(() =>
      r().store.set({
        videoMeta: { ...ep(1), id: "tt7:1:1", imdbId: "tt7" },
        subtitleTracks: [{ id: "a", label: "English", url: "https://s" }],
        subtitleTracksFor: "tt7:1:1",
      }),
    );
    r().subs.applyCarry();
    act(() => r().store.set({ videoMeta: ep(2), subtitleTracksFor: ep(2).id }));
    r().subs.applyCarry();
    expect(cmd.setSubtitle).not.toHaveBeenCalled();
  });

  it("does nothing once something shows, after a minute, when joining or on YouTube", () => {
    vi.useFakeTimers();
    try {
      const a = setup({ roomMedia: "https://cdn/1" });
      a.setTracks(
        [{ index: 0, label: "En", language: "en", fromRoom: false }],
        0,
      );
      a.change(null);
      a.setTracks(
        [{ index: 0, label: "Fr", language: "fr", fromRoom: false }],
        0,
      );
      a.r().subs.applyCarry();
      a.setTracks(
        [{ index: 1, label: "En", language: "en", fromRoom: false }],
        -1,
      );
      a.r().subs.applyCarry();
      expect(a.html.selectSubtitleTrack).not.toHaveBeenCalled();

      const b = setup({ roomMedia: "https://cdn/1" });
      b.setTracks(
        [{ index: 0, label: "En", language: "en", fromRoom: false }],
        0,
      );
      b.change(null);
      vi.advanceTimersByTime(61_000);
      b.setTracks([{ index: 0, label: "En", language: "en", fromRoom: false }]);
      b.r().subs.applyCarry();
      expect(b.html.selectSubtitleTrack).not.toHaveBeenCalled();

      // Joining: no previous video
      const c = setup();
      c.setTracks(
        [{ index: 0, label: "En", language: "en", fromRoom: false }],
        0,
      );
      c.change(null);
      c.r().subs.applyCarry();
      expect(c.html.selectSubtitleTrack).not.toHaveBeenCalled();

      const d = setup({ roomMedia: "https://youtu.be/x" }, true);
      d.setTracks(
        [{ index: 0, label: "En", language: "en", fromRoom: false }],
        0,
      );
      d.change(null);
      d.r().subs.applyCarry();
      expect(d.html.selectSubtitleTrack).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the same room subtitle again just shows the loaded track", () => {
    const { r, html, current, setTracks } = setup({ roomSubtitle: "/s/a" });
    setTracks([roomTrack], -1);
    act(() => r().subs.onSubtitle("/s/a"));
    expect(html.selectSubtitleTrack).toHaveBeenCalledWith(0);
    expect(current.loadSubtitles).not.toHaveBeenCalled();
    // Not loaded yet (e.g. a failed download): load it
    setTracks([]);
    act(() => r().subs.onSubtitle("/s/a"));
    expect(current.loadSubtitles).toHaveBeenCalledWith("/s/a");
  });
});
