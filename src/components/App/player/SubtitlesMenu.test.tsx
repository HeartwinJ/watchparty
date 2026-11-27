// The CC menu: tracks (auto / room / embedded), loading a file or URL, search, audio tracks, timing offset and style.
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitlesMenu } from "./SubtitlesMenu";
import { useTextTracks } from "./useTextTracks";
import { useSubtitleStyle } from "./useSubtitleStyle";
import type { Room } from "../hooks/useRoom";
import {
  renderWithPlayerRoom,
  type RenderPlayerOptions,
} from "../../../test/playerRoom";

const openFileSelector = vi.fn();
vi.mock("../../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/utils")>()),
  openFileSelector: (accept?: string) => openFileSelector(accept),
}));
const apiFetch = vi.fn();
vi.mock("../../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/api")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

function Menu({ room, onClose }: { room: Room; onClose: () => void }) {
  const tracks = useTextTracks(room);
  const [style, setStyle] = useSubtitleStyle();
  return (
    <>
      <video id="leftVideo" />
      <SubtitlesMenu
        room={room}
        tracks={tracks}
        style={style}
        setStyle={setStyle}
        onClose={onClose}
      />
    </>
  );
}

function setup(opts: RenderPlayerOptions = {}) {
  const onClose = vi.fn();
  const r = renderWithPlayerRoom(
    (room) => <Menu room={room} onClose={onClose} />,
    {
      ...opts,
      state: { roomMedia: "https://example.com/movie.mp4", ...opts.state },
    },
  );
  return { ...r, onClose };
}

const tracksMenu = () => screen.getByRole("menu", { name: "Subtitle tracks" });
const item = (name: string | RegExp) =>
  within(tracksMenu()).getByRole("menuitemradio", { name });

beforeEach(() => {
  window.localStorage.clear();
  openFileSelector.mockReset();
  apiFetch.mockReset();
});
afterEach(cleanup);

