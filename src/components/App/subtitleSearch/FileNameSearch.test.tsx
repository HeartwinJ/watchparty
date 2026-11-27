// The OpenSubtitles file-name search: search on open, results, download for the room, errors, Back/Esc.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/api")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
const toastMock = vi.fn();
vi.mock("../ui/toast", () => ({
  toast: (...a: unknown[]) => toastMock(...a),
}));

const { FileNameSearch, describeResult } = await import("./FileNameSearch");
const { serverPath } = await import("../../../utils/api");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const RESULT = {
  id: "1",
  attributes: {
    release: "Some.Movie.2020.1080p.WEB",
    language: "en",
    download_count: 12345,
    hearing_impaired: true,
    fps: 23.976,
    files: [{ file_id: 42, file_name: "some.movie.srt" }],
  },
};

function setup(over: Partial<Parameters<typeof FileNameSearch>[0]> = {}) {
  const props = {
    opened: true,
    onClose: vi.fn(),
    onBack: vi.fn(),
    initialQuery: "Some.Movie.2020.mkv",
    setRoomSubtitle: vi.fn(),
    ...over,
  };
  render(
    <MantineProvider env="test">
      <FileNameSearch {...props} />
    </MantineProvider>,
  );
  return props;
}

beforeEach(() => {
  apiFetch.mockReset();
  toastMock.mockReset();
});
afterEach(() => cleanup());

describe("describeResult", () => {
  it("names the release and lists language, flags, fps and downloads", () => {
    expect(describeResult(RESULT)).toEqual({
      title: "Some.Movie.2020.1080p.WEB",
      meta: "English · Hearing impaired · 23.976 fps · 12k downloads",
      lang: "EN",
      fileId: 42,
    });
    expect(
      describeResult({
        id: "2",
        attributes: {
          language: "pt-BR",
          download_count: 1500,
          machine_translated: true,
          files: [{ file_id: 7, file_name: "x.srt" }],
        },
      }),
    ).toEqual({
      title: "x.srt",
      meta: "Brazilian Portuguese · Machine translated · 1.5k downloads",
      lang: "PT",
      fileId: 7,
    });
    expect(
      describeResult({ id: "3", attributes: { download_count: 5 } }),
    ).toEqual({
      title: "Untitled subtitle",
      meta: "5 downloads",
      lang: "?",
      fileId: undefined,
    });
    // An invalid language tag stays as it is
    expect(
      describeResult({ id: "4", attributes: { language: "!!" } }).meta,
    ).toBe("!!");
  });
});

describe("FileNameSearch", () => {
  it("searches what's playing on open and loads a result for everyone", async () => {
    apiFetch.mockResolvedValueOnce(json([RESULT]));
    const props = setup();
    const input = screen.getByRole("searchbox", {
      name: "File or release name",
    }) as HTMLInputElement;
    expect(input.value).toBe("Some.Movie.2020.mkv");
    expect(await screen.findByText("Some.Movie.2020.1080p.WEB")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(
      "/searchSubtitles?title=Some.Movie.2020.mkv",
    );
    expect(screen.getByText(/12k downloads/)).toBeTruthy();

    apiFetch.mockResolvedValueOnce(json({ link: "/subtitle/xyz" }));
    fireEvent.click(screen.getByRole("button", { name: /Some\.Movie/ }));
    await waitFor(() =>
      expect(props.setRoomSubtitle).toHaveBeenCalledWith(
        serverPath + "/subtitle/xyz",
      ),
    );
    expect(apiFetch).toHaveBeenLastCalledWith("/downloadSubtitles?file_id=42");
    expect(props.onClose).toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      "“Some.Movie.2020.1080p.WEB” loaded for everyone",
      expect.objectContaining({ tone: "success" }),
    );
  });

  it("searches what's typed on Enter, and shows the empty and idle states", async () => {
    apiFetch.mockResolvedValueOnce(json([]));
    setup();
    expect(
      await screen.findByText("No subtitles found for “Some.Movie.2020.mkv”."),
    ).toBeTruthy();
    const input = screen.getByRole("searchbox");
    apiFetch.mockResolvedValueOnce(json([RESULT]));
    fireEvent.change(input, { target: { value: "Some Movie" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("Some.Movie.2020.1080p.WEB")).toBeTruthy();
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/searchSubtitles?title=Some%20Movie",
    );
    fireEvent.change(input, { target: { value: " " } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText(/Type the video's file/)).toBeTruthy();
  });

  it("starts idle without a name", () => {
    setup({ initialQuery: "" });
    expect(screen.getByText(/Type the video's file/)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("explains a missing OPENSUBTITLES_KEY and other failures, with Try again", async () => {
    apiFetch.mockResolvedValueOnce(
      json({ error: "opensubtitles_not_configured" }, 503),
    );
    setup();
    expect(
      await screen.findByText(
        "Subtitle search isn't set up on this server (OPENSUBTITLES_KEY).",
      ),
    ).toBeTruthy();
    apiFetch.mockResolvedValueOnce(new Response("not json", { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("OpenSubtitles: request failed"),
    ).toBeTruthy();
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("offline")).toBeTruthy();
  });

  it("toasts a failed download and lets you pick again", async () => {
    apiFetch.mockResolvedValueOnce(json([RESULT]));
    const props = setup();
    const row = await screen.findByRole("button", { name: /Some\.Movie/ });
    apiFetch.mockResolvedValueOnce(json({ message: "quota" }, 429));
    fireEvent.click(row);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith("OpenSubtitles: quota", {
        tone: "danger",
        id: "subtitle-download",
      }),
    );
    await waitFor(() =>
      expect((row as HTMLButtonElement).disabled).toBe(false),
    );
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(row);
    await waitFor(() =>
      expect(toastMock).toHaveBeenLastCalledWith("OpenSubtitles: offline", {
        tone: "danger",
        id: "subtitle-download",
      }),
    );
    expect(props.setRoomSubtitle).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Back, the breadcrumb and Esc return to the title search; Close closes", async () => {
    apiFetch.mockResolvedValue(json([]));
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Search by title" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onBack).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
