// Volume boost / Night mode: settings parsing, which sources Web Audio can read, the CORS check, and the AudioBoost
// lifecycle (never binding while the AudioContext is suspended, gestures resuming it, loads on a bound element).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioBoost,
  BOOST_RELOAD_KEY,
  LIMITER,
  NIGHT,
  NIGHT_MODE_KEY,
  VOLUME_BOOST_KEY,
  audioTapState,
  boostGain,
  classifySource,
  corsReadable,
  describeBoost,
  isBoostActive,
  stuttersOnLacedAudio,
  parseBoostLevel,
  readBoostSettings,
  saveBoostSettings,
} from "./audioBoost";

const ORIGIN = "https://watch.example.com";

const param = (value = 0) => ({ value });
function fakeNode() {
  return { connect: vi.fn() };
}
function fakeCompressor() {
  return {
    ...fakeNode(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
  };
}

class FakeContext {
  state: AudioContextState = "running";
  onstatechange: (() => void) | null = null;
  destination = { name: "speakers" };
  sources: HTMLMediaElement[] = [];
  compressors: ReturnType<typeof fakeCompressor>[] = [];
  gains: { connect: ReturnType<typeof vi.fn>; gain: { value: number } }[] = [];
  resume = vi.fn(async () => {
    if (this.allowResume) {
      this.setState("running");
    }
  });
  close = vi.fn(async () => {});
  allowResume = true;
  setState(state: AudioContextState) {
    this.state = state;
    this.onstatechange?.();
  }
  createMediaElementSource = vi.fn((el: HTMLMediaElement) => {
    this.sources.push(el);
    return fakeNode();
  });
  createDynamicsCompressor = vi.fn(() => {
    const c = fakeCompressor();
    this.compressors.push(c);
    return c;
  });
  createGain = vi.fn(() => {
    const g = { ...fakeNode(), gain: param(1) };
    this.gains.push(g);
    return g;
  });
}

let video: HTMLVideoElement;
let readyState = 1;
let ctx: FakeContext;
let cors: ReturnType<typeof vi.fn<(src: string) => Promise<boolean>>>;

function makeBoost(opts: { noContext?: boolean } = {}) {
  const boost = new AudioBoost(
    () => document.getElementById("v") as HTMLMediaElement | null,
    {
      createContext: () =>
        opts.noContext ? null : (ctx as unknown as AudioContext),
      corsReadable: (src) => cors(src),
      origin: () => ORIGIN,
    },
  );
  const statuses: string[] = [];
  boost.onStatus = (s) => statuses.push(s);
  return { boost, statuses };
}

beforeEach(() => {
  document.body.innerHTML = '<video id="v"></video>';
  video = document.getElementById("v") as HTMLVideoElement;
  readyState = 1;
  Object.defineProperty(video, "readyState", {
    configurable: true,
    get: () => readyState,
  });
  ctx = new FakeContext();
  cors = vi.fn(async () => true);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings", () => {
  it("parses only the offered levels", () => {
    expect(parseBoostLevel("2")).toBe(2);
    expect(parseBoostLevel("1.5")).toBe(1.5);
    expect(parseBoostLevel("5")).toBe(1);
    expect(parseBoostLevel(null)).toBe(1);
    expect(parseBoostLevel("abc")).toBe(1);
  });

  it("reads and saves per device", () => {
    expect(readBoostSettings()).toEqual({ level: 1, night: false });
    saveBoostSettings({ level: 3, night: true });
    expect(localStorage.getItem(VOLUME_BOOST_KEY)).toBe("3");
    expect(localStorage.getItem(NIGHT_MODE_KEY)).toBe("1");
    expect(readBoostSettings()).toEqual({ level: 3, night: true });
  });

  it("falls back to off when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readBoostSettings()).toEqual({ level: 1, night: false });
    expect(() => saveBoostSettings({ level: 2, night: false })).not.toThrow();
  });

  it("describes, activates and computes the gain", () => {
    expect(describeBoost({ level: 2, night: false })).toBe("200%");
    expect(describeBoost({ level: 1, night: true })).toBe("Night");
    expect(describeBoost({ level: 1.5, night: true })).toBe("150% · Night");
    expect(isBoostActive({ level: 1, night: false })).toBe(false);
    expect(isBoostActive({ level: 1, night: true })).toBe(true);
    expect(boostGain({ level: 2, night: false })).toBe(2);
    expect(boostGain({ level: 2, night: true })).toBe(2 * NIGHT.makeup);
  });
});

