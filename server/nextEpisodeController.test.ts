import { describe, expect, it, vi } from "vitest";
import type {
  NextEpisodeResolver,
  NextEpisodeResult,
} from "./addons/nextEpisode.ts";
import { NextEpisodeController } from "./nextEpisodeController.ts";
import { DEFAULT_ROOM_SETTINGS } from "./roomSettings.ts";

const DEFAULT_NEXT_EPISODE_OFFSET = DEFAULT_ROOM_SETTINGS.nextEpisodeOffset;

const VIDEO = "https://aio.example.com/playback/e2.mkv#wp-name=Show";
const NEXT_URL = "https://aio.example.com/playback/e3.mkv#wp-name=Show";
const meta: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:1:2",
  imdbId: "tt0000001",
  season: 1,
  episode: 2,
  title: "Show",
  episodeTitle: null,
  poster: null,
  bingeGroup: "grp",
};
const nextMeta: VideoMeta = { ...meta, id: "tt0000001:1:3", episode: 3 };
const FOUND: NextEpisodeResult = {
  kind: "found",
  meta: nextMeta,
  thumbnail: null,
  url: NEXT_URL,
};
const alex: PlaybackActor = { id: "a", name: "Alex" };

function setup(result: NextEpisodeResult | Promise<NextEpisodeResult> = FOUND) {
  const room = {
    video: VIDEO as string | null,
    meta: meta as VideoMeta | null,
    playlist: 0,
    loop: false,
    resolver: vi.fn<NextEpisodeResolver>(async () => result),
  };
  const emitted: NextEpisodeState[] = [];
  const play = vi.fn((url: string, m: VideoMeta) => {
    room.video = url;
    room.meta = m;
    ctl.reset();
  });
  const ctl = new NextEpisodeController({
    video: () => room.video,
    videoMeta: () => room.meta,
    playlistLength: () => room.playlist,
    loop: () => room.loop,
    offset: () => DEFAULT_NEXT_EPISODE_OFFSET,
    resolver: () => room.resolver,
    emit: (s) => emitted.push(s),
    play,
  });
  const offer = (time = 1180, duration = 1200, url = VIDEO) =>
    ctl.command({ action: "offer", url, time, duration }, alex);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { room, ctl, emitted, play, offer, flush };
}

