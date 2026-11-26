// useNextEpisode: offers sent while an episode nears its end, and the room-wide outcomes as toasts + the player OSD.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const toast = vi.fn();
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toast: (...args: unknown[]) => toast(...args),
}));
const openPicker = vi.fn();
const openPickerAt = vi.fn();
vi.mock("../ui/RoomUi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/RoomUi")>()),
  useRoomUi: () => ({ openPicker, openPickerAt }),
}));

const { useNextEpisode } = await import("./useNextEpisode");
const { useStore } = await import("../hooks/useStore");
const { createInitialRoomState } = await import("../roomState");
type RoomState = import("../roomState").RoomState;

const URL_ = "https://cdn.example.com/ep1.mkv#wp-name=Show";
const episode = {
  source: "aiostreams",
  type: "series",
  id: "tt1:1:1",
  imdbId: "tt1",
  season: 1,
  episode: 1,
  title: "Show",
  episodeTitle: "Pilot",
  poster: null,
  bingeGroup: null,
} as unknown as VideoMeta;
const nextInfo = {
  meta: { ...episode, episode: 2, episodeTitle: "Two" },
  thumbnail: null,
} as unknown as NextEpisodeInfo;

let time = 0;
let duration = 1000;
let youtube = false;

function setup(init: Record<string, unknown> = {}) {
  const cmd = { nextEpisode: vi.fn() };
  const player = {
    usingYoutube: () => youtube,
    current: () => ({
      getCurrentTime: () => time,
      getDuration: () => duration,
    }),
  };
  const hook = renderHook(() => {
    const [state, store] = useStore<RoomState>(() => ({
      ...createInitialRoomState(),
      roomMedia: URL_,
      videoMeta: episode,
      ...init,
    }));
    const room = { state, store, player, cmd, clientId: "me" } as any;
    return { store, ne: useNextEpisode(room) };
  });
  const receive = (s: Record<string, unknown>) =>
    act(() =>
      hook.result.current.store.set({
        nextEpisode: { ...s, at: Date.now() + Math.random() } as any,
      }),
    );
  return { ...hook, cmd, receive };
}

beforeEach(() => {
  vi.useFakeTimers();
  time = 0;
  duration = 1000;
  youtube = false;
  toast.mockClear();
  openPicker.mockClear();
  openPickerAt.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("useNextEpisode offers", () => {
  it("offers within the room's window, repeating every 5 s", () => {
    const { cmd } = setup();
    time = 100;
    act(() => vi.advanceTimersByTime(3000));
    expect(cmd.nextEpisode).not.toHaveBeenCalled();
    time = 980;
    act(() => vi.advanceTimersByTime(1000));
    expect(cmd.nextEpisode).toHaveBeenCalledWith({
      action: "offer",
      url: URL_,
      time: 980,
      duration: 1000,
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(cmd.nextEpisode).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(cmd.nextEpisode).toHaveBeenCalledTimes(2);
  });

  it("doesn't offer for movies, without media, or on YouTube", () => {
    time = 990;
    const movie = setup({ videoMeta: { ...episode, episode: null } });
    act(() => vi.advanceTimersByTime(2000));
    expect(movie.cmd.nextEpisode).not.toHaveBeenCalled();
    movie.unmount();

    const none = setup({ roomMedia: "" });
    act(() => vi.advanceTimersByTime(2000));
    expect(none.cmd.nextEpisode).not.toHaveBeenCalled();
    none.unmount();

    youtube = true;
    const yt = setup();
    act(() => vi.advanceTimersByTime(2000));
    expect(yt.cmd.nextEpisode).not.toHaveBeenCalled();
  });

  it("stops offering once the media changed", () => {
    time = 990;
    const { cmd, result } = setup();
    act(() =>
      result.current.store.set({
        roomMedia: "https://x/other.mp4",
        videoMeta: null,
      }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(cmd.nextEpisode).not.toHaveBeenCalled();
  });

  it("exposes the offered card and the room-wide actions", () => {
    const { result, cmd, receive } = setup();
    expect(result.current.ne.offered).toBeNull();
    receive({ state: "offered", next: nextInfo, startAt: 1000 });
    expect(result.current.ne.offered).toMatchObject({ state: "offered" });
    result.current.ne.playNow();
    result.current.ne.cancel();
    expect(cmd.nextEpisode.mock.calls).toEqual([
      [{ action: "playNow" }],
      [{ action: "cancel" }],
    ]);
  });
});

describe("useNextEpisode outcomes", () => {
  it("toasts who cancelled and shows it on the player", () => {
    const { result, receive } = setup({ nameMap: { alex: "Alex" } });
    receive({ state: "cancelled", by: { id: "alex", name: "" } });
    expect(toast).toHaveBeenCalledWith("Alex cancelled the next episode", {
      id: "wp-next-episode",
    });
    expect(result.current.store.get().playerNotice?.text).toBe(
      "Alex cancelled the next episode",
    );
  });

  it("says nothing for an offer", () => {
    const { receive } = setup();
    receive({ state: "offered", next: nextInfo, startAt: 1000 });
    expect(toast).not.toHaveBeenCalled();
  });

  it("a failure offers the picker on the next episode's streams", () => {
    const { receive } = setup();
    receive({ state: "failed", next: nextInfo });
    const [text, opts] = toast.mock.calls[0];
    expect(text).toBe("Couldn't find the next episode");
    expect(opts).toMatchObject({ tone: "warning", id: "wp-next-episode" });
    opts.action.onClick();
    expect(openPickerAt).toHaveBeenCalledWith({
      kind: "streams",
      videoMeta: nextInfo.meta,
    });
  });

  it("a failure without a known episode opens the plain picker", () => {
    const { receive } = setup();
    receive({ state: "failed", next: null });
    toast.mock.calls[0][1].action.onClick();
    expect(openPicker).toHaveBeenCalled();
  });

  it("doesn't repeat an event that arrived before it mounted", () => {
    setup({
      nextEpisode: { state: "failed", next: null, at: 123 },
    });
    expect(toast).not.toHaveBeenCalled();
  });
});
