// Continue watching when things fail: history unavailable, resume or remove errors (the card comes back), and
// posters that don't load.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryItem } from "../../utils/history";

const fetchHistory = vi.fn();
const resumeHistoryItem = vi.fn();
const deleteHistoryItem = vi.fn();
vi.mock("../../utils/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/history")>()),
  fetchHistory: (...a: unknown[]) => fetchHistory(...a),
  resumeHistoryItem: (...a: unknown[]) => resumeHistoryItem(...a),
  deleteHistoryItem: (...a: unknown[]) => deleteHistoryItem(...a),
}));
const toastMock = vi.fn();
vi.mock("../App/ui/toast", () => ({
  toast: (...a: unknown[]) => toastMock(...a),
}));

const { ContinueWatching } = await import("./ContinueWatching");

const item = (over: Partial<HistoryItem> = {}): HistoryItem => ({
  id: 1,
  roomId: "/old-room",
  kind: "url",
  title: "Example Movie",
  subtitle: "",
  poster: "https://images.example.com/poster.jpg",
  position: 600,
  duration: 3000,
  updatedAt: 100,
  finished: false,
  group: "url:x",
  ...over,
});

const renderRow = () =>
  render(
    <MantineProvider env="test">
      <ContinueWatching />
    </MantineProvider>,
  );

beforeEach(() => {
  fetchHistory.mockReset();
  resumeHistoryItem.mockReset();
  deleteHistoryItem.mockReset();
  toastMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ContinueWatching errors", () => {
  it("renders nothing when the history can't be loaded", async () => {
    fetchHistory.mockRejectedValue(new Error("offline"));
    renderRow();
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(screen.queryByText("Continue watching")).toBeNull();
  });

  it("toasts when resuming fails and lets you try again", async () => {
    fetchHistory.mockResolvedValue([item()]);
    resumeHistoryItem.mockRejectedValueOnce(new Error("gone"));
    renderRow();
    const card = await screen.findByRole("button", {
      name: /Resume Example Movie/,
    });
    fireEvent.click(card);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Couldn't resume Example Movie. Try again in a moment.",
        { tone: "danger" },
      ),
    );
    await waitFor(() =>
      expect((card as HTMLButtonElement).disabled).toBe(false),
    );
    resumeHistoryItem.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(card);
    await waitFor(() =>
      expect((card as HTMLButtonElement).disabled).toBe(true),
    );
    // A second click while resuming is ignored
    fireEvent.click(card);
    expect(resumeHistoryItem).toHaveBeenCalledTimes(2);
  });

  it("puts a card back when removing it fails", async () => {
    fetchHistory.mockResolvedValue([item()]);
    deleteHistoryItem.mockRejectedValueOnce(new Error("nope"));
    renderRow();
    await screen.findByText("Example Movie");
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith("Couldn't remove Example Movie.", {
        tone: "danger",
      }),
    );
    expect(screen.getByText("Example Movie")).toBeTruthy();
  });

  it("shows the title's initial when the poster fails or is missing", async () => {
    fetchHistory.mockResolvedValue([
      item(),
      item({ id: 2, title: "  ", poster: null, group: "url:y" }),
    ]);
    const { container } = renderRow();
    await screen.findByText("Example Movie");
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(screen.getByText("E")).toBeTruthy();
    expect(screen.getByText("?")).toBeTruthy();
  });
});