describe("stuttersOnLacedAudio", () => {
  it("is Firefox and its forks only", () => {
    const ff =
      "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
    expect(stuttersOnLacedAudio(ff)).toBe(true);
    expect(
      stuttersOnLacedAudio(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(typeof stuttersOnLacedAudio()).toBe("boolean");
  });
});

describe("sources", () => {
  it("classifies what Web Audio can read", () => {
    expect(classifySource("", ORIGIN)).toBe("none");
    expect(classifySource("blob:https://watch.example.com/x", ORIGIN)).toBe(
      "local",
    );
    expect(classifySource("data:video/mp4;base64,AA", ORIGIN)).toBe("local");
    expect(classifySource("/proxy/a.mp4", ORIGIN)).toBe("local");
    expect(classifySource("https://cdn.example.com/a.mp4", ORIGIN)).toBe(
      "cross-origin",
    );
    expect(classifySource("https://cdn.example.com/a.M3U8", ORIGIN)).toBe(
      "native-hls",
    );
    expect(classifySource("http://[bad", ORIGIN)).toBe("cross-origin");
  });

  it("never counts an emptied or not yet loaded element as readable", () => {
    // src="" resolves to the page's own URL: that's not a source
    video.src = "";
    expect(audioTapState(video, `${window.location.origin}`)).toBe("none");
    video.src = `${ORIGIN}/a.mp4`;
    readyState = 0;
    expect(audioTapState(video, ORIGIN)).toBe("none");
  });

  it("knows when the element's current audio is readable", () => {
    expect(audioTapState(video, ORIGIN)).toBe("none");
    video.src = "https://cdn.example.com/a.mp4";
    expect(audioTapState(video, ORIGIN)).toBe("blocked");
    video.crossOrigin = "anonymous";
    expect(audioTapState(video, ORIGIN)).toBe("ok");
    video.src = `${ORIGIN}/proxy/a.mp4`;
    expect(audioTapState(video, ORIGIN)).toBe("ok");
    video.src = "https://cdn.example.com/live.m3u8";
    expect(audioTapState(video, ORIGIN)).toBe("blocked");
    Object.defineProperty(video, "srcObject", {
      configurable: true,
      value: {},
    });
    expect(audioTapState(video, ORIGIN)).toBe("ok");
  });

  it("checks CORS with a 1-byte request", async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi.fn(
      async () => ({ ok: true, body: { cancel } }) as unknown as Response,
    );
    expect(
      await corsReadable("https://cdn.example.com/a.mp4", 100, fetchImpl),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cdn.example.com/a.mp4",
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        headers: { Range: "bytes=0-0" },
      }),
    );
    expect(cancel).toHaveBeenCalled();
    const notOk = vi.fn(
      async () => ({ ok: false, body: null }) as unknown as Response,
    );
    expect(await corsReadable("https://x.example.com/a", 100, notOk)).toBe(
      false,
    );
    const fails = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await corsReadable("https://x.example.com/a", 100, fails)).toBe(
      false,
    );
  });

  it("uses the global fetch by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("no"));
    expect(await corsReadable("https://x.example.com/a")).toBe(false);
    expect(spy).toHaveBeenCalled();
  });
});

