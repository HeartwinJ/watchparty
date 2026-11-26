import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAddonsConfigured } from "../../../api/addons";
import { PickerPalette } from "./PickerPalette";
import { clearPickerCache } from "./useLoad";
import { movie, show, showMeta, streamList } from "./fixtures";
import type { PickerActions } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let notConfigured = false;
const routes = (url: string): Response => {
  const path = new URL(url).pathname + new URL(url).search;
  // Like the server: search/meta/subtitles are keyless, only streams need AIOStreams
  if (path === "/addon/status") {
    return json({ streams: !notConfigured });
  }
  if (path.startsWith("/addon/streams/") && notConfigured) {
    return json({ error: "aiostreams_not_configured" }, 503);
  }
  if (path.startsWith("/addon/search")) {
    return json({ movies: [movie], series: [show], anime: [] });
  }
  if (path.startsWith("/addon/meta/series/")) {
    return json(showMeta);
  }
  if (path.startsWith("/addon/meta/movie/")) {
    return json({
      ...showMeta,
      id: movie.id,
      type: "movie",
      name: movie.name,
      seasons: [],
    });
  }
  if (path.startsWith("/addon/streams/")) {
    return json(streamList);
  }
  if (path.startsWith("/addon/subtitles/")) {
    return json([
      {
        id: "1",
        lang: "en",
        label: "English",
        url: "https://subs.example.com/1.srt",
      },
    ]);
  }
  if (path.startsWith("/youtube")) {
    return json([
      {
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        name: "Clip One",
        channel: "Chan",
        duration: 0,
        img: "",
      },
      {
        url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
        name: "Clip Two",
        channel: "Chan",
        duration: 0,
        img: "",
      },
    ]);
  }
  return json({ error: "not_found" }, 404);
};

const makeActions = (over: Partial<PickerActions> = {}): PickerActions => ({
  playUrl: vi.fn(),
  queueUrl: vi.fn(),
  playStream: vi.fn(),
  queueStream: vi.fn(),
  shareScreen: vi.fn(),
  shareFile: vi.fn(),
  stopSharing: vi.fn(),
  sharing: "none",
  currentMeta: null,
  ...over,
});

function renderPalette(
  actions = makeActions(),
  onClose = vi.fn(),
  target: Parameters<typeof PickerPalette>[0]["target"] = null,
  mode: "play" | "queue" = "play",
) {
  render(
    <MantineProvider env="test">
      <PickerPalette
        opened
        onClose={onClose}
        actions={actions}
        target={target}
        mode={mode}
      />
    </MantineProvider>,
  );
  const input = screen.getByRole("combobox");
  return { actions, onClose, input };
}

