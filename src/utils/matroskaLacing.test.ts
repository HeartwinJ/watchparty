// matroskaLacing: finds laced audio blocks in hand-built Matroska files, gives up safely on anything unexpected.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioTrackNumbers,
  blockLacing,
  hasLacedAudio,
  urlRangeReader,
} from "./matroskaLacing";

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackType: [0x83],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Cues: [0x1c, 0x53, 0xbb, 0x6b],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
  BlockGroup: [0xa0],
  Block: [0xa1],
};
const size = (n: number) =>
  n < 127
    ? [0x80 | n]
    : n < 0x3fff
      ? [0x40 | (n >> 8), n & 0xff]
      : [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id: number[], ...body: number[][]) => {
  const data = body.flat();
  return [...id, ...size(data.length), ...data];
};
const unknownSize = (id: number[], ...body: number[][]) => [
  ...id,
  ...UNKNOWN,
  ...body.flat(),
];
const track = (number: number, type: number) =>
  el(ID.TrackEntry, el(ID.TrackNumber, [number]), el(ID.TrackType, [type]));
/** Track 1 video, track 2 audio */
const tracks = el(ID.Tracks, track(1, 1), track(2, 2));
const block = (trackNo: number, lacing: number) => [
  0x80 | trackNo,
  0,
  0,
  0x80 | (lacing << 1),
  1,
  2,
  3,
];
const simple = (trackNo: number, lacing = 0) =>
  el(ID.SimpleBlock, block(trackNo, lacing));
const file = (...segment: number[][]) =>
  new Uint8Array([
    ...el(ID.EBML, [0x42, 0x86, 0x81, 0x01]),
    ...el(ID.Segment, ...segment),
  ]);
const reader = (bytes: Uint8Array) =>
  vi.fn(async (offset: number, length: number) =>
    bytes.slice(offset, offset + length),
  );
const unlacedAudio = Array.from({ length: 8 }, () => simple(2));

