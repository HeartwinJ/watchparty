import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../hooks/useRoom";
import { getConvertStatus } from "../hooks/useConvert";
import {
  getAttachedDisplayName,
  getMediaDisplayName,
  withDisplayName,
} from "../logic/media";
import { usePickerActions } from "./SourcePicker";
import { loadRecents } from "./pickerLogic";
import { show, stream } from "./fixtures";

function fakeRoom(over: Partial<Room["state"]> = {}) {
  const room = {
    clientId: "me",
    cmd: { setMedia: vi.fn(), setVideoMeta: vi.fn() },
    playlist: { add: vi.fn(), addItem: vi.fn() },
    store: { set: vi.fn() },
    share: { stopPublishing: vi.fn() },
    state: { participants: [], isPublishing: false, videoMeta: null, ...over },
  };
  return room as unknown as Room & {
    cmd: Record<string, ReturnType<typeof vi.fn>>;
  };
}

beforeEach(() => window.localStorage.clear());

describe("usePickerActions", () => {
  it("plays an AIOStreams stream with a readable name and sends its metadata", () => {
    const room = fakeRoom();
    const { result } = renderHook(() => usePickerActions(room));
    const episode = {
      id: "tt0000002:2:4",
      season: 2,
      episode: 4,
      title: "Four",
      released: null,
      thumbnail: null,
    };
    result.current.playStream(stream({ bingeGroup: "grp" }), {
      title: show,
      episode,
    });
    const url = (room.cmd.setMedia as any).mock.calls[0][0] as string;
    expect(url.startsWith(stream().url)).toBe(true);
    expect(getAttachedDisplayName(url)).toBe("Example Show · S02E04");
    expect(room.cmd.setVideoMeta).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        id: "tt0000002:2:4",
        season: 2,
        episode: 4,
        bingeGroup: "grp",
        title: "Example Show",
      }),
    );
    // Remembered as a title, not as the playback URL
    expect(loadRecents()[0]).toMatchObject({ kind: "title" });
    expect(window.localStorage.getItem("wp-recent-sources")).not.toContain(
      "aio.example.com",
    );
  });

  it("queues a stream with its name, poster and metadata", () => {
    const room = fakeRoom();
    const { result } = renderHook(() => usePickerActions(room));
    result.current.queueStream(stream(), { title: show });
    expect(room.playlist.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Example Show",
        img: show.poster,
        meta: expect.objectContaining({ id: show.id, type: "series" }),
      }),
    );
  });

  it("plays and queues plain links like the old toolbar", () => {
    const room = fakeRoom();
    const { result } = renderHook(() => usePickerActions(room));
    result.current.playUrl("https://v.example.com/a.mp4");
    expect(room.cmd.setMedia).toHaveBeenCalledWith(
      "https://v.example.com/a.mp4",
    );
    result.current.queueUrl("https://v.example.com/b.mp4");
    expect(room.playlist.add).toHaveBeenCalledWith(
      "https://v.example.com/b.mp4",
    );
    result.current.shareScreen();
    expect(room.store.set).toHaveBeenCalledWith({
      isScreenShareModalOpen: true,
    });
    result.current.shareFile();
    expect(room.store.set).toHaveBeenCalledWith({ isFileShareModalOpen: true });
  });

  it("reports who is sharing", () => {
    expect(
      renderHook(() => usePickerActions(fakeRoom({ isPublishing: true })))
        .result.current.sharing,
    ).toBe("me");
    expect(
      renderHook(() =>
        usePickerActions(
          fakeRoom({ participants: [{ id: "x", isScreenShare: true }] }),
        ),
      ).result.current.sharing,
    ).toBe("other");
  });
});

describe("display names", () => {
  it("round-trips a name through the URL fragment and shows it instead of the URL", () => {
    const url = withDisplayName(
      "https://aio.example.com/playback/x.mkv",
      "Show · S01E02 & more",
    );
    expect(url).toBe(
      "https://aio.example.com/playback/x.mkv#wp-name=Show%20%C2%B7%20S01E02%20%26%20more",
    );
    expect(
      getMediaDisplayName(url, {
        roomMedia: url,
        participants: [],
        nameMap: {},
      }),
    ).toBe("Show · S01E02 & more");
    const withHash = withDisplayName("https://v.example.com/a.mp4#t=10", "A");
    expect(withHash).toBe("https://v.example.com/a.mp4#t=10&wp-name=A");
    expect(getAttachedDisplayName(withHash)).toBe("A");
    expect(
      getAttachedDisplayName("https://v.example.com/a.mp4"),
    ).toBeUndefined();
  });
});

describe("getConvertStatus", () => {
  it("describes conversion progress", () => {
    expect(
      getConvertStatus({
        playback: { mode: "direct" },
        convertProgress: undefined,
      }),
    ).toBeNull();
    expect(
      getConvertStatus({
        playback: { mode: "convert", heavy: true, reason: "HEVC" },
        convertProgress: 0.342,
      }),
    ).toEqual({
      label: "Converting · 34% buffered",
      progress: 0.342,
      heavy: true,
      reason: "HEVC",
    });
  });
});