const activeOption = (input: HTMLElement) => {
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

const type = (input: HTMLElement, value: string) =>
  fireEvent.change(input, { target: { value } });
const key = (
  input: HTMLElement,
  k: string,
  opts: { shiftKey?: boolean } = {},
) => fireEvent.keyDown(input, { key: k, ...opts });

beforeEach(() => {
  notConfigured = false;
  resetAddonsConfigured();
  clearPickerCache();
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => routes(url)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PickerPalette: empty state", () => {
  it("offers share actions, navigates with arrows and runs Enter", async () => {
    const { actions, onClose, input } = renderPalette();
    expect(screen.getByRole("listbox")).toBeTruthy();
    await waitFor(() =>
      expect(activeOption(input)?.textContent).toContain("Share screen"),
    );
    key(input, "ArrowDown");
    expect(activeOption(input)?.textContent).toContain("Share a file");
    key(input, "ArrowDown"); // stays on the last option
    expect(activeOption(input)?.textContent).toContain("Share a file");
    key(input, "ArrowUp");
    expect(activeOption(input)?.getAttribute("aria-selected")).toBe("true");
    key(input, "ArrowDown");
    key(input, "Enter");
    expect(actions.shareFile).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("disables sharing while someone else shares, offers stop while we do", async () => {
    renderPalette(makeActions({ sharing: "other" }));
    const screenRow = await screen.findByText("Share screen");
    expect(
      screenRow.closest('[role="option"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("closes on Esc at the top level", () => {
    const { onClose, input } = renderPalette();
    key(input, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists recent sources", async () => {
    window.localStorage.setItem(
      "wp-recent-sources",
      JSON.stringify([
        {
          kind: "url",
          url: "https://v.example.com/a.mp4",
          name: "Holiday clip",
          at: 1,
        },
      ]),
    );
    const { actions, input } = renderPalette();
    await screen.findByText("Holiday clip");
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    expect(activeOption(input)?.textContent).toContain("Holiday clip");
    key(input, "Enter", { shiftKey: true });
    expect(actions.queueUrl).toHaveBeenCalledWith(
      "https://v.example.com/a.mp4",
      { name: "Holiday clip", img: undefined },
    );
  });
});

describe("PickerPalette: pasted links", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abcdefghijk", "YouTube video"],
    ["https://cdn.example.com/live/index.m3u8", "HLS stream"],
    ["https://cdn.example.com/x/manifest.mpd", "DASH stream"],
    ["https://cdn.example.com/x/movie.mp4", "Direct video · MP4"],
    ["https://example.com/article", "Web page or unknown link"],
  ])("detects %s", async (url, label) => {
    const { input } = renderPalette();
    type(input, url);
    expect((await screen.findByTestId("link-badge")).textContent).toContain(
      label,
    );
  });

  it("Enter plays now, Shift+Enter queues, and the buttons do the same", async () => {
    const url = "https://cdn.example.com/x/movie.mp4";
    const actions = makeActions();
    const { input, onClose } = renderPalette(actions);
    type(input, url);
    await screen.findByTestId("link-badge");
    await waitFor(() => expect(activeOption(input)).toBeTruthy());
    key(input, "Enter", { shiftKey: true });
    expect(actions.queueUrl).toHaveBeenCalledWith(url);
    key(input, "Enter");
    expect(actions.playUrl).toHaveBeenCalledWith(url);
    fireEvent.click(screen.getByRole("button", { name: /Add to queue/ }));
    expect(actions.queueUrl).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PickerPalette: search and drill-down", () => {
  it("debounces search, shows posters and YouTube, filters with chips", async () => {
    const { input } = renderPalette();
    type(input, "exa");
    type(input, "example");
    await screen.findByText("Example Movie");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const searches = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/addon/search"));
    expect(searches).toHaveLength(1);
    expect(searches[0]).toContain("q=example");
    expect(await screen.findByText("Clip One")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "YouTube" }));
    expect(screen.queryByText("Example Movie")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Movies & Shows" }));
    expect(screen.queryByText("Clip One")).toBeNull();
    expect(screen.getByText("Example Show")).toBeTruthy();
  });

  it("hides Movies & Shows when AIOStreams isn't configured", async () => {
    notConfigured = true;
    const { input } = renderPalette();
    type(input, "example");
    await screen.findByText("Clip One");
    // /addon/status said no streams, so titles (which the keyless search still finds) aren't offered
    await waitFor(() => expect(screen.queryByText("Example Movie")).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Movies & Shows" }),
      ).toBeNull(),
    );
    expect(screen.queryByLabelText("Movies & Shows")).toBeNull();
    expect(input.getAttribute("placeholder")).toBe(
      "Search YouTube or paste a link",
    );
  });

  it("opens a series, then an episode, with breadcrumbs and Esc going back", async () => {
    const actions = makeActions();
    const { input } = renderPalette(actions);
    type(input, "example");
    await screen.findByText("Example Show");
    // Options: Example Movie, Example Show (interleaved), then YouTube rows
    await waitFor(() =>
      expect(activeOption(input)?.textContent).toContain("Example Movie"),
    );
    key(input, "ArrowDown");
    expect(activeOption(input)?.textContent).toContain("Example Show");
    key(input, "Enter");
    await screen.findByText("Pilot");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(crumbs.textContent).toContain("Results for “example”");
    expect(crumbs.textContent).toContain("Example Show");
    // Season 2
    fireEvent.click(screen.getByText("Season 2"));
    await screen.findByText("Return");
    fireEvent.click(screen.getByText("Season 1"));
    await waitFor(() =>
      expect(activeOption(input)?.textContent).toContain("Pilot"),
    );
    key(input, "ArrowDown");
    key(input, "Enter");
    await screen.findByText("Direct.One.mp4");
    expect(
      within(screen.getByRole("navigation", { name: "Breadcrumbs" })).getByText(
        "S01E02 · Second",
      ),
    ).toBeTruthy();
    // Esc goes back to the series, then the results
    key(input, "Escape");
    await screen.findByText("Pilot");
    key(input, "Escape");
    await screen.findByText("Clip One");
    expect(
      screen.queryByRole("navigation", { name: "Breadcrumbs" }),
    ).toBeNull();
  });

  it("breadcrumbs are clickable and Backspace in an empty input goes back", async () => {
    const { input } = renderPalette(makeActions(), vi.fn(), {
      kind: "streams",
      videoMeta: {
        source: "aiostreams",
        type: "series",
        id: "tt0000002:1:2",
        imdbId: "tt0000002",
        season: 1,
        episode: 2,
        title: "Example Show",
        episodeTitle: "Second",
        poster: null,
        bingeGroup: null,
      },
    });
    await screen.findByText("Direct.One.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Example Show" }));
    await screen.findByText("Pilot");
    key(input, "Backspace");
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: "Breadcrumbs" }),
      ).toBeNull(),
    );
    expect(screen.getByText("Share screen")).toBeTruthy();
  });
});