describe("NextEpisodeController", () => {
  it("offers once per video, with startAt = duration", async () => {
    const t = setup();
    t.offer();
    t.offer();
    await t.flush();
    t.offer();
    expect(t.room.resolver).toHaveBeenCalledTimes(1);
    expect(t.emitted).toEqual([
      {
        state: "offered",
        next: { meta: nextMeta, thumbnail: null },
        startAt: 1200,
      },
    ]);
    expect(t.ctl.snapshot()).toMatchObject({ state: "offered", startAt: 1200 });
  });

  it.each([
    ["too early", { time: 100 }],
    ["another video", { url: "https://other.example/x.mp4" }],
    ["bad numbers", { time: Number.NaN }],
    ["time past the end", { time: 1300 }],
    ["zero duration", { time: 0, duration: 0 }],
  ])("ignores offers: %s", async (_name, o) => {
    const t = setup();
    const p = { time: 1180, duration: 1200, url: VIDEO, ...o };
    t.offer(p.time, p.duration, p.url);
    await t.flush();
    expect(t.room.resolver).not.toHaveBeenCalled();
  });

  it("accepts offers a little before the window (1 s reporting)", async () => {
    const t = setup();
    t.offer(1200 - DEFAULT_NEXT_EPISODE_OFFSET - 1.5);
    expect(t.room.resolver).toHaveBeenCalled();
  });

  it("ignores offers for movies, with a queue, looping, or without AIOStreams", async () => {
    const cases: ((t: ReturnType<typeof setup>) => void)[] = [
      (t) => (t.room.meta = { ...meta, type: "movie", episode: null }),
      (t) => (t.room.meta = null),
      (t) => (t.room.playlist = 1),
      (t) => (t.room.loop = true),
    ];
    for (const prep of cases) {
      const t = setup();
      prep(t);
      t.offer();
      expect(t.room.resolver).not.toHaveBeenCalled();
    }
    const t = setup();
    const ctl = new NextEpisodeController({
      video: () => VIDEO,
      videoMeta: () => meta,
      playlistLength: () => 0,
      loop: () => false,
      offset: () => 25,
      resolver: () => null,
      emit: (s) => t.emitted.push(s),
      play: t.play,
    });
    ctl.command(
      { action: "offer", url: VIDEO, time: 1190, duration: 1200 },
      alex,
    );
    await t.flush();
    expect(t.emitted).toEqual([]);
  });

  it("shows nothing when there's no next episode", async () => {
    const t = setup({ kind: "none" });
    t.offer();
    await t.flush();
    t.offer();
    expect(t.emitted).toEqual([]);
    expect(t.room.resolver).toHaveBeenCalledTimes(1);
  });

  it("announces failures once (rejections too)", async () => {
    const t = setup({ kind: "failed", meta: nextMeta, thumbnail: null });
    t.offer();
    await t.flush();
    expect(t.emitted).toEqual([
      { state: "failed", next: { meta: nextMeta, thumbnail: null } },
    ]);
    const r = setup(Promise.reject(new Error("boom")));
    r.offer();
    await r.flush();
    expect(r.emitted).toEqual([{ state: "failed", next: null }]);
  });

  it("cancel hides it for the whole room and sticks for this video", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.ctl.command({ action: "cancel" }, alex);
    expect(t.emitted.at(-1)).toEqual({ state: "cancelled", by: alex });
    t.ctl.tick(1200);
    t.ctl.command({ action: "ended", url: VIDEO }, alex);
    t.ctl.command({ action: "playNow" }, alex);
    t.offer();
    expect(t.play).not.toHaveBeenCalled();
    expect(t.ctl.snapshot()).toEqual({ state: "none" });
  });

  it("Play now starts it for everyone", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.ctl.command({ action: "playNow" }, alex);
    expect(t.emitted.at(-2)).toEqual({
      state: "starting",
      next: { meta: nextMeta, thumbnail: null },
      by: alex,
    });
    expect(t.play).toHaveBeenCalledWith(NEXT_URL, nextMeta, alex);
    // Only once
    t.ctl.command({ action: "playNow" }, alex);
    expect(t.play).toHaveBeenCalledTimes(1);
  });

  it("starts when the room's time reaches startAt", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.ctl.tick(1190);
    expect(t.play).not.toHaveBeenCalled();
    t.ctl.tick(1199.5);
    expect(t.play).toHaveBeenCalledWith(NEXT_URL, nextMeta, null);
  });

  it("starts when a player ends early, but not for a stale URL", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.ctl.command({ action: "ended", url: "https://old.example/x.mp4" }, alex);
    expect(t.play).not.toHaveBeenCalled();
    t.ctl.command({ action: "ended", url: VIDEO }, alex);
    expect(t.play).toHaveBeenCalledWith(NEXT_URL, nextMeta, null);
  });

  it("starts as soon as the lookup finishes if the video ended meanwhile", async () => {
    let resolve!: (r: NextEpisodeResult) => void;
    const t = setup(new Promise((r) => (resolve = r)));
    t.offer();
    t.ctl.command({ action: "playNow" }, alex);
    expect(t.play).not.toHaveBeenCalled();
    resolve(FOUND);
    await t.flush();
    expect(t.play).toHaveBeenCalledWith(NEXT_URL, nextMeta, alex);
    // play() hosts the next video, which resets the card for it
    expect(t.emitted.map((s) => s.state)).toEqual(["starting", "none"]);
  });

  it("drops a lookup that finishes after the video changed", async () => {
    let resolve!: (r: NextEpisodeResult) => void;
    const t = setup(new Promise((r) => (resolve = r)));
    t.offer();
    t.room.video = "https://other.example/x.mp4";
    t.ctl.reset();
    resolve(FOUND);
    await t.flush();
    expect(t.emitted).toEqual([{ state: "none" }]);
  });

  it("an explicit queue wins", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.room.playlist = 1;
    t.ctl.tick(1200);
    expect(t.play).not.toHaveBeenCalled();
    expect(t.emitted.at(-1)).toEqual({ state: "none" });
  });

  it("seeking back withdraws the card, and it can come back", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.ctl.seek(1190); // still inside the window
    expect(t.emitted).toHaveLength(1);
    t.ctl.seek(600);
    expect(t.emitted.at(-1)).toEqual({ state: "none" });
    t.offer();
    await t.flush();
    expect(t.emitted.at(-1)?.state).toBe("offered");
    expect(t.room.resolver).toHaveBeenCalledTimes(2);
  });

  it("resets when the video changes", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.ctl.reset();
    expect(t.emitted.at(-1)).toEqual({ state: "none" });
    expect(t.ctl.snapshot()).toEqual({ state: "none" });
  });

  it("ignores junk commands", () => {
    const t = setup();
    for (const raw of [null, 1, "offer", [], { action: "nope" }]) {
      t.ctl.command(raw, alex);
    }
    expect(t.emitted).toEqual([]);
  });
});

describe("NextEpisodeController edge cases", () => {
  it("starts once resolved when the episode ended while resolving", async () => {
    let resolve!: (r: NextEpisodeResult) => void;
    const t = setup(new Promise((r) => (resolve = r)));
    t.offer();
    t.ctl.command({ action: "ended", url: VIDEO }, alex);
    // A second ended keeps the first request
    t.ctl.command({ action: "ended", url: VIDEO }, alex);
    resolve(FOUND);
    await t.flush();
    expect(t.play).toHaveBeenCalledWith(NEXT_URL, nextMeta, null);
  });

  it("ignores ended and play now for a video that's no longer playing", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.room.video = "https://example.com/other.mp4";
    t.ctl.command({ action: "ended", url: VIDEO }, alex);
    t.ctl.command({ action: "playNow" }, alex);
    t.ctl.command({ action: "ended", url: 5 }, alex);
    expect(t.play).not.toHaveBeenCalled();
  });

  it("ignores play now before any offer, and withdraws instead of starting when a queue appeared", async () => {
    const t = setup();
    t.ctl.command({ action: "playNow" }, alex);
    expect(t.play).not.toHaveBeenCalled();
    t.offer();
    await t.flush();
    t.room.playlist = 1;
    t.ctl.command({ action: "playNow" }, alex);
    expect(t.play).not.toHaveBeenCalled();
    expect(t.emitted.at(-1)).toEqual({ state: "none" });
    expect(t.ctl.snapshot()).toEqual({ state: "none" });
  });

  it("doesn't start twice once done", async () => {
    const t = setup();
    t.offer();
    await t.flush();
    t.ctl.command({ action: "playNow" }, alex);
    t.ctl.command({ action: "playNow" }, alex);
    expect(t.play).toHaveBeenCalledTimes(1);
  });
});
