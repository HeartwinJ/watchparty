// Small client utilities: rooms API helpers, ids, the file picker, name generation, the string hash, settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../router")>()),
  navigate: (...a: unknown[]) => navigate(...a),
}));
const apiFetch = vi.fn();
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

const rooms = await import("./rooms");
const utils = await import("./utils");
const { generateName } = await import("./generateName");
const { cyrb53 } = await import("./hash");
const settings = await import("../components/Settings/LocalSettings");

beforeEach(() => {
  navigate.mockClear();
  apiFetch.mockReset();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("rooms", () => {
  it("createRoom posts the video and navigates (or replaces) to the room", async () => {
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ name: "/brave-otter" })),
    );
    expect(
      await rooms.createRoom({
        video: "https://v.example.com/a.mp4",
        replace: true,
      }),
    ).toBe("brave-otter");
    expect(apiFetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ video: "https://v.example.com/a.mp4" }),
    });
    expect(navigate).toHaveBeenCalledWith("/watch/brave-otter", {
      replace: true,
    });
  });

  it("createRoom can open the room in a new tab", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ name: "/x" })));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await rooms.createRoom({ openNewTab: true });
    expect(open).toHaveBeenCalledWith("/watch/x");
    expect(navigate).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls[0][1].body).toBe(JSON.stringify({ video: "" }));
  });

  it("createRoom throws on a server error", async () => {
    apiFetch.mockResolvedValue(new Response("", { status: 403 }));
    await expect(rooms.createRoom()).rejects.toThrow("(403)");
  });

  it("deleteRoom: 204 and 404 count as gone, anything else as failed", async () => {
    apiFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await rooms.deleteRoom("/brave otter")).toBe(true);
    expect(apiFetch.mock.calls[0]).toEqual([
      "/rooms/brave%20otter",
      { method: "DELETE" },
    ]);
    apiFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await rooms.deleteRoom("x")).toBe(true);
    apiFetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await rooms.deleteRoom("x")).toBe(false);
  });

  it("names rooms by title, else readably", () => {
    expect(rooms.roomDisplayName("brave-otter", "  Movie night ")).toBe(
      "Movie night",
    );
    expect(rooms.roomDisplayName("/brave_otter-sings", " ")).toBe(
      "Brave otter sings",
    );
    expect(rooms.prettyRoomName("///")).toBe("Room");
  });
});

describe("utils", () => {
  it("keeps one client and session id per device", () => {
    const id = utils.getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(utils.getOrCreateClientId()).toBe(id);
    const s = utils.getOrCreateSessionId();
    expect(utils.getOrCreateSessionId()).toBe(s);
    expect(s).not.toBe(id);
  });

  it("generates v4 ids without crypto.randomUUID", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(utils.getOrCreateClientId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: original,
      });
    }
  });

  it("openFileSelector resolves with the picked files", async () => {
    let input: HTMLInputElement | undefined;
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = create(tag);
      if (tag === "input") input = el as HTMLInputElement;
      return el;
    });
    const p = utils.openFileSelector(".srt");
    expect(input!.type).toBe("file");
    expect(input!.accept).toBe(".srt");
    input!.dispatchEvent(new Event("change"));
    expect(await p).toBe(input!.files);
  });

  it("decodes HTML entities and tells share URLs apart", () => {
    expect(utils.decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(utils.isScreenShare("screenshare://abc")).toBe(true);
    expect(utils.isFileShare("fileshare://abc")).toBe(true);
    expect(utils.isFileShare("https://x")).toBe(false);
    expect(utils.isDash("https://x/a.mpd")).toBe(true);
    expect(utils.isDirectVideoUrl("https://www.reddit.com/r/x")).toBe(false);
    expect(utils.isDirectVideoUrl("https://x/a.mpegts")).toBe(false);
  });

  it("isMobile follows the screen width", () => {
    const spy = vi.spyOn(window.screen, "width", "get").mockReturnValue(400);
    expect(utils.isMobile()).toBe(true);
    spy.mockReturnValue(1200);
    expect(utils.isMobile()).toBe(false);
  });

  it("formatTimestamp shows wall-clock time with a zero time", () => {
    expect(utils.formatTimestamp(10, 1_700_000_000)).toBe(
      new Date((1_700_000_000 + 10) * 1000).toLocaleTimeString(),
    );
  });
});

describe("generateName", () => {
  it("returns the server's name", async () => {
    apiFetch.mockResolvedValue(new Response("Lucky Llama"));
    expect(await generateName()).toBe("Lucky Llama");
    expect(apiFetch).toHaveBeenCalledWith("/generateName");
  });
});

describe("cyrb53", () => {
  it("is stable, seedable and spreads similar strings", () => {
    expect(cyrb53("hello")).toBe(cyrb53("hello"));
    expect(cyrb53("hello")).not.toBe(cyrb53("hellp"));
    expect(cyrb53("hello", 1)).not.toBe(cyrb53("hello"));
    expect(Number.isSafeInteger(cyrb53("x"))).toBe(true);
  });
});

describe("LocalSettings", () => {
  it("reads, writes and survives bad values", () => {
    expect(settings.getCurrentSettings()).toEqual({});
    settings.updateSettings(JSON.stringify({ disableChatSound: true }));
    expect(settings.getCurrentSettings()).toEqual({ disableChatSound: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.localStorage.setItem("watchparty-setting", "garbage");
    expect(settings.getCurrentSettings()).toEqual(
      settings.getDefaultSettings(),
    );
    expect(warn).toHaveBeenCalled();
    expect(settings.validateSettingsString(null)).toEqual({});
  });
});