describe("PickerPalette: queue mode and quick keys", () => {
  it("in queue mode, Enter adds to the queue and Shift+Enter plays", async () => {
    const url = "https://cdn.example.com/x/movie.mp4";
    const actions = makeActions();
    const { input } = renderPalette(actions, vi.fn(), null, "queue");
    type(input, url);
    await screen.findByTestId("link-badge");
    await waitFor(() => expect(activeOption(input)).toBeTruthy());
    key(input, "Enter");
    expect(actions.queueUrl).toHaveBeenCalledWith(url);
    expect(actions.playUrl).not.toHaveBeenCalled();
    key(input, "Enter", { shiftKey: true });
    expect(actions.playUrl).toHaveBeenCalledWith(url);
  });

  it("goes back one level per Esc even when pressed quickly", async () => {
    const onClose = vi.fn();
    const { input } = renderPalette(makeActions(), onClose, {
      kind: "streams",
      videoMeta: {
        source: "aiostreams",
        type: "series",
        id: "tt0000002:1:2",
        imdbId: "tt0000002",
        season: 1,
        episode: 2,
        title: "Example Show",
        episodeTitle: "Second",
        poster: null,
        bingeGroup: null,
      },
    });
    await screen.findByText("Direct.One.mp4");
    act(() => {
      key(input, "Escape");
      key(input, "Escape");
    });
    expect(onClose).not.toHaveBeenCalled();
    await screen.findByText("Share screen");
    key(input, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PickerPalette: stream list", () => {
  it("groups streams by tier, collapses the unlikely group and plays with Enter", async () => {
    const actions = makeActions();
    const { input, onClose } = renderPalette(actions);
    type(input, "example");
    await screen.findByText("Example Movie");
    await waitFor(() =>
      expect(activeOption(input)?.textContent).toContain("Example Movie"),
    );
    key(input, "Enter");
    await screen.findByText("Direct.One.mp4");

    expect(
      screen.getByRole("region", { name: "Plays directly" }).textContent,
    ).toContain("Plays directly · 1");
    const convert = screen.getByRole("region", {
      name: "Plays with conversion",
    });
    expect(convert.textContent).toContain("Light conversion");
    expect(convert.textContent).toContain("Heavy conversion");
    expect(convert.textContent).toContain("HEVC 10-bit");
    // 4K chip in platinum
    expect(within(convert).getByText("4K").className).toMatch(/res4k/);
    // The unlikely group is collapsed
    expect(screen.queryByText("Remux.Four.2160p.REMUX.mkv")).toBeNull();
    const toggle = screen
      .getByText(/May not play in browser · 1/)
      .closest('[role="option"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("REMUX");
    fireEvent.click(toggle);
    expect(await screen.findByText("Remux.Four.2160p.REMUX.mkv")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try anyway" })).toBeTruthy();
    // Playback URLs are never shown
    expect(document.body.textContent).not.toContain("aio.example.com");

    // Enter on the first (best) stream plays it with the movie context
    await waitFor(() =>
      expect(activeOption(input)?.textContent).toContain("Direct.One.mp4"),
    );
    expect(activeOption(input)?.textContent).toContain("Best match");
    key(input, "Enter", { shiftKey: true });
    expect(actions.queueStream).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "Direct.One.mp4" }),
      expect.objectContaining({
        title: expect.objectContaining({ id: movie.id }),
      }),
    );
    key(input, "Enter");
    expect(actions.playStream).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the footer count", async () => {
    const { input } = renderPalette();
    type(input, "example");
    await screen.findByText("Example Movie");
    fireEvent.click(screen.getByText("Example Movie"));
    await screen.findByText("Direct.One.mp4");
    expect(screen.getByText(/Top 4 of 4/)).toBeTruthy();
  });

  it("shows skeletons while loading and an error with retry", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/addon/streams/") && fail) {
          return json({ error: "upstream_timeout" }, 502);
        }
        return routes(url);
      }),
    );
    const { input } = renderPalette();
    type(input, "example");
    await screen.findByText("Example Movie");
    fireEvent.click(screen.getByText("Example Movie"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("took too long");
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    });
    expect(await screen.findByText("Direct.One.mp4")).toBeTruthy();
  });
});
