// SourcePicker mounted in a room: the room-wide "can't play this stream" toasts and their actions, the palette
// following useRoomUi(), and the remaining picker actions (named queue items, stop sharing, sharing by me).
import { act, cleanup, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcodeSupported = vi.fn(() => true);
vi.mock("../../../utils/clientTranscode", () => ({
  isClientTranscodeSupported: () => transcodeSupported(),
}));
const toastMock = vi.fn();
vi.mock("../ui/toast", () => ({ toast: (...a: unknown[]) => toastMock(...a) }));
vi.mock("./useAutoSubtitles", () => ({ useAutoSubtitles: () => {} }));
vi.mock("./PickerPalette", () => ({
  PickerPalette: (p: { opened: boolean; mode: string; target: unknown }) => (
    <div data-testid="palette">
      {p.opened ? `open:${p.mode}:${JSON.stringify(p.target)}` : "closed"}
    </div>
  ),
}));

const { SourcePicker, usePickerActions } = await import("./SourcePicker");
const { fakeRoom, renderUi } = await import("../../../test/renderRoom");
const { useRoomUi } = await import("../ui/RoomUi");

beforeEach(() => {
  toastMock.mockClear();
  transcodeSupported.mockReturnValue(true);
});
afterEach(() => cleanup());

const meta = {
  source: "aiostreams",
  type: "series",
  id: "tt1:1:2",
  imdbId: "tt1",
  season: 1,
  episode: 2,
  title: "Show",
  episodeTitle: null,
  poster: null,
  bingeGroup: null,
} as unknown as VideoMeta;

let ui: ReturnType<typeof useRoomUi>;
const Grab = () => {
  ui = useRoomUi();
  return null;
};

function mount(over: Parameters<typeof fakeRoom>[0]) {
  const room = fakeRoom(over);
  const video = { currentTime: 42 };
  room.player.html.mockReturnValue({ getVideoEl: () => video } as any);
  const r = renderUi(
    <>
      <SourcePicker room={room} />
      <Grab />
    </>,
  );
  return { room, ...r };
}

describe("playback issue toasts", () => {
  it("offers Pick another and Share converted stream to someone who can play it", () => {
    const { room } = mount({
      videoMeta: meta,
      roomMedia: "https://v.example.com/a.mkv",
      playback: { mode: "direct" },
      playbackIssue: { userId: "bob", name: "Bob", reason: "AC-3 audio" },
    } as any);
    const [message, opts] = toastMock.mock.calls[0];
    expect(message).toBe("Bob can't play this stream: AC-3 audio");
    expect(opts).toMatchObject({
      tone: "warning",
      id: "wp-issue-bob",
      duration: 10000,
    });
    expect(opts.actions.map((a: { label: string }) => a.label)).toEqual([
      "Pick another",
      "Share converted stream",
    ]);
    act(() => opts.actions[0].onClick());
    expect(screen.getByTestId("palette").textContent).toBe(
      `open:play:${JSON.stringify({ kind: "streams", videoMeta: meta })}`,
    );
    opts.actions[1].onClick();
    expect(room.share.startUrlShare).toHaveBeenCalledWith(
      "https://v.example.com/a.mkv",
      { startTime: 42, meta },
    );
  });

  it("says You for your own issue, without sharing", () => {
    mount({
      videoMeta: null,
      roomMedia: "https://v.example.com/a.mkv",
      playback: { mode: "fail", reason: "x" },
      playbackIssue: { userId: "me", name: "Me", reason: "HEVC" },
    } as any);
    const [message, opts] = toastMock.mock.calls[0];
    expect(message).toBe("You can't play this stream: HEVC");
    expect(opts.actions).toEqual([]);
    expect(opts.duration).toBe(6000);
  });

  it("doesn't offer sharing without WebCodecs or for non-direct links", () => {
    transcodeSupported.mockReturnValue(false);
    mount({
      videoMeta: null,
      roomMedia: "https://v.example.com/a.mkv",
      playback: { mode: "convert", heavy: false, reason: "" },
      playbackIssue: { userId: "bob", name: "Bob", reason: "r" },
    } as any);
    expect(toastMock.mock.calls[0][1].actions).toEqual([]);
    cleanup();
    toastMock.mockClear();
    transcodeSupported.mockReturnValue(true);
    mount({
      videoMeta: null,
      roomMedia: "https://www.youtube.com/watch?v=x",
      playback: { mode: "direct" },
      playbackIssue: { userId: "bob", name: "Bob", reason: "r" },
    } as any);
    expect(toastMock.mock.calls[0][1].actions).toEqual([]);
  });

  it("shows nothing without an issue, and the palette follows the room UI", () => {
    mount({});
    expect(toastMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("palette").textContent).toBe("closed");
    act(() => ui.openPicker({ mode: "queue" }));
    expect(screen.getByTestId("palette").textContent).toMatch(/^open:queue/);
  });
});

describe("usePickerActions", () => {
  it("queues a named link, stops sharing, and counts my own share as mine", () => {
    const room = fakeRoom({
      participants: [{ id: "me", isScreenShare: true }],
    });
    const { result } = renderHook(() => usePickerActions(room));
    expect(result.current.sharing).toBe("me");
    result.current.queueUrl("https://v.example.com/a.mp4", {
      name: "A",
      img: "https://img.example.com/a.jpg",
    });
    expect(room.playlist.addItem).toHaveBeenCalledWith({
      url: "https://v.example.com/a.mp4",
      name: "A",
      img: "https://img.example.com/a.jpg",
    });
    result.current.stopSharing();
    expect(room.share.stopPublishing).toHaveBeenCalled();
    result.current.playUrl("https://v.example.com/b.mp4", { name: "B" });
    expect(room.cmd.setMedia).toHaveBeenCalledWith(
      "https://v.example.com/b.mp4",
    );
    expect(
      renderHook(() => usePickerActions(fakeRoom())).result.current.sharing,
    ).toBe("none");
  });
});
