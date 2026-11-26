// The room-bound notices over the player: "Skipped intro" and the "Up next" card.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntroSkipNotice } from "../introSkip/IntroSkipNotice";
import { NextEpisodeCard } from "../nextEpisode/NextEpisodeCard";
import { renderWithPlayerRoom } from "../../../test/playerRoom";

const MEDIA = "https://example.com/show-s01e02.mp4";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("IntroSkipNotice", () => {
  it("shows for 10 s after a skip, then goes away on its own", () => {
    renderWithPlayerRoom((room) => <IntroSkipNotice room={room} />, {
      state: { roomMedia: MEDIA, introSkip: { seconds: 90, at: Date.now() } },
    });
    expect(screen.getByRole("status").textContent).toContain("1:30");
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Watch from start seeks the room to 0 and hides it", () => {
    const r = renderWithPlayerRoom((room) => <IntroSkipNotice room={room} />, {
      state: { roomMedia: MEDIA, introSkip: { seconds: 45, at: Date.now() } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Watch from start" }));
    expect(r.player.roomSeek).toHaveBeenCalledWith(0);
    expect(screen.queryByRole("status")).toBeNull();
    // A new skip shows again
    r.setState({ introSkip: { seconds: 30, at: Date.now() + 1 } });
    expect(screen.getByRole("status").textContent).toContain("0:30");
  });

  it("never for live streams or without a skip", () => {
    const r = renderWithPlayerRoom((room) => <IntroSkipNotice room={room} />, {
      state: {
        roomMedia: MEDIA,
        isLiveStream: true,
        introSkip: { seconds: 45, at: Date.now() },
      },
    });
    expect(screen.queryByRole("status")).toBeNull();
    r.setState({ isLiveStream: false, introSkip: null });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("NextEpisodeCard", () => {
  const next: NextEpisodeInfo = {
    meta: {
      source: "aiostreams",
      type: "series",
      id: "tt0000001:1:3",
      imdbId: "tt0000001",
      season: 1,
      episode: 3,
      title: "Example Show",
      episodeTitle: "Third",
      poster: null,
      bingeGroup: null,
    },
    thumbnail: null,
  } as NextEpisodeInfo;

  it("shows the offer with a countdown from this player's time; Play now / Cancel ask the room", () => {
    const r = renderWithPlayerRoom((room) => <NextEpisodeCard room={room} />, {
      state: {
        roomMedia: MEDIA,
        nextEpisode: { state: "offered", next, startAt: 620, at: 0 },
      },
      media: { time: 600, duration: 620 },
    });
    expect(screen.getByText("Starts in 20 s")).toBeTruthy();
    r.media.time = 615;
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("Starts in 5 s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play now" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(r.socket.emits("CMD:nextEpisode")).toEqual([
      [{ action: "playNow" }],
      [{ action: "cancel" }],
    ]);
  });

  it("renders nothing without an offer or without media", () => {
    const r = renderWithPlayerRoom((room) => <NextEpisodeCard room={room} />, {
      state: {
        roomMedia: "",
        nextEpisode: { state: "offered", next, startAt: 620, at: 0 },
      },
    });
    expect(screen.queryByRole("region", { name: "Up next" })).toBeNull();
    r.setState({
      roomMedia: MEDIA,
      nextEpisode: { state: "none", at: 0 },
    });
    expect(screen.queryByRole("region", { name: "Up next" })).toBeNull();
  });
});