describe("hasLacedAudio", () => {
  it("is true when an audio block is laced (EBML, Xiph or fixed-size lacing)", async () => {
    for (const lacing of [1, 2, 3]) {
      const bytes = file(
        el(ID.Info, [0]),
        tracks,
        el(ID.Cluster, el(ID.Timecode, [0]), simple(1), simple(2, lacing)),
      );
      expect(await hasLacedAudio(reader(bytes))).toBe(true);
    }
  });

  it("is false when the first audio blocks aren't laced, even if video blocks are", async () => {
    const bytes = file(
      tracks,
      el(ID.Cluster, simple(1, 3), ...unlacedAudio, simple(2, 3)),
    );
    expect(await hasLacedAudio(reader(bytes))).toBe(false);
  });

  it("reads Blocks inside BlockGroups", async () => {
    const group = (lacing: number) =>
      el(ID.BlockGroup, el([0x9b], [5]), el(ID.Block, block(2, lacing)));
    expect(
      await hasLacedAudio(reader(file(tracks, el(ID.Cluster, group(3))))),
    ).toBe(true);
    expect(
      await hasLacedAudio(
        reader(
          file(
            tracks,
            el(ID.Cluster, ...Array.from({ length: 8 }, () => group(0))),
          ),
        ),
      ),
    ).toBe(false);
  });

  it("handles a live-style file: segment and clusters of unknown size", async () => {
    const bytes = new Uint8Array([
      ...el(ID.EBML, [0]),
      ...unknownSize(
        ID.Segment,
        tracks,
        unknownSize(ID.Cluster, simple(1)),
        unknownSize(ID.Cluster, simple(2, 3)),
      ),
    ]);
    expect(await hasLacedAudio(reader(bytes))).toBe(true);
  });

  it("checks a few clusters at most, then says no", async () => {
    const clusters = Array.from({ length: 5 }, () => el(ID.Cluster, simple(1)));
    const bytes = file(tracks, ...clusters, el(ID.Cluster, simple(2, 3)));
    expect(await hasLacedAudio(reader(bytes))).toBe(false);
  });

  it("skips large elements with new range reads", async () => {
    const big = el([0xec], new Array(4000).fill(0)); // Void
    const filler = el(ID.Cues, ...Array.from({ length: 30 }, () => big));
    const bytes = file(tracks, filler, el(ID.Cluster, simple(2, 3)));
    const read = reader(bytes);
    expect(await hasLacedAudio(read)).toBe(true);
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });

  it("says no when it can't tell", async () => {
    const cases: Uint8Array[] = [
      new Uint8Array([0, 1, 2, 3]), // not EBML
      new Uint8Array(el(ID.EBML, [0])), // no segment
      file(el(ID.Cluster, simple(2, 3))), // no track list before the first cluster
      file(el(ID.Tracks, track(1, 1)), el(ID.Cluster, simple(1, 3))), // no audio track
      file(tracks, unknownSize(ID.Cues, [0])), // unknown size outside a cluster
      file(tracks, el(ID.Cluster, unknownSize(ID.SimpleBlock, block(2, 3)))),
      file(tracks, el(ID.Cluster, [0x00, 0x00])), // garbage in a cluster
      file(tracks, el(ID.Cluster, el(ID.BlockGroup, [0x00]))),
      file(tracks, el(ID.Cluster, simple(2)).slice(0, -6)), // cut short
      file(tracks), // no clusters
    ];
    for (const bytes of cases) {
      expect(await hasLacedAudio(reader(bytes))).toBe(false);
    }
    expect(
      await hasLacedAudio(async () => {
        throw new Error("network");
      }),
    ).toBe(false);
  });

  it("gives up on a track list that's too big or of unknown size", async () => {
    const huge = new Uint8Array([
      ...el(ID.EBML, [0]),
      ...ID.Segment,
      ...UNKNOWN,
      ...ID.Tracks,
      0x08,
      0x00,
      0x00,
      0x00,
      0x10,
      0x00,
      0x00,
      0x00, // 256 MB
    ]);
    expect(await hasLacedAudio(reader(huge))).toBe(false);
    expect(
      await hasLacedAudio(reader(file(unknownSize(ID.Tracks, track(2, 2))))),
    ).toBe(false);
  });

  it("stops after a bounded number of reads", async () => {
    const read = vi.fn(async (offset: number, length: number) => {
      // Endless 1-byte-short Void elements force a new read each time
      const out = new Uint8Array(Math.min(length, 16));
      out.set([0xec, 0x40 | 0x3f, 0xff]);
      return offset === 0 ? new Uint8Array(el(ID.EBML, [0])) : out;
    });
    expect(await hasLacedAudio(read)).toBe(false);
    expect(read.mock.calls.length).toBeLessThanOrEqual(17);
  });
});

describe("parsers", () => {
  it("lists audio track numbers and stops at broken entries", () => {
    expect([
      ...audioTrackNumbers(
        new Uint8Array([
          ...track(1, 1),
          ...track(2, 2),
          ...track(3, 2),
          ...el([0xbf], [0]),
        ]),
      ),
    ]).toEqual([2, 3]);
    expect([
      ...audioTrackNumbers(new Uint8Array([...track(2, 2), 0x00])),
    ]).toEqual([2]);
    expect([
      ...audioTrackNumbers(
        new Uint8Array(el(ID.TrackEntry, [0xd7, ...UNKNOWN])),
      ),
    ]).toEqual([]);
  });

  it("reads a block's track and lacing", () => {
    expect(blockLacing(new Uint8Array(block(2, 3)))).toEqual({
      track: 2,
      lacing: 3,
    });
    expect(blockLacing(new Uint8Array([0x82, 0]))).toBeNull();
    expect(blockLacing(new Uint8Array([0x00, 0, 0, 0]))).toBeNull();
  });
});

describe("urlRangeReader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the range and returns the bytes", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), { status: 206 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const read = urlRangeReader("https://cdn.example.com/a.mkv");
    expect([...(await read(10, 3))]).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Range: "bytes=10-12",
    });
  });

  it("refuses a server that ignores the range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("whole file", { status: 200 })),
    );
    await expect(
      urlRangeReader("https://cdn.example.com/a.mkv")(0, 10),
    ).rejects.toThrow(/range not supported/);
  });
});
