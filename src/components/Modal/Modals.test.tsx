// The share and OpenSubtitles modals: what each button calls, error toasts, and the convert option.
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
import type React from "react";

const transcodeSupported = vi.fn(() => true);
vi.mock("../../utils/clientTranscode", () => ({
  isClientTranscodeSupported: () => transcodeSupported(),
}));
const apiFetch = vi.fn();
vi.mock("../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/api")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
const openFileSelector = vi.fn();
vi.mock("../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/utils")>()),
  openFileSelector: (...a: unknown[]) => openFileSelector(...a),
}));
const toastMock = vi.fn();
vi.mock("../App/ui/toast", () => ({
  toast: (...a: unknown[]) => toastMock(...a),
}));

const { ScreenShareModal } = await import("./ScreenShareModal");
const { FileShareModal } = await import("./FileShareModal");
const { SubtitleModal } = await import("./SubtitleModal");
const { serverPath } = await import("../../utils/api");

const wrap = (ui: React.ReactElement) =>
  render(<MantineProvider env="test">{ui}</MantineProvider>);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  apiFetch.mockReset();
  openFileSelector.mockReset();
  toastMock.mockReset();
  transcodeSupported.mockReturnValue(true);
});
afterEach(() => cleanup());

describe("ScreenShareModal", () => {
  it("starts sharing and closes, or just closes on Cancel", () => {
    const closeModal = vi.fn();
    const startScreenShare = vi.fn();
    wrap(
      <ScreenShareModal
        closeModal={closeModal}
        startScreenShare={startScreenShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(startScreenShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    expect(startScreenShare).toHaveBeenCalled();
    expect(closeModal).toHaveBeenCalledTimes(2);
  });
});

describe("FileShareModal", () => {
  it("shares without converting by default, or with it when checked", () => {
    const closeModal = vi.fn();
    const startFileShare = vi.fn();
    wrap(
      <FileShareModal
        closeModal={closeModal}
        startFileShare={startFileShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(startFileShare).toHaveBeenLastCalledWith({ convert: false });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Convert on this device/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(startFileShare).toHaveBeenLastCalledWith({ convert: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closeModal).toHaveBeenCalledTimes(3);
  });

  it("disables converting without WebCodecs", () => {
    transcodeSupported.mockReturnValue(false);
    wrap(<FileShareModal closeModal={vi.fn()} startFileShare={vi.fn()} />);
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Convert on this device/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/doesn't support WebCodecs/)).toBeTruthy();
  });
});

describe("SubtitleModal", () => {
  function setup(
    over: Partial<React.ComponentProps<typeof SubtitleModal>> = {},
  ) {
    const props = {
      closeModal: vi.fn(),
      roomSubtitle: "",
      roomMedia: "https://cdn.example.com/path/Some.Movie.2020.mkv",
      setRoomSubtitle: vi.fn(),
      getMediaDisplayName: (u: string) => u,
      setSubtitleMode: vi.fn(),
      getSubtitleMode: () => "hidden" as TextTrackMode,
      ...over,
    };
    wrap(<SubtitleModal {...props} />);
    return props;
  }

  it("pre-fills the search with the file name and toggles subtitles for me", () => {
    const props = setup({ getSubtitleMode: () => "showing" });
    expect(screen.getByDisplayValue("Some.Movie.2020.mkv")).toBeTruthy();
    const toggle = screen.getByRole("switch", {
      name: "Toggle subtitles for myself",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(props.setSubtitleMode).toHaveBeenCalled();
  });

  it("sets and clears the room subtitle URL", () => {
    const props = setup({ roomSubtitle: "https://subs.example.com/a.vtt" });
    fireEvent.change(screen.getByPlaceholderText("Subtitle URL"), {
      target: { value: "https://subs.example.com/b.vtt" },
    });
    expect(props.setRoomSubtitle).toHaveBeenLastCalledWith(
      "https://subs.example.com/b.vtt",
    );
    const clear = screen
      .getByPlaceholderText("Subtitle URL")
      .parentElement!.querySelector("button")!;
    fireEvent.click(clear);
    expect(props.setRoomSubtitle).toHaveBeenLastCalledWith("");
  });

  it("uploads a picked file and sets it as the room subtitle", async () => {
    const props = setup();
    openFileSelector.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: /Upload/ }));
    await act(async () => {});
    expect(apiFetch).not.toHaveBeenCalled();

    const file = new File(["1\n00:00:01,000 --> 00:00:02,000\nHi\n"], "a.srt");
    openFileSelector.mockResolvedValueOnce([file]);
    apiFetch.mockResolvedValueOnce(json({ hash: "abc123" }));
    fireEvent.click(screen.getByRole("button", { name: /Upload/ }));
    await waitFor(() =>
      expect(props.setRoomSubtitle).toHaveBeenCalledWith(
        serverPath + "/subtitle/abc123",
      ),
    );
    expect(apiFetch.mock.calls[0][0]).toBe("/subtitle");
    expect(apiFetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining("Hi"),
    });
  });

  it("searches by title (Enter or the button) and downloads a result", async () => {
    const props = setup();
    apiFetch.mockResolvedValueOnce(
      json([
        {
          id: "1",
          type: "subtitle",
          attributes: { release: "Some.Movie.WEB", files: [{ file_id: 42 }] },
        },
      ]),
    );
    const input = screen.getByDisplayValue("Some.Movie.2020.mkv");
    fireEvent.change(input, { target: { value: "Some Movie" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Some.Movie.WEB");
    expect(apiFetch).toHaveBeenCalledWith(
      "/searchSubtitles?title=Some%20Movie",
    );
    apiFetch.mockResolvedValueOnce(json({ link: "/subtitle/xyz" }));
    fireEvent.click(
      screen
        .getByText("Some.Movie.WEB")
        .parentElement!.querySelector("button")!,
    );
    await waitFor(() =>
      expect(props.setRoomSubtitle).toHaveBeenCalledWith(
        serverPath + "/subtitle/xyz",
      ),
    );
    expect(apiFetch).toHaveBeenLastCalledWith("/downloadSubtitles?file_id=42");

    // A failed download toasts instead
    apiFetch.mockResolvedValueOnce(json({ message: "quota" }, 429));
    fireEvent.click(
      screen
        .getByText("Some.Movie.WEB")
        .parentElement!.querySelector("button")!,
    );
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith("OpenSubtitles: quota", {
        tone: "danger",
        id: "subtitle-download",
      }),
    );
  });

  it("explains a missing OPENSUBTITLES_KEY, and other search failures", async () => {
    setup();
    apiFetch.mockResolvedValueOnce(
      json({ error: "opensubtitles_not_configured" }, 503),
    );
    fireEvent.click(screen.getByRole("button", { name: /By title/ }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Subtitle search isn't set up on this server (OPENSUBTITLES_KEY).",
        { tone: "danger", id: "subtitle-search" },
      ),
    );
    apiFetch.mockResolvedValueOnce(new Response("not json", { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: /By title/ }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenLastCalledWith(
        "OpenSubtitles: request failed",
        expect.anything(),
      ),
    );
  });
});
