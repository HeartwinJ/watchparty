// The room page must never show an AIOStreams playback URL (it carries a debrid credential): the top bar, now-playing
// strip, player title, chat and queue all use the readable name the picker attaches to the URL.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDisplayName } from "./logic/media";

type Listener = (...args: any[]) => void;
class FakeSocket {
  listeners = new Map<string, Listener[]>();
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit() {
    return this;
  }
  disconnect() {
    return this;
  }
  receive(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
}
const sockets: FakeSocket[] = [];
vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }),
}));
vi.mock("../../utils/generateName", () => ({
  generateName: async () => "Sam",
}));
vi.mock("../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/api")>()),
  apiFetch: vi.fn(async () => new Response("[]")),
}));
vi.mock("../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/utils")>()),
  testAutoplay: async () => true,
}));
vi.mock("../../utils/clientTranscode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/clientTranscode")>()),
  probeMedia: async () => {
    throw new Error("not in tests");
  },
}));

const { App } = await import("./App");

const SECRET_HOST = "aio.example.com";
const RAW = `https://${SECRET_HOST}/api/v1/debrid/playback/eyFAKEBLOB/file.mkv`;
const NAME = "Example Show · S02E04";
const HOSTED = withDisplayName(RAW, NAME);

beforeEach(() => {
  sockets.length = 0;
  window.localStorage.clear();
});
afterEach(() => cleanup());

/** All text a person could see or hear: text content plus titles/labels/alt text */
function visibleStrings(root: HTMLElement): string {
  const attrs = [...root.querySelectorAll("*")].flatMap((el) =>
    ["title", "aria-label", "alt", "placeholder", "value"]
      .map((a) => el.getAttribute(a) ?? "")
      .filter(Boolean),
  );
  return [root.textContent ?? "", ...attrs].join("\n");
}

describe("room page", () => {
  it("never shows an AIOStreams playback URL", async () => {
    render(
      <MantineProvider env="test">
        <App urlRoomId="leak-room" />
      </MantineProvider>,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await act(async () => socket.receive("connect"));
    await act(async () => {
      socket.receive("roster", [{ id: "a" }]);
      socket.receive("REC:nameMap", { a: "Alex" });
      socket.receive("REC:host", {
        video: HOSTED,
        videoTS: 0,
        subtitle: "",
        paused: true,
        playbackRate: 1,
        loop: false,
      });
      socket.receive("REC:videoMeta", {
        source: "aiostreams",
        type: "series",
        id: "tt0000002:2:4",
        imdbId: "tt0000002",
        season: 2,
        episode: 4,
        title: "Example Show",
        episodeTitle: "Four",
        poster: null,
        bingeGroup: null,
      });
      socket.receive("chatinit", [
        {
          id: "a",
          cmd: "host",
          msg: HOSTED,
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          id: "a",
          cmd: "playlistAdd",
          msg: withDisplayName(RAW, "Example Show · S02E05"),
          timestamp: "2026-01-01T00:00:01Z",
        },
        // Automatic changes (queue, next episode) are named by the server from the metadata
        {
          id: "",
          cmd: "nowPlaying",
          msg: JSON.stringify({ via: "nextEpisode", title: NAME }),
          timestamp: "2026-01-01T00:00:02Z",
        },
        // ... or carry a URL with an attached display name when there's no title
        {
          id: "",
          cmd: "nowPlaying",
          msg: JSON.stringify({
            via: "queue",
            url: withDisplayName(RAW, "Example Show · S02E06"),
          }),
          timestamp: "2026-01-01T00:00:03Z",
        },
      ]);
      socket.receive("playlist", [
        {
          url: withDisplayName(RAW, "Example Show · S02E05"),
          name: "Example Show · S02E05",
          channel: "Movies & Shows",
          duration: 0,
          type: "file",
        },
      ]);
      // The next-episode card never gets a URL, only the episode's metadata
      socket.receive("REC:nextEpisode", {
        state: "offered",
        next: {
          meta: {
            source: "aiostreams",
            type: "series",
            id: "tt0000002:2:5",
            imdbId: "tt0000002",
            season: 2,
            episode: 5,
            title: "Example Show",
            episodeTitle: "Five",
            poster: null,
            bingeGroup: null,
          },
          thumbnail: null,
        },
        startAt: 1000,
      });
    });
    await waitFor(() => expect(document.body.textContent).toContain(NAME));
    expect(document.body.textContent).toContain("Up next · S02E05 · Five");
    expect(document.body.textContent).toContain(
      `Now playing ${NAME} (next episode)`,
    );
    expect(document.body.textContent).toContain(
      "Now playing Example Show · S02E06 (from the queue)",
    );
    const seen = visibleStrings(document.body);
    expect(seen).not.toContain(SECRET_HOST);
    expect(seen).not.toContain("eyFAKEBLOB");
    // "Search subtitles…" starts from the title/episode, never the URL
    fireEvent.click(
      screen.getByRole("button", { name: "Subtitles and audio" }),
    );
    fireEvent.click(await screen.findByText("Search subtitles…"));
    await screen.findByText("No subtitles found for this episode.");
    expect(document.body.textContent).toContain(NAME);
    const seenInSearch = visibleStrings(document.body);
    expect(seenInSearch).not.toContain(SECRET_HOST);
    expect(seenInSearch).not.toContain("eyFAKEBLOB");
    // The <video> element does get the real URL, of course
    expect(
      (document.getElementById("leftVideo") as HTMLVideoElement | null)?.src ??
        "",
    ).toContain(SECRET_HOST);
  });
});