describe("SubtitlesMenu tracks", () => {
  it("lists auto tracks first, then embedded ones, and picks them", () => {
    const r = setup({
      state: {
        subtitleTracks: [
          {
            id: "a",
            label: "English",
            url: "https://subs.example.com/en.srt",
            detail: "OpenSubtitles",
            source: "auto",
          },
          {
            id: "m",
            label: "Mine",
            url: "https://subs.example.com/mine.srt",
            source: "manual",
          },
        ],
      },
      media: {
        tracks: [
          { index: 0, label: "Deutsch", language: "de", fromRoom: false },
        ],
      },
    });
    const names = within(tracksMenu())
      .getAllByRole("menuitemradio")
      .map((b) => b.textContent);
    expect(names[0]).toBe("Off");
    expect(names[1]).toContain("English");
    expect(names[1]).toContain("OpenSubtitles");
    expect(names[1]).toContain("Auto");
    // Manual tracks have no Auto badge
    expect(names[2]).toBe("Mine");
    expect(names[3]).toContain("Embedded in the file");
    expect(item("Off").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(item(/English/));
    expect(r.socket.emits("CMD:subtitle")).toEqual([
      ["https://subs.example.com/en.srt"],
    ]);

    fireEvent.click(item(/Deutsch/));
    expect(r.player.html().selectSubtitleTrack).toHaveBeenCalledWith(0);
    expect(r.subsync.evaluate).toHaveBeenCalled();
    expect(item(/Deutsch/).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(item("Off"));
    expect(r.player.html().selectSubtitleTrack).toHaveBeenLastCalledWith(-1);
    expect(item("Off").getAttribute("aria-checked")).toBe("true");
  });

  it("groups a long list by language, with a filter", () => {
    const langs = ["en", "en", "en", "es", "fr", "de", "it", "nl", "pl"];
    const counts: Record<string, number> = {};
    const subtitleTracks = langs.map((lang, i) => {
      counts[lang] = (counts[lang] ?? 0) + 1;
      const name = new Intl.DisplayNames(["en"], { type: "language" }).of(
        lang,
      )!;
      return {
        id: `s${i}`,
        lang,
        label: counts[lang] > 1 ? `${name} ${counts[lang]}` : name,
        url: `https://subs.example.com/${i}.srt`,
        detail: "OpenSubtitles",
        source: "auto" as const,
      };
    });
    const r = setup({
      state: { subtitleTracks },
      media: {
        tracks: [
          { index: 0, label: "English [SDH]", language: "", fromRoom: false },
        ],
      },
    });
    // English (3 auto + 1 embedded) is one folded row; single languages are plain rows
    const english = within(tracksMenu()).getByRole("menuitem", {
      name: /English/,
    });
    expect(english.getAttribute("aria-expanded")).toBe("false");
    expect(english.textContent).toContain("4 subtitles");
    expect(
      within(tracksMenu()).queryByRole("menuitemradio", { name: /English 2/ }),
    ).toBeNull();
    fireEvent.click(item(/Spanish/));
    expect(r.socket.emits("CMD:subtitle")).toEqual([
      ["https://subs.example.com/3.srt"],
    ]);

    fireEvent.click(english);
    expect(english.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(item(/English 2/));
    expect(r.socket.emits("CMD:subtitle").at(-1)).toEqual([
      "https://subs.example.com/1.srt",
    ]);
    fireEvent.click(item(/English \[SDH\]/));
    expect(r.player.html().selectSubtitleTrack).toHaveBeenCalledWith(0);
    fireEvent.click(english);
    expect(english.getAttribute("aria-expanded")).toBe("false");
    // Selected inside a folded group: named on the group row
    expect(english.textContent).toContain("English [SDH]");

    // Filtering opens matching groups and hides the rest
    const filter = screen.getByLabelText("Filter subtitles");
    fireEvent.change(filter, { target: { value: "pol" } });
    expect(
      within(tracksMenu())
        .getAllByRole("menuitemradio")
        .map((b) => b.textContent),
    ).toEqual(["Off", expect.stringContaining("Polish")]);
    fireEvent.change(filter, { target: { value: "english 3" } });
    expect(item(/English 3/)).toBeTruthy();
    fireEvent.change(filter, { target: { value: "klingon" } });
    expect(within(tracksMenu()).getByText(/No subtitles match/)).toBeTruthy();
  });

  it("opens the group of the selected subtitle by default", () => {
    const url = "https://subs.example.com/en2.srt";
    setup({
      state: {
        roomSubtitle: url,
        subtitleTracks: Array.from({ length: 9 }, (_, i) => ({
          id: `s${i}`,
          lang: "en",
          label: i ? `English ${i + 1}` : "English",
          url: i === 1 ? url : `https://subs.example.com/${i}.srt`,
          source: "auto" as const,
        })),
      },
      media: {
        tracks: [{ index: 0, label: "", language: "", fromRoom: true }],
        selectedTrack: 0,
      },
    });
    const english = within(tracksMenu()).getByRole("menuitem", {
      name: /English/,
    });
    expect(english.getAttribute("aria-expanded")).toBe("true");
    expect(item(/English 2/).getAttribute("aria-checked")).toBe("true");
  });

  it("names an embedded track without a label by its language or number", () => {
    setup({
      media: {
        tracks: [
          { index: 0, label: "", language: "fr", fromRoom: false },
          { index: 1, label: "", language: "", fromRoom: false },
        ],
      },
    });
    expect(item(/French/)).toBeTruthy();
    expect(item(/Track 2/)).toBeTruthy();
  });

  it("the room track shows as checked auto track, not twice", () => {
    const url = "https://subs.example.com/en.srt";
    setup({
      state: {
        roomSubtitle: url,
        subtitleTracks: [{ id: "a", label: "English", url, source: "auto" }],
      },
      media: {
        tracks: [{ index: 0, label: "", language: "", fromRoom: true }],
        selectedTrack: 0,
      },
    });
    expect(item(/English/).getAttribute("aria-checked")).toBe("true");
    expect(within(tracksMenu()).queryByText("Room subtitles")).toBeNull();
  });

  it("a room subtitle that isn't an auto track is listed as Room subtitles", () => {
    setup({
      state: { roomSubtitle: "https://elsewhere.example.com/x.vtt" },
      media: {
        tracks: [{ index: 0, label: "", language: "", fromRoom: true }],
        selectedTrack: 0,
      },
    });
    expect(item(/Room subtitles/).textContent).toContain("Loaded for everyone");
  });

  it("loads a subtitle file through the server", async () => {
    const r = setup();
    openFileSelector.mockResolvedValue([
      new File(["1\n00:00:01,000 --> 00:00:02,000\nHi\n"], "a.srt"),
    ]);
    apiFetch.mockResolvedValue(Response.json({ hash: "abc123" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Load a .srt/ }));
    });
    expect(openFileSelector).toHaveBeenCalledWith(".srt,.vtt");
    expect(apiFetch.mock.calls[0][0]).toBe("/subtitle");
    expect(apiFetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    await waitFor(() =>
      expect(r.socket.emits("CMD:subtitle")[0][0]).toMatch(
        /\/subtitle\/abc123$/,
      ),
    );
  });

  it("a cancelled file dialog does nothing", async () => {
    const r = setup();
    openFileSelector.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Load a .srt/ }));
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(r.socket.emits("CMD:subtitle")).toEqual([]);
  });

  it("loads a subtitle from a URL (trimmed; empty is ignored)", () => {
    const r = setup();
    const toggle = screen.getByRole("button", { name: /From a URL/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const input = screen.getByLabelText("Subtitle URL");
    fireEvent.submit(input.closest("form")!);
    expect(r.socket.emits("CMD:subtitle")).toEqual([]);
    fireEvent.change(input, {
      target: { value: "  https://subs.example.com/a.vtt " },
    });
    fireEvent.submit(input.closest("form")!);
    expect(r.socket.emits("CMD:subtitle")).toEqual([
      ["https://subs.example.com/a.vtt"],
    ]);
    expect(screen.queryByLabelText("Subtitle URL")).toBeNull();
  });

  it("Search subtitles… closes the menu, leaves fullscreen and opens the search", () => {
    const r = setup({ media: { fullscreen: true } });
    fireEvent.click(screen.getByRole("button", { name: /Search subtitles/ }));
    expect(r.onClose).toHaveBeenCalled();
    expect(r.player.toggleFullscreen).toHaveBeenCalled();
    expect(r.subtitles.openSearch).toHaveBeenCalled();
  });

  it("Search outside fullscreen doesn't toggle fullscreen", () => {
    const r = setup();
    fireEvent.click(screen.getByRole("button", { name: /Search subtitles/ }));
    expect(r.player.toggleFullscreen).not.toHaveBeenCalled();
  });
});

describe("SubtitlesMenu on YouTube", () => {
  it("offers only Off / YouTube captions and no timing or style", () => {
    const r = setup({ media: { youtube: true, native: false } });
    expect(item("Off").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(item(/YouTube captions/));
    expect(r.player.youtube().setSubtitleMode).toHaveBeenCalledWith("showing");
    expect(item(/YouTube captions/).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(item("Off"));
    expect(r.player.youtube().setSubtitleMode).toHaveBeenLastCalledWith(
      "hidden",
    );
    expect(screen.queryByText("Timing offset")).toBeNull();
    expect(screen.queryByText("Style")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Search subtitles/ }),
    ).toBeNull();
  });
});

describe("SubtitlesMenu timing", () => {
  it("nudges, resets and slides the offset", () => {
    const r = setup({ state: { roomSubtitleOffset: 1.5 } });
    expect(screen.getByText("subtitles appear later")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Subtitles 0.1 seconds earlier"));
    expect(r.subtitles.nudgeOffset).toHaveBeenCalledWith(-0.1);
    fireEvent.click(screen.getByLabelText("Subtitles 0.1 seconds later"));
    expect(r.subtitles.nudgeOffset).toHaveBeenCalledWith(0.1);
    fireEvent.click(screen.getByLabelText("Reset subtitle offset"));
    expect(r.subtitles.resetOffset).toHaveBeenCalled();
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuetext")).toBe("+1.5 s");
    fireEvent.change(slider, { target: { value: "-2.5" } });
    expect(r.subtitles.setOffset).toHaveBeenCalledWith(-2.5);
  });

  it("this device's offset wins and big offsets pin the slider", () => {
    setup({ state: { roomSubtitleOffset: 1, localSubtitleOffset: -45 } });
    expect(screen.getByText("subtitles appear earlier")).toBeTruthy();
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe("-10");
    expect(slider.getAttribute("aria-valuenow")).toBe("-45");
  });

  it("shows the frame-rate scale when it isn't 1", () => {
    const r = setup();
    expect(screen.getByText("no offset")).toBeTruthy();
    expect(screen.queryByText(/speed/)).toBeNull();
    r.subtitles.getTiming.mockReturnValue({ offset: 0, scale: 25 / 24 });
    // Re-render by changing state
    r.setState({ roomSubtitleOffset: 0.5 });
    expect(screen.getByText(/speed 1\.042/)).toBeTruthy();
  });

  it("types an offset: Enter applies, invalid or unchanged values don't, Esc reverts", () => {
    const r = setup({ state: { roomSubtitleOffset: 2 } });
    const input = screen.getByLabelText(
      "Subtitle offset in seconds",
    ) as HTMLInputElement;
    expect(input.value).toBe("+2.0 s");
    fireEvent.focus(input);
    expect(input.value).toBe("2");
    fireEvent.change(input, { target: { value: "1:30" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(r.subtitles.setOffset).toHaveBeenCalledWith(90);

    r.subtitles.setOffset.mockClear();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.blur(input);
    expect(r.subtitles.setOffset).not.toHaveBeenCalled();
    expect(input.value).toBe("+2.0 s");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.blur(input);
    expect(r.subtitles.setOffset).not.toHaveBeenCalled();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "-5" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(r.subtitles.setOffset).not.toHaveBeenCalled();
    expect(input.value).toBe("+2.0 s");
    // Other keys just type
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "a" });
  });

  it("focusing a zero offset starts from 0", () => {
    setup();
    const input = screen.getByLabelText(
      "Subtitle offset in seconds",
    ) as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.value).toBe("0");
  });

  it("switches the offset scope with its note", () => {
    const r = setup();
    expect(screen.getByText(/Synced to the room/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Just me" }));
    expect(r.subtitles.setScope).toHaveBeenCalledWith("me");
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    expect(r.subtitles.setScope).toHaveBeenCalledWith("everyone");
    cleanup();
    setup({ state: { subtitleScope: "me" } });
    expect(screen.getByText(/Only on this device/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Just me" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("the auto-sync wand needs a selected track", () => {
    setup();
    expect(screen.getByText("Pick a subtitle track first")).toBeTruthy();
  });
});

describe("SubtitlesMenu style", () => {
  it("changes and remembers size and background", () => {
    setup();
    const size = screen.getByRole("group", { name: "Size" });
    const bg = screen.getByRole("group", { name: "Background" });
    expect(
      within(size)
        .getByRole("button", { name: "M" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(size).getByRole("button", { name: "XL" }));
    fireEvent.click(within(bg).getByRole("button", { name: "Box" }));
    expect(
      within(size)
        .getByRole("button", { name: "XL" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      JSON.parse(window.localStorage.getItem("wp-subtitle-style")!),
    ).toEqual({ size: "xl", background: "box" });
    // A new mount reads it back
    cleanup();
    setup();
    expect(
      within(screen.getByRole("group", { name: "Background" }))
        .getByRole("button", { name: "Box" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("ignores a broken or invalid saved style", () => {
    window.localStorage.setItem("wp-subtitle-style", "{not json");
    setup();
    expect(
      within(screen.getByRole("group", { name: "Size" }))
        .getByRole("button", { name: "M" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    cleanup();
    window.localStorage.setItem(
      "wp-subtitle-style",
      JSON.stringify({ size: "huge", background: "neon" }),
    );
    setup();
    expect(
      within(screen.getByRole("group", { name: "Background" }))
        .getByRole("button", { name: "Shadow" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("still changes the style when storage is unavailable", () => {
    setup();
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    const size = screen.getByRole("group", { name: "Size" });
    fireEvent.click(within(size).getByRole("button", { name: "S" }));
    expect(
      within(size)
        .getByRole("button", { name: "S" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    spy.mockRestore();
  });
});
