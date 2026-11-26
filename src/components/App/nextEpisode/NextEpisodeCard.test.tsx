import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextEpisodeView } from "./NextEpisodeCard";

const meta: VideoMeta = {
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
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NextEpisodeView", () => {
  it("shows the episode, a live countdown and the actions", () => {
    vi.useFakeTimers();
    let time = 1180;
    const onPlayNow = vi.fn();
    const onCancel = vi.fn();
    render(
      <MantineProvider env="test">
        <NextEpisodeView
          next={{ meta, thumbnail: "https://images.example/t.jpg" }}
          startAt={1200}
          window={25}
          getTime={() => time}
          onPlayNow={onPlayNow}
          onCancel={onCancel}
        />
      </MantineProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Up next · S01E03 · Third",
    );
    expect(screen.getByText("Starts in 20 s")).toBeTruthy();
    time = 1195.5;
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("Starts in 5 s")).toBeTruthy();
    time = 1200;
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("Starting…")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Play now/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onPlayNow).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("region", { name: "Up next" }).querySelector("img")?.src,
    ).toBe("https://images.example/t.jpg");
  });
});
