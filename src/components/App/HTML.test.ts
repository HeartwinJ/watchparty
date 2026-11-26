// The <video> player: subtitle track selection (hidden/disabled modes), cue re-timing, ducking, buffered ranges.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn(async (_url: string) => new Response(""));
vi.mock("../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/api")>()),
  apiFetch: (url: string) => apiFetch(url),
}));

const { HTML } = await import("./HTML");

interface FakeCue {
  startTime: number;
  endTime: number;
}
interface FakeTextTrack {
  kind: string;
  label: string;
  language: string;
  mode: TextTrackMode;
  cues: FakeCue[] | null;
}

const track = (
  label: string,
  language = "",
  kind = "subtitles",
  cues: FakeCue[] | null = [],
): FakeTextTrack => ({ kind, label, language, mode: "disabled", cues });

let video: HTMLVideoElement;
let tracks: FakeTextTrack[];

beforeEach(() => {
  document.body.innerHTML = '<video id="leftVideo"></video>';
  video = document.getElementById("leftVideo") as HTMLVideoElement;
  tracks = [];
  Object.defineProperty(video, "textTracks", {
    configurable: true,
    get: () => tracks,
  });
  apiFetch.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("HTML player basics", () => {
  it("controls time, rate, mute and loop on the element", async () => {
    const p = new HTML("leftVideo");
    expect(p.isReady()).toBe(true);
    await p.setSrcAndTime("https://example.com/a.mp4", 12);
    expect(video.src).toBe("https://example.com/a.mp4");
    p.seekVideo(30);
    expect(p.getCurrentTime()).toBe(30);
    p.setPlaybackRate(1.25);
    expect(p.getPlaybackRate()).toBe(1.25);
    p.setLoop(true);
    expect(video.loop).toBe(true);
    document.body.insertAdjacentHTML("beforeend", '<audio id="iPhoneAudio">');
    p.setMute(true);
    expect(p.isMuted()).toBe(true);
    expect(
      (document.getElementById("iPhoneAudio") as HTMLAudioElement).muted,
    ).toBe(true);
  });

  it("plays and pauses the element, shouldPlay while paused", async () => {
    const play = vi.spyOn(video, "play").mockResolvedValue();
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    const p = new HTML("leftVideo");
    await p.playVideo();
    expect(play).toHaveBeenCalled();
    p.pauseVideo();
    expect(pause).toHaveBeenCalled();
    expect(p.shouldPlay()).toBe(true);
  });

  it("is a no-op without its element", async () => {
    const p = new HTML("missing");
    expect(p.isReady()).toBe(false);
    expect(p.getCurrentTime()).toBe(0);
    expect(p.getDuration()).toBe(0);
    expect(p.isMuted()).toBe(false);
    expect(p.getPlaybackRate()).toBe(1);
    expect(p.getVolume()).toBe(1);
    expect(p.shouldPlay()).toBe(false);
    p.setPlaybackRate(2);
    p.seekVideo(1);
    p.pauseVideo();
    p.setMute(true);
    p.setVolume(0.3);
    p.setDuck(0.5);
    p.syncSubtitles(3);
    await p.playVideo();
    await p.setSrcAndTime("x", 1);
    await p.loadSubtitles("/subtitle/abc");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(p.getSubtitleTracks()).toEqual([]);
    expect(p.getOriginalCues()).toEqual([]);
  });

  it("ducks the volume without losing the viewer's own", () => {
    const p = new HTML("leftVideo");
    video.volume = 0.8;
    p.setDuck(0.25);
    expect(video.volume).toBeCloseTo(0.2);
    expect(p.getVolume()).toBe(0.8);
    p.setVolume(0.4);
    expect(video.volume).toBeCloseTo(0.1);
    p.setDuck(0.5);
    expect(video.volume).toBeCloseTo(0.2);
    p.setDuck(1);
    expect(video.volume).toBeCloseTo(0.4);
    expect(p.getVolume()).toBeCloseTo(0.4);
    // Clamped to 0..1
    p.setVolume(3);
    expect(video.volume).toBe(1);
  });

  it("lists buffered ranges", () => {
    Object.defineProperty(video, "buffered", {
      configurable: true,
      value: {
        length: 2,
        start: (i: number) => [0, 50][i],
        end: (i: number) => [10, 60][i],
      },
    });
    expect(new HTML("leftVideo").getTimeRanges()).toEqual([
      { start: 0, end: 10 },
      { start: 50, end: 60 },
    ]);
  });
});

describe("HTML subtitles", () => {
  it("lists subtitle tracks, skipping metadata and chapters, with fallback labels", () => {
    tracks = [
      track("English", "en"),
      track("", "", "metadata"),
      track("", "fr"),
      track("", "", "chapters"),
      track("", ""),
    ];
    expect(new HTML("leftVideo").getSubtitleTracks()).toEqual([
      { index: 0, label: "English", language: "en", fromRoom: false },
      { index: 2, label: "fr", language: "fr", fromRoom: false },
      { index: 4, label: "Track 5", language: "", fromRoom: false },
    ]);
  });

  it("keeps the selected track hidden (the overlay draws it) and disables the others", () => {
    tracks = [track("A"), track("B"), track("C")];
    const p = new HTML("leftVideo");
    expect(p.getSubtitleMode()).toBe("hidden");
    expect(p.getActiveSubtitleTrack()).toBeUndefined();
    expect(p.getSelectedSubtitleTrack()).toBe(-1);

    p.selectSubtitleTrack(1);
    expect(tracks.map((t) => t.mode)).toEqual([
      "disabled",
      "hidden",
      "disabled",
    ]);
    expect(p.getSubtitleMode()).toBe("showing");
    expect(p.isSubtitled()).toBe(true);
    expect(p.getActiveSubtitleTrack()).toBe(tracks[1]);
    expect(p.getSelectedSubtitleTrack()).toBe(1);

    p.selectSubtitleTrack(-1);
    expect(tracks.every((t) => t.mode === "disabled")).toBe(true);
    expect(p.isSubtitled()).toBe(false);
  });

  it("setSubtitleMode toggles or sets the current track", () => {
    tracks = [track("A")];
    const p = new HTML("leftVideo");
    p.setSubtitleMode();
    expect(tracks[0].mode).toBe("hidden");
    p.setSubtitleMode();
    expect(tracks[0].mode).toBe("disabled");
    p.setSubtitleMode("showing");
    expect(p.getSubtitleMode()).toBe("showing");
    p.setSubtitleMode("hidden");
    expect(p.getSubtitleMode()).toBe("hidden");
  });

  it("isn't showing when the selected track doesn't exist", () => {
    const p = new HTML("leftVideo");
    p.setSubtitleMode("showing");
    expect(p.getSubtitleMode()).toBe("hidden");
  });

  it("re-times cues from their original times with offset and scale", () => {
    const cues = [
      { startTime: 10, endTime: 12 },
      { startTime: 1, endTime: 2 },
    ];
    tracks = [
      track("A", "en", "subtitles", cues),
      track("empty", "", "subtitles", null),
    ];
    const p = new HTML("leftVideo");
    p.setSubtitleOffset(2);
    expect(cues[0]).toEqual({ startTime: 12, endTime: 14 });
    // Offsets don't accumulate: they apply to the original times
    p.setSubtitleOffset(-3);
    expect(cues[0]).toEqual({ startTime: 7, endTime: 9 });
    // Never before 0
    expect(cues[1]).toEqual({ startTime: 0, endTime: 0 });
    p.setSubtitleOffset(0, 2);
    expect(cues[0]).toEqual({ startTime: 20, endTime: 24 });

    p.selectSubtitleTrack(0);
    // Original cues are what auto-sync aligns
    expect(p.getOriginalCues()).toEqual([
      { start: 10, end: 12 },
      { start: 1, end: 2 },
    ]);
    expect(p.getOriginalCues(1)).toEqual([]);
    expect(p.getOriginalCues(-1)).toEqual([]);
  });

  it("getOriginalCues uses the cue times for cues never re-timed", () => {
    tracks = [track("A", "en", "subtitles", [{ startTime: 3, endTime: 4 }])];
    expect(new HTML("leftVideo").getOriginalCues(0)).toEqual([
      { start: 3, end: 4 },
    ]);
  });

  it("shifts cues by the screen sharer's time difference", () => {
    const cues = [{ startTime: 10, endTime: 12 }];
    tracks = [track("A", "en", "subtitles", cues)];
    const p = new HTML("leftVideo");
    video.currentTime = 5;
    p.syncSubtitles(3);
    expect(cues[0]).toEqual({ startTime: 12, endTime: 14 });
    // Same shift again: nothing changes; non-finite times are ignored
    p.syncSubtitles(3);
    p.syncSubtitles(NaN);
    expect(cues[0]).toEqual({ startTime: 12, endTime: 14 });
    // The room offset adds to it
    p.setSubtitleOffset(1);
    expect(cues[0]).toEqual({ startTime: 13, endTime: 15 });
  });

  it("loads a room subtitle as a converted WebVTT track and selects it", async () => {
    apiFetch.mockResolvedValueOnce(
      new Response("1\n00:00:01,000 --> 00:00:02,000\nHello\n"),
    );
    const created = vi.fn((_b: Blob) => "blob:vtt");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created }));
    // The <track> element's TextTrack joins video.textTracks when appended
    const appendChild = video.appendChild.bind(video);
    vi.spyOn(video, "appendChild").mockImplementation((node: any) => {
      const tt = track("English", "en", "captions");
      Object.defineProperty(node, "track", { value: tt });
      tracks.push(tt);
      return appendChild(node);
    });
    tracks = [track("Embedded", "de")];
    const p = new HTML("leftVideo");
    await p.loadSubtitles("/subtitle/abc");
    expect(apiFetch).toHaveBeenCalledWith("/subtitle/abc");
    const blob = created.mock.calls[0][0];
    expect(await blob.text()).toMatch(/^WEBVTT/);
    expect(await blob.text()).toContain("00:00:01.000 --> 00:00:02.000");
    const el = video.querySelector("track")!;
    expect(el.getAttribute("src") ?? (el as HTMLTrackElement).src).toContain(
      "blob:vtt",
    );
    expect(p.getSelectedSubtitleTrack()).toBe(1);
    expect(p.getSubtitleTracks()[1]).toMatchObject({
      fromRoom: true,
      label: "English",
    });
    expect(tracks[1].mode).toBe("hidden");
    // Cues arriving later get the current offset
    p.setSubtitleOffset(5);
    tracks[1].cues = [{ startTime: 1, endTime: 2 }];
    el.dispatchEvent(new Event("load"));
    expect(tracks[1].cues[0]).toEqual({ startTime: 6, endTime: 7 });
    vi.unstubAllGlobals();
  });

  it("an empty subtitle URL removes the room track and turns subtitles off", async () => {
    tracks = [track("A")];
    const p = new HTML("leftVideo");
    p.selectSubtitleTrack(0);
    video.innerHTML = "<track>";
    await p.loadSubtitles("");
    expect(video.innerHTML).toBe("");
    expect(p.isSubtitled()).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("clearState resets the source and subtitles", () => {
    tracks = [track("A")];
    const p = new HTML("leftVideo");
    p.selectSubtitleTrack(0);
    video.innerHTML = "<track>";
    p.clearState();
    expect(video.innerHTML).toBe("");
    expect(p.isSubtitled()).toBe(false);
    expect(video.srcObject).toBeNull();
  });
});

describe("HTML player with volume boost", () => {
  const bind = (p: InstanceType<typeof HTML>) => {
    Object.defineProperty(p.boost, "bound", { get: () => true });
  };

  it("loads normally while the boost isn't bound", async () => {
    const p = new HTML("leftVideo");
    const prepare = vi.spyOn(p.boost, "prepareLoad");
    video.crossOrigin = "anonymous";
    await p.setSrcAndTime("https://example.com/a.mp4", 0);
    expect(prepare).not.toHaveBeenCalled();
    expect(video.crossOrigin).toBeNull();
    expect(video.src).toBe("https://example.com/a.mp4");
  });

  it("prepares loads while the boost is on but not bound yet", async () => {
    const p = new HTML("leftVideo");
    p.boost.settings = { level: 2, night: false };
    const prepare = vi.spyOn(p.boost, "prepareLoad").mockResolvedValue(true);
    await p.setSrcAndTime("https://example.com/a.mp4", 0);
    expect(prepare).toHaveBeenCalledWith(video, "https://example.com/a.mp4");
    expect(video.src).toBe("https://example.com/a.mp4");
  });

  it("asks for a reload when the bound element can't play the source", async () => {
    const p = new HTML("leftVideo");
    bind(p);
    vi.spyOn(p.boost, "prepareLoad").mockResolvedValue(false);
    const blocked = vi.fn();
    p.onBoostBlocked = blocked;
    await p.setSrcAndTime("https://example.com/a.mp4", 0);
    expect(blocked).toHaveBeenCalled();
    expect(video.getAttribute("src")).toBeNull();
    // Without a handler it just doesn't load
    p.onBoostBlocked = null;
    await p.setSrcAndTime("https://example.com/a.mp4", 0);
    expect(video.getAttribute("src")).toBeNull();
  });

  it("loads after a successful check, unless a newer load started", async () => {
    const p = new HTML("leftVideo");
    bind(p);
    let resolve!: (ok: boolean) => void;
    vi.spyOn(p.boost, "prepareLoad")
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
      .mockResolvedValue(true);
    const first = p.setSrcAndTime("https://example.com/old.mp4", 0);
    await p.setSrcAndTime("https://example.com/new.mp4", 0);
    resolve(true);
    await first;
    expect(video.src).toBe("https://example.com/new.mp4");
  });
});
