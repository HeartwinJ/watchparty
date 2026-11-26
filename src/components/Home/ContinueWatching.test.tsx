// Home's "Continue watching" row, and a guard that the home page never shows a video URL (AIOStreams playback URLs
// carry a debrid credential; the history API leaves URLs out, and nothing on Home may put one back).
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
import type { HistoryItem } from "../../utils/history";

const navigate = vi.fn();
vi.mock("../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../router")>()),
  navigate: (...args: unknown[]) => navigate(...args),
}));

let historyItems: unknown[] = [];
const calls: { url: string; method: string }[] = [];
vi.mock("../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/api")>()),
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.startsWith("/history?")) {
      return new Response(JSON.stringify(historyItems));
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/resume")) {
      return new Response(JSON.stringify({ roomId: "brave-otter" }));
    }
    return new Response("[]");
  }),
}));

const { Home } = await import("./Home");

const SECRET_HOST = "aio.example.com";
const SECRET_BLOB = "eyFAKEBLOB";

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  id: 1,
  roomId: "/old-room",
  kind: "aiostreams",
  title: "Example Show",
  subtitle: "S02E04 · The Fourth",
  poster: "https://images.example.com/poster.jpg",
  position: 600,
  duration: 3000,
  updatedAt: 100,
  finished: false,
  group: "meta:tt0000001",
  ...over,
});

function renderHome() {
  return render(
    <MantineProvider env="test">
      <Home />
    </MantineProvider>,
  );
}

/** All text a person could see, plus attributes that hold text or links */
function visibleStrings(root: HTMLElement): string {
  const attrs = [...root.querySelectorAll("*")].flatMap((el) =>
    ["title", "aria-label", "alt", "placeholder", "value", "href"]
      .map((a) => el.getAttribute(a) ?? "")
      .filter(Boolean),
  );
  return [root.textContent ?? "", ...attrs].join("\n");
}

beforeEach(() => {
  historyItems = [];
  calls.length = 0;
  navigate.mockClear();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("Continue watching", () => {
  it("is hidden when there's nothing to continue", async () => {
    historyItems = [item({ finished: true })];
    renderHome();
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/history"))).toBe(true),
    );
    await act(async () => {});
    expect(screen.queryByText("Continue watching")).toBeNull();
  });

  it("shows one card per title with progress and time left", async () => {
    historyItems = [
      item({ id: 2, updatedAt: 300 }),
      item({
        id: 1,
        updatedAt: 200,
        subtitle: "S02E03",
      }),
      item({
        id: 3,
        updatedAt: 100,
        kind: "youtube",
        title: "A clip",
        subtitle: null,
        poster: null,
        duration: null,
        position: 75,
        group: "url:abc",
      }),
    ];
    renderHome();
    expect(await screen.findByText("Continue watching")).toBeTruthy();
    const cards = screen.getAllByRole("button", { name: /^Resume / });
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("S02E04 · The Fourth");
    expect(cards[0].textContent).toContain("40 min left");
    expect(cards[1].textContent).toContain("At 1:15");
    // No poster: an initial as the placeholder
    expect(cards[1].textContent).toContain("A");
  });

  it("resumes in a new room", async () => {
    historyItems = [item({ id: 7 })];
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /^Resume / }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/watch/brave-otter"),
    );
    expect(calls).toContainEqual({ url: "/history/7/resume", method: "POST" });
  });

  it("removes a card", async () => {
    historyItems = [item({ id: 9 })];
    renderHome();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove Example Show from Continue watching",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Continue watching")).toBeNull(),
    );
    expect(calls).toContainEqual({ url: "/history/9", method: "DELETE" });
  });

  it("never shows a video URL, even if the server sent one", async () => {
    const leaked = `https://${SECRET_HOST}/api/v1/debrid/playback/${SECRET_BLOB}/file.mkv`;
    historyItems = [{ ...item({}), url: leaked }];
    window.localStorage.setItem(
      "wp-recent-rooms",
      JSON.stringify([
        { roomId: "old-room", lastTitle: "Example Show", visitedAt: 1 },
      ]),
    );
    const { container } = renderHome();
    await screen.findByText("Continue watching");
    const text = visibleStrings(container);
    expect(text).not.toContain(SECRET_HOST);
    expect(text).not.toContain(SECRET_BLOB);
  });
});

describe("Recent rooms", () => {
  it("deletes a room after confirming and forgets it", async () => {
    window.localStorage.setItem(
      "wp-recent-rooms",
      JSON.stringify([
        { roomId: "brave-otter", lastTitle: "", roomTitle: "", visitedAt: 1 },
      ]),
    );
    renderHome();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Delete Brave otter" }),
      );
    });
    expect(await screen.findByText("Delete Brave otter?")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete room" }));
    });
    expect(calls).toContainEqual({
      url: "/rooms/brave-otter",
      method: "DELETE",
    });
    await waitFor(() => expect(screen.queryByText("Brave otter")).toBeNull());
    expect(window.localStorage.getItem("wp-recent-rooms")).toBe("[]");
  });
});