describe("AudioBoost", () => {
  it("does nothing while off", () => {
    const { boost, statuses } = makeBoost();
    video.src = `${ORIGIN}/a.mp4`;
    boost.refresh();
    expect(boost.status).toBe("off");
    expect(statuses).toEqual([]);
    expect(ctx.createMediaElementSource).not.toHaveBeenCalled();
  });

  it("waits for a video, then binds and applies the boost", () => {
    const { boost, statuses } = makeBoost();
    boost.set({ level: 2 });
    expect(boost.status).toBe("idle");
    video.src = `${ORIGIN}/a.mp4`;
    boost.refresh();
    expect(boost.status).toBe("on");
    expect(boost.bound).toBe(true);
    expect(ctx.sources).toEqual([video]);
    expect(ctx.gains[0].gain.value).toBe(2);
    const [night, limiter] = ctx.compressors;
    expect(night.ratio.value).toBe(1);
    expect(night.threshold.value).toBe(0);
    expect(limiter.threshold.value).toBe(LIMITER.threshold);
    expect(limiter.ratio.value).toBe(LIMITER.ratio);
    expect(statuses).toEqual(["idle", "on"]);
  });

  it("applies Night mode and turns off without unbinding", () => {
    const { boost } = makeBoost();
    video.src = `${ORIGIN}/a.mp4`;
    boost.set({ night: true });
    const [night] = ctx.compressors;
    expect(night.ratio.value).toBe(NIGHT.ratio);
    expect(night.threshold.value).toBe(NIGHT.threshold);
    expect(ctx.gains[0].gain.value).toBe(NIGHT.makeup);
    boost.set({ night: false });
    expect(boost.status).toBe("off");
    expect(boost.bound).toBe(true);
    expect(night.ratio.value).toBe(1);
    expect(ctx.gains[0].gain.value).toBe(1);
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("is unavailable for native HLS, and without Web Audio", () => {
    const { boost } = makeBoost();
    video.src = "https://cdn.example.com/live.m3u8";
    boost.set({ level: 2 });
    expect(boost.status).toBe("unavailable");
    expect(boost.bound).toBe(false);
    expect(cors).not.toHaveBeenCalled();
    const other = makeBoost({ noContext: true }).boost;
    video.src = `${ORIGIN}/a.mp4`;
    other.set({ level: 2 });
    expect(other.status).toBe("unavailable");
  });

  it("turned on mid-video: reloads a CORS-friendly link in CORS mode where it was", async () => {
    const { boost } = makeBoost();
    video.src = "https://cdn.example.com/a.mp4";
    video.currentTime = 42;
    Object.defineProperty(video, "paused", {
      configurable: true,
      value: false,
    });
    const play = vi.spyOn(video, "play").mockResolvedValue();
    boost.set({ level: 2 });
    expect(boost.status).toBe("idle");
    await vi.waitFor(() => expect(video.crossOrigin).toBe("anonymous"));
    expect(cors).toHaveBeenCalledWith("https://cdn.example.com/a.mp4");
    expect(video.src).toBe("https://cdn.example.com/a.mp4");
    expect(video.currentTime).toBe(42);
    expect(play).toHaveBeenCalled();
    // The reloaded video's loadedmetadata binds it
    boost.refresh();
    expect(boost.status).toBe("on");
  });

  it("stays paused after the CORS reload of a paused video", async () => {
    const { boost } = makeBoost();
    video.src = "https://cdn.example.com/a.mp4";
    const play = vi.spyOn(video, "play").mockResolvedValue();
    boost.set({ level: 2 });
    await vi.waitFor(() => expect(video.crossOrigin).toBe("anonymous"));
    expect(play).not.toHaveBeenCalled();
  });

  it("turned on mid-video without CORS: unavailable, checked once", async () => {
    cors.mockResolvedValue(false);
    const { boost } = makeBoost();
    video.src = "https://cdn.example.com/a.mp4";
    boost.set({ level: 2 });
    await vi.waitFor(() => expect(boost.status).toBe("unavailable"));
    expect(video.crossOrigin).toBeNull();
    boost.refresh();
    expect(boost.status).toBe("unavailable");
    expect(cors).toHaveBeenCalledTimes(1);
  });

  it("ignores a CORS check that finishes after the video changed or the boost went off", async () => {
    let resolve!: (ok: boolean) => void;
    cors.mockImplementation(() => new Promise((r) => (resolve = r)));
    const { boost } = makeBoost();
    video.src = "https://cdn.example.com/a.mp4";
    boost.set({ level: 2 });
    video.src = "https://cdn.example.com/b.mp4";
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(video.crossOrigin).toBeNull();
    // Off during the check: checked again when it's back on
    boost.set({ level: 2 });
    boost.set({ level: 1 });
    resolve(true);
    await vi.waitFor(() => expect(cors).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(video.crossOrigin).toBeNull();
    cors.mockResolvedValue(true);
    boost.set({ level: 2 });
    await vi.waitFor(() => expect(video.crossOrigin).toBe("anonymous"));
  });

  it("is idle without an element", () => {
    document.body.innerHTML = "";
    const { boost } = makeBoost();
    boost.set({ level: 2 });
    expect(boost.status).toBe("idle");
  });

  it("never binds while the context is suspended; the next gesture starts it", async () => {
    ctx.state = "suspended";
    ctx.allowResume = false;
    const { boost } = makeBoost();
    video.src = `${ORIGIN}/a.mp4`;
    boost.set({ level: 2 });
    expect(boost.status).toBe("pending");
    expect(boost.bound).toBe(false);
    expect(ctx.resume).toHaveBeenCalled();
    ctx.allowResume = true;
    document.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(boost.status).toBe("on"));
    expect(boost.bound).toBe(true);
    // No longer listening
    ctx.resume.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown"));
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("resumes an interrupted context on the next gesture, even while off", async () => {
    const { boost } = makeBoost();
    video.src = `${ORIGIN}/a.mp4`;
    boost.set({ level: 2 });
    ctx.allowResume = false;
    ctx.setState("interrupted" as AudioContextState);
    expect(boost.status).toBe("pending");
    boost.set({ level: 1 });
    expect(boost.status).toBe("off");
    ctx.allowResume = true;
    document.dispatchEvent(new KeyboardEvent("keydown"));
    await vi.waitFor(() => expect(ctx.state).toBe("running"));
  });

  it("turning off before binding stops waiting for gestures", () => {
    ctx.state = "suspended";
    ctx.allowResume = false;
    const { boost } = makeBoost();
    video.src = `${ORIGIN}/a.mp4`;
    boost.set({ level: 2 });
    boost.set({ level: 1 });
    expect(boost.status).toBe("off");
    ctx.resume.mockClear();
    document.dispatchEvent(new Event("pointerdown"));
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("prepares loads on a bound element", async () => {
    const { boost } = makeBoost();
    video.crossOrigin = "anonymous";
    expect(
      await boost.prepareLoad(video, "https://cdn.example.com/a.mp4"),
    ).toBe(true);
    // Off: the element loads without CORS mode, nothing is checked
    expect(video.crossOrigin).toBeNull();
    expect(cors).not.toHaveBeenCalled();
    video.src = `${ORIGIN}/a.mp4`;
    boost.set({ level: 2 });
    expect(await boost.prepareLoad(video, "")).toBe(true);
    expect(await boost.prepareLoad(video, "blob:x")).toBe(true);
    expect(video.crossOrigin).toBeNull();
    expect(
      await boost.prepareLoad(video, "https://cdn.example.com/a.mp4"),
    ).toBe(true);
    expect(video.crossOrigin).toBe("anonymous");
    cors.mockResolvedValueOnce(false);
    expect(await boost.prepareLoad(video, "https://other.example.com/b")).toBe(
      false,
    );
    expect(
      await boost.prepareLoad(video, "https://cdn.example.com/a.m3u8"),
    ).toBe(false);
  });

  it("keeps the graph while the element is in the page, closes it after", () => {
    const { boost } = makeBoost();
    video.src = `${ORIGIN}/a.mp4`;
    boost.set({ level: 2 });
    boost.dispose();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(boost.bound).toBe(true);
    document.body.innerHTML = "";
    boost.dispose();
    expect(ctx.close).toHaveBeenCalled();
    expect(boost.bound).toBe(false);
    // Nothing to close the second time
    makeBoost().boost.dispose();
  });

  it("exports the reload flag key", () => {
    expect(BOOST_RELOAD_KEY).toBe("wp-boost-reload");
  });
});

describe("AudioBoost loads while on but not bound yet", () => {
  it("uses CORS mode where the server allows it, else loads normally", async () => {
    ctx.state = "suspended";
    ctx.allowResume = false;
    const { boost } = makeBoost();
    boost.set({ level: 2 });
    expect(
      await boost.prepareLoad(video, "https://cdn.example.com/a.mp4"),
    ).toBe(true);
    expect(video.crossOrigin).toBe("anonymous");
    cors.mockResolvedValueOnce(false);
    expect(
      await boost.prepareLoad(video, "https://other.example.com/b.mp4"),
    ).toBe(true);
    expect(video.crossOrigin).toBeNull();
    expect(
      await boost.prepareLoad(video, "https://cdn.example.com/live.m3u8"),
    ).toBe(true);
    expect(video.crossOrigin).toBeNull();
    expect(await boost.prepareLoad(video, `${ORIGIN}/a.mp4`)).toBe(true);
  });
});

describe("AudioBoost defaults", () => {
  it("uses window.AudioContext and the page origin", () => {
    const made: FakeContext[] = [];
    vi.stubGlobal(
      "AudioContext",
      class extends FakeContext {
        constructor() {
          super();
          made.push(this);
        }
      },
    );
    const boost = new AudioBoost(() => video);
    video.src = `${window.location.origin}/a.mp4`;
    boost.set({ level: 2 });
    expect(made).toHaveLength(1);
    expect(boost.status).toBe("on");
    vi.unstubAllGlobals();
  });

  it("is unavailable without Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    const boost = new AudioBoost(() => video);
    video.src = `${window.location.origin}/a.mp4`;
    boost.set({ level: 2 });
    expect(boost.status).toBe("unavailable");
    vi.unstubAllGlobals();
  });
});
