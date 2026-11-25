import { describe, expect, it } from "vitest";
import {
  classifyStream,
  descriptionFields,
  parseAudio,
  parseBitrate,
  parseDuration,
  parseSize,
  parseStream,
  rankStreams,
  scoreStream,
  type ParsedStream,
  type RawStream,
} from "./streamParser.ts";

// Synthetic fixtures modelled on AIOStreams' default formatter output.
const URL_BASE = "https://aio.example.com/api/v1/debrid/playback/abc/-/def";
let n = 0;
function mk(opts: {
  name?: string;
  lines: string[];
  filename?: string;
  size?: number;
  bingeGroup?: string;
  url?: string | null;
}): RawStream {
  n++;
  return {
    name: opts.name ?? "🚀 FHD",
    description: opts.lines.join("\n"),
    url:
      opts.url === null ? undefined : (opts.url ?? `${URL_BASE}/${n}/file.mkv`),
    behaviorHints: {
      bingeGroup: opts.bingeGroup ?? "aio.example.com|1080p",
      ...(opts.size ? { videoSize: opts.size } : {}),
      ...(opts.filename ? { filename: opts.filename } : {}),
    },
  };
}

const REMUX_4K = mk({
  name: "🔥4K UHD",
  lines: [
    "🎬 Some Movie (1994) ",
    "🎥 BluRay REMUX 📺 HDR10 🎞️ HEVC ⏱️ 2h:22m:32s ",
    "🎧 DD | DTS-HD MA 🔊 2.0 | 5.1 🗣️ 🇷🇺 / 🇺🇦 / 🇬🇧📝 🇷🇺 / 🇬🇧",
    "📦 93.9 GB 📊 87.9 Mbps ",
    "📡 Rutor ",
    "⚡Ready (TB) 🔍Torrentio ",
  ],
  filename: "Some Movie (1994) - UHD BD-Remux by Someone.mkv",
  size: 93947973227,
  bingeGroup: "aio.example.com|2160p|BluRay REMUX",
});

const WEBDL_H264_AAC = mk({
  lines: [
    "🎬 Some Movie (1994) ",
    "🎥 WEB-DL 🎞️ AVC ⏱️ 2h:22m:29s ",
    "🎧 AAC 🔊 5.1 🗣️ 🇪🇸 / 🇬🇧",
    "📦 10.3 GB 📊 9.64 Mbps ",
    "📡 StremThru ",
    "⚡Ready (TB) 🔍Comet ",
  ],
  filename: "Some.Movie.1994.WEB-DL.1080p-Dual-Lat.mkv",
  size: 10297370762,
  bingeGroup: "aio.example.com|1080p|WEB-DL",
});

const MP4_H264_AAC = mk({
  lines: ["🎬 Some Movie ", "🎞️ AVC ", "🎧 AAC 🔊 2.0", "📦 1.6 GB "],
  filename: "Some.Movie.2004.1080p.BluRay.x264.AAC5.1-[GRP].mp4",
  size: 1634872655,
});

const H264_DDP = mk({
  lines: [
    "🎬 Show 🍂 S01 🎞️ E01",
    "🎥 WEB-DL 🎞️ AVC ",
    "🎧 DD+ 🔊 5.1 🗣️ 🇬🇧",
    "📦 2.58 GB / 15.5 GB 📊 5.91 Mbps ",
    "🏷️ GRP 📡 StremThru|1337x ",
    "⚡Ready (TB) 🔍Comet ",
  ],
  filename: "Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv",
  size: 2576747154,
});

const HEVC_DDP_10BIT = mk({
  lines: [
    "🎬 Show 🍂 S01 🎞️ E01",
    "🎥 BluRay 📺 10bit 🎞️ HEVC ⏱️ 58m:6s ",
    "🎧 DD+ 🔊 5.1 🗣️ 🇬🇧",
    "📦 2.58 GB / 15.5 GB 📊 5.91 Mbps ",
    "🏷️ IONICBOY 📡 StremThru|TorrentGalaxyClone ",
    "⚡Ready (TB) 🔍Comet ",
  ],
  filename:
    "Show.S01E01.1080p.10Bit.BluRay.English.DDP5.1.x265.HEVC-IONICBOY.mkv",
  size: 2576747154,
  bingeGroup: "aio.example.com|1080p|BluRay|IONICBOY",
});

const DTS_ONLY = mk({
  name: "🚀 FHD",
  lines: [
    "🎬 Cadena Perpetua ",
    "🎞️ AVC ⏱️ 2h:22m:37s ",
    "🎧 DTS 🔊 5.1 🗣️ 🇪🇸 / 🇬🇧📝 🇪🇸 / 🇬🇧",
    "📦 9.9 GB 📊 9.5 Mbps ",
    "📡 Peerflix| Peerflix ",
    "⚡Ready (TB) 📌 Library 🔍Comet ",
  ],
  filename: "Cadena Perpetua BDR1080.www.example.com.mkv",
});

describe("field helpers", () => {
  it("splits description lines on emoji markers", () => {
    const f = descriptionFields(
      "🎥 BluRay REMUX 📺 DV | HDR10 🎞️ HEVC ⏱️ 2h:22m:32s \n🎧 DD | DTS-HD MA 🔊 2.0 | 5.1",
    );
    expect(f.get("🎥")).toEqual(["BluRay REMUX"]);
    expect(f.get("📺")).toEqual(["DV | HDR10"]);
    expect(f.get("🎞")).toEqual(["HEVC"]);
    expect(f.get("⏱")).toEqual(["2h:22m:32s"]);
    expect(f.get("🎧")).toEqual(["DD | DTS-HD MA"]);
    expect(f.get("🔊")).toEqual(["2.0 | 5.1"]);
  });

  it("accepts markers with or without the emoji variation selector", () => {
    expect(descriptionFields("🎞 AV1 ⏱ 1h").get("🎞")).toEqual(["AV1"]);
    expect(descriptionFields("🎞️ AV1 ⏱️ 1h").get("🎞")).toEqual(["AV1"]);
  });

  it.each([
    ["93.9 GB", 93.9e9],
    ["342 MB / 3.98 GB", 342e6],
    ["1,5 GB", 1.5e9],
    ["2 GiB", 2 * 1024 ** 3],
    ["700 KB", 700e3],
    ["nothing", null],
  ])("parseSize(%s)", (text, expected) => {
    expect(parseSize(text)).toBe(expected);
  });

  it.each([
    ["87.9 Mbps", 87.9],
    ["800 Kbps", 0.8],
    ["1.2 Gbps", 1200],
    ["", null],
  ])("parseBitrate(%s)", (text, expected) => {
    if (expected === null) {
      expect(parseBitrate(text)).toBeNull();
    } else {
      expect(parseBitrate(text)).toBeCloseTo(expected);
    }
  });

  it.each([
    ["2h:22m:37s", 8557],
    ["58m:6s", 3486],
    ["1h 30m", 5400],
    ["", null],
  ])("parseDuration(%s)", (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it.each([
    ["DD | DTS-HD MA", ["dts-hd", "ac3"]],
    ["DD+ | DD", ["eac3", "ac3"]],
    ["DD | TrueHD | DTS-HD MA | DTS", ["truehd", "dts-hd", "dts", "ac3"]],
    ["TrueHD Atmos 7.1", ["atmos", "truehd"]],
    ["AAC", ["aac"]],
    ["OPUS", ["opus"]],
    ["FLAC", ["flac"]],
    ["DDP5 1", ["eac3"]],
    ["EAC3", ["eac3"]],
    ["E-AC-3", ["eac3"]],
    ["AC3 5 1", ["ac3"]],
    ["AAC2 0", ["aac"]],
    ["DTS-X", ["dts-hd"]],
    ["DTS", ["dts"]],
    ["MP3", ["mp3"]],
    ["LPCM 2.0", ["pcm"]],
    ["HorribleSubs DDB group", []],
  ])("parseAudio(%s)", (text, expected) => {
    expect(parseAudio(text).sort()).toEqual([...expected].sort());
  });
});

describe("parseStream", () => {
  it("parses a 4K REMUX with multi-audio", () => {
    const s = parseStream(REMUX_4K)!;
    expect(s).toMatchObject({
      name: "🔥4K UHD",
      title: "Some Movie (1994)",
      resolution: "2160p",
      sizeBytes: 93947973227,
      bitrateMbps: 87.9,
      durationSec: 8552,
      source: "BluRay",
      remux: true,
      videoCodec: "hevc",
      hdr: ["HDR10"],
      container: "mkv",
      cached: true,
      service: "TB",
      addon: "Torrentio",
      indexer: "Rutor",
      bingeGroup: "aio.example.com|2160p|BluRay REMUX",
      filename: "Some Movie (1994) - UHD BD-Remux by Someone.mkv",
    });
    expect(s.audio.sort()).toEqual(["ac3", "dts-hd"]);
    expect(s.languages).toEqual(["RU", "UA", "GB"]);
  });

  it("parses a WEB-DL H.264/AAC MKV", () => {
    const s = parseStream(WEBDL_H264_AAC)!;
    expect(s).toMatchObject({
      resolution: "1080p",
      source: "WEB-DL",
      remux: false,
      videoCodec: "h264",
      audio: ["aac"],
      container: "mkv",
      bitrateMbps: 9.64,
      hdr: [],
    });
  });

  it("ignores the episode marker that shares the 🎞️ emoji", () => {
    const s = parseStream(HEVC_DDP_10BIT)!;
    expect(s.videoCodec).toBe("hevc");
    expect(s.bitDepth).toBe(10);
    expect(s.releaseGroup).toBe("IONICBOY");
    expect(s.indexer).toBe("StremThru|TorrentGalaxyClone");
    expect(s.sizeBytes).toBe(2576747154);
  });

  it("falls back to the filename when the description has no codec info", () => {
    const s = parseStream(
      mk({
        name: "💩 Unknown",
        lines: [
          "🎬 Show ",
          "📦 9.68 GB / 52.2 GB 📊 51.6 Mbps ",
          "⚡Ready (TB) 🔍Comet ",
        ],
        filename: "Show.S01E01.iNTERNAL.2160p.WEB.h265-NiXON.mkv",
      }),
    )!;
    expect(s.resolution).toBe("2160p");
    expect(s.source).toBe("WEB-DL");
    expect(s.videoCodec).toBe("hevc");
    expect(s.sizeBytes).toBe(9.68e9);
    expect(s.audio).toEqual([]);
  });

  it.each([
    ["Movie.2020.1080p.BluRay.x264-GRP.mkv", "h264"],
    ["Movie.2020.1080p.WEB.H.264-GRP.mkv", "h264"],
    ["Movie 2020 1080p AVC.mkv", "h264"],
    ["Movie.2020.2160p.x265.mkv", "hevc"],
    ["Movie.2020.2160p.H.265.mkv", "hevc"],
    ["Movie.2020.1080p.AV1.Opus.mkv", "av1"],
    ["Movie.2020.1080p.VP9.webm", "vp9"],
    ["Movie.2003.DVDRip.XviD.avi", "mpeg4"],
    ["Movie.1994.Remux.1080p.VC-1.mkv", "vc1"],
    ["Movie.mkv", null],
  ])("video codec from filename %s", (filename, codec) => {
    expect(parseStream(mk({ lines: [], filename }))!.videoCodec).toBe(codec);
  });

  it.each([
    ["🔥4K UHD", "x.mkv", "2160p"],
    ["✨ QHD", "x.mkv", "1440p"],
    ["🚀 FHD", "x.mkv", "1080p"],
    ["💿 HD", "x.mkv", "720p"],
    ["📼 SD", "x.mkv", "480p"],
    ["💩 Unknown", "Movie.720p.mkv", "720p"],
    ["💩 Unknown", "Cadena Perpetua BDR1080p.mkv", "1080p"],
    ["💩 Unknown", "Movie.4K.mkv", "2160p"],
    ["💩 Low Quality", "Movie.mkv", null],
  ])("resolution from name %s / %s", (name, filename, res) => {
    expect(parseStream(mk({ name, lines: [], filename }))!.resolution).toBe(
      res,
    );
  });

  it.each([
    ["📺 DV | HDR10 ", ["DV", "HDR10"]],
    ["📺 HDR10+ ", ["HDR10+"]],
    ["📺 10bit | HDR ", ["HDR"]],
    ["📺 SDR ", []],
  ])("HDR flags from %s", (line, hdr) => {
    expect(parseStream(mk({ lines: [line] }))!.hdr).toEqual(hdr);
  });

  it.each([
    ["x.mkv", "mkv"],
    ["x.MP4", "mp4"],
    ["x.webm", "webm"],
    ["x.m2ts", "m2ts"],
    ["x.iso", "iso"],
    ["x.url", "other:url"],
    ["no extension", null],
  ])("container from %s", (filename, container) => {
    expect(parseStream(mk({ lines: [], filename }))!.container).toBe(container);
  });

  it("marks uncached results", () => {
    expect(
      parseStream(mk({ lines: ["⏳ Download (RD) 🔍Comet"] }))!,
    ).toMatchObject({
      cached: false,
      service: "RD",
    });
    expect(
      parseStream(mk({ name: "[RD+] Torrentio 1080p", lines: [] }))!.cached,
    ).toBe(true);
    expect(parseStream(mk({ lines: [] }))!.cached).toBeNull();
  });

  it("computes the bitrate from size and duration when missing", () => {
    const s = parseStream(mk({ lines: ["🎞️ AVC ⏱️ 1h:0m:0s "], size: 4.5e9 }))!;
    expect(s.bitrateMbps).toBe(10);
  });

  it("detects multi-language and dubbed markers", () => {
    expect(parseStream(mk({ lines: ["🎧 DD 🗣️ 🌎"] }))!.languages).toEqual([
      "multi",
    ]);
    expect(parseStream(mk({ lines: ["🗣️ Dubbed"] }))!.languages).toEqual([
      "dubbed",
    ]);
  });

  it("drops torrent-only and non-http results", () => {
    expect(parseStream({ name: "x", infoHash: "abc" })).toBeNull();
    expect(
      parseStream(mk({ lines: [], url: "magnet:?xt=urn:btih:abc" })),
    ).toBeNull();
    expect(parseStream(mk({ lines: [], url: null }))).toBeNull();
  });

  it("survives junk input", () => {
    const s = parseStream({
      url: "https://x.example/y",
      name: 42,
      description: { evil: true },
      behaviorHints: "nope",
    })!;
    expect(s.name).toBe("");
    expect(s.videoCodec).toBeNull();
    expect(s.filename).toBeNull();
  });
});

const cls = (raw: RawStream) => classifyStream(parseStream(raw)!);

describe("classifyStream", () => {
  it("H.264 + AAC in MP4 plays directly", () => {
    expect(cls(MP4_H264_AAC)).toEqual({
      tier: "direct",
      reasons: ["Browser-friendly: H.264 + AAC"],
    });
  });

  it("H.264 + AAC in MKV is direct with an MKV note", () => {
    const c = cls(WEBDL_H264_AAC);
    expect(c.tier).toBe("direct");
    expect(c.reasons.join(" ")).toMatch(/MKV/);
  });

  it("AV1 + Opus and VP9 + Opus are direct", () => {
    expect(
      cls(mk({ lines: ["🎞️ AV1", "🎧 OPUS"], filename: "x.mkv" })).tier,
    ).toBe("direct");
    expect(
      cls(mk({ lines: ["🎞️ VP9", "🎧 OPUS"], filename: "x.webm" })).tier,
    ).toBe("direct");
  });

  it("multi-audio with one native track stays direct but says so", () => {
    const c = cls(mk({ lines: ["🎞️ AVC", "🎧 DD | AAC"], filename: "x.mkv" }));
    expect(c.tier).toBe("direct");
    expect(c.reasons.join(" ")).toMatch(/Multiple audio tracks \(AC3, AAC\)/);
  });

  it("H.264 with only AC3/EAC3 audio is a light conversion", () => {
    const c = cls(H264_DDP);
    expect(c.tier).toBe("convert-light");
    expect(c.reasons[0]).toBe("EAC3 audio must be converted");
  });

  it("FLAC-only audio is a light conversion", () => {
    expect(
      cls(mk({ lines: ["🎞️ AVC", "🎧 FLAC"], filename: "x.mkv" })).tier,
    ).toBe("convert-light");
  });

  it("unknown codecs are a light conversion (the client probes)", () => {
    const c = cls(
      mk({ name: "💩 Unknown", lines: ["📦 3.57 GB"], filename: "x.mkv" }),
    );
    expect(c.tier).toBe("convert-light");
    expect(c.reasons).toContain("Video codec unknown, will be probed");
    expect(c.reasons).toContain("Audio codec unknown, will be probed");
  });

  it("MPEG-TS needs a remux", () => {
    expect(
      cls(mk({ lines: ["🎞️ AVC", "🎧 AAC"], filename: "x.ts" })).tier,
    ).toBe("convert-light");
  });

  it("HEVC with decodable audio is a heavy conversion", () => {
    const c = cls(HEVC_DDP_10BIT);
    expect(c.tier).toBe("convert-heavy");
    expect(c.reasons[0]).toMatch(/HEVC/);
    expect(c.reasons).toContain("EAC3 audio must be converted");
  });

  it("HEVC + AAC is still heavy", () => {
    expect(
      cls(mk({ lines: ["🎞️ HEVC", "🎧 AAC"], filename: "x.mkv" })).tier,
    ).toBe("convert-heavy");
  });

  it("10-bit H.264 (Hi10P anime) is a heavy conversion", () => {
    const c = cls(
      mk({ lines: ["📺 10bit 🎞️ AVC", "🎧 AAC"], filename: "x.mkv" }),
    );
    expect(c.tier).toBe("convert-heavy");
    expect(c.reasons[0]).toMatch(/10-bit H\.264/);
  });

  it("DTS-only audio is unlikely", () => {
    const c = cls(DTS_ONLY);
    expect(c.tier).toBe("unlikely");
    expect(c.reasons[0]).toBe("No browser-decodable audio (DTS)");
  });

  it("TrueHD/DTS-HD without a lossy track is unlikely", () => {
    expect(cls(mk({ lines: ["🎞️ AVC", "🎧 TrueHD | DTS-HD MA"] })).tier).toBe(
      "unlikely",
    );
  });

  it("DTS-HD alongside AC3 is convertible", () => {
    expect(
      cls(mk({ lines: ["🎞️ AVC", "🎧 DTS-HD MA | DD"], filename: "x.mkv" }))
        .tier,
    ).toBe("convert-light");
  });

  it("REMUX, huge files and high bitrates are unlikely", () => {
    const remux = cls(REMUX_4K);
    expect(remux.tier).toBe("unlikely");
    expect(remux.reasons).toEqual(
      expect.arrayContaining([
        "REMUX (very high bitrate)",
        "Bitrate too high to stream (87.9 Mbps)",
        "Very large file (93.9 GB)",
      ]),
    );
    expect(
      cls(mk({ lines: ["🎞️ AVC", "🎧 AAC", "📊 45 Mbps"], filename: "x.mp4" }))
        .tier,
    ).toBe("unlikely");
    expect(
      cls(mk({ lines: ["🎞️ AVC", "🎧 AAC"], filename: "x.mp4", size: 41e9 }))
        .tier,
    ).toBe("unlikely");
    // Just under the limits
    expect(
      cls(
        mk({
          lines: ["🎞️ AVC", "🎧 AAC", "📊 39 Mbps"],
          filename: "x.mp4",
          size: 39e9,
        }),
      ).tier,
    ).toBe("direct");
  });

  it.each([["x.avi"], ["x.iso"], ["x.m2ts"], ["x.url"]])(
    "unsupported container %s is unlikely",
    (filename) => {
      expect(cls(mk({ lines: ["🎞️ AVC", "🎧 AAC"], filename })).tier).toBe(
        "unlikely",
      );
    },
  );

  it("XviD/VC-1 video is unlikely", () => {
    expect(
      cls(mk({ lines: ["🎞️ XviD", "🎧 MP3"], filename: "x.mkv" })).tier,
    ).toBe("unlikely");
    expect(
      cls(mk({ lines: ["🎞️ VC-1", "🎧 DD"], filename: "x.mkv" })).tier,
    ).toBe("unlikely");
  });

  it("notes HDR / Dolby Vision", () => {
    const dv = cls(
      mk({ lines: ["📺 DV 🎞️ AV1", "🎧 AAC"], filename: "x.mp4" }),
    );
    expect(dv.reasons).toContain("Dolby Vision only: colors may look wrong");
    const hdr = cls(
      mk({ lines: ["📺 HDR10 🎞️ AV1", "🎧 AAC"], filename: "x.mp4" }),
    );
    expect(hdr.reasons.join(" ")).toMatch(/HDR10: colors may look washed out/);
  });
});

describe("scoreStream", () => {
  const base = parseStream(MP4_H264_AAC)!;
  const with_ = (p: Partial<ParsedStream>) => scoreStream({ ...base, ...p });

  it("prefers 1080p over 4K and 720p", () => {
    expect(with_({ resolution: "1080p" })).toBeGreaterThan(
      with_({ resolution: "2160p" }),
    );
    expect(with_({ resolution: "1080p" })).toBeGreaterThan(
      with_({ resolution: "720p" }),
    );
    expect(with_({ resolution: "720p" })).toBeGreaterThan(
      with_({ resolution: "2160p" }),
    );
  });

  it("prefers cached results", () => {
    expect(with_({ cached: true })).toBeGreaterThan(with_({ cached: null }));
    expect(with_({ cached: null })).toBeGreaterThan(with_({ cached: false }));
  });

  it("prefers sane bitrates", () => {
    expect(with_({ bitrateMbps: 8 })).toBeGreaterThan(
      with_({ bitrateMbps: 35 }),
    );
    expect(with_({ bitrateMbps: 8 })).toBeGreaterThan(
      with_({ bitrateMbps: 0.5 }),
    );
  });

  it("boosts the requested bingeGroup", () => {
    const s = { ...base, bingeGroup: "g1" };
    expect(scoreStream(s, { bingeGroup: "g1" })).toBe(scoreStream(s) + 200);
    expect(scoreStream(s, { bingeGroup: "g2" })).toBe(scoreStream(s));
  });
});

describe("rankStreams", () => {
  const all = [
    REMUX_4K,
    HEVC_DDP_10BIT,
    DTS_ONLY,
    H264_DDP,
    WEBDL_H264_AAC,
    MP4_H264_AAC,
  ];

  it("sorts by tier and counts each tier", () => {
    const r = rankStreams([...all, { infoHash: "torrent-only" }, null, "junk"]);
    expect(r.total).toBe(6);
    expect(r.counts).toEqual({
      direct: 2,
      "convert-light": 1,
      "convert-heavy": 1,
      unlikely: 2,
    });
    expect(r.streams.map((s) => s.tier)).toEqual([
      "direct",
      "direct",
      "convert-light",
      "convert-heavy",
      "unlikely",
      "unlikely",
    ]);
    // Within "unlikely": the 1080p DTS file beats the 4K REMUX
    expect(r.streams[4].filename).toMatch(/Cadena/);
  });

  it("keeps the original order for ties", () => {
    const a = mk({
      lines: ["🎞️ AVC", "🎧 AAC", "⚡Ready (TB)"],
      filename: "a.mp4",
    });
    const b = mk({
      lines: ["🎞️ AVC", "🎧 AAC", "⚡Ready (TB)"],
      filename: "b.mp4",
    });
    expect(rankStreams([a, b]).streams.map((s) => s.filename)).toEqual([
      "a.mp4",
      "b.mp4",
    ]);
    expect(rankStreams([b, a]).streams.map((s) => s.filename)).toEqual([
      "b.mp4",
      "a.mp4",
    ]);
  });

  it("bingeGroup boosts within a tier only", () => {
    const r = rankStreams(all, {
      bingeGroup: "aio.example.com|1080p|BluRay|IONICBOY",
    });
    expect(r.streams[0].tier).toBe("direct");
    const heavy = rankStreams(
      [
        HEVC_DDP_10BIT,
        mk({
          lines: ["🎞️ HEVC", "🎧 AAC", "⚡Ready (TB)", "📊 8 Mbps"],
          filename: "z.mkv",
        }),
      ],
      { bingeGroup: "aio.example.com|1080p|BluRay|IONICBOY" },
    );
    expect(heavy.streams[0].releaseGroup).toBe("IONICBOY");
  });

  it("caps the list but keeps full counts", () => {
    const many = Array.from({ length: 150 }, () => MP4_H264_AAC);
    const r = rankStreams(many);
    expect(r.streams).toHaveLength(60);
    expect(r.total).toBe(150);
    expect(r.counts.direct).toBe(150);
    expect(rankStreams(many, { limit: 5 }).streams).toHaveLength(5);
  });

  it("returns a trimmed DTO without the description blob", () => {
    const [s] = rankStreams([WEBDL_H264_AAC]).streams;
    expect(s).not.toHaveProperty("description");
    expect(s).not.toHaveProperty("behaviorHints");
    expect(s.url).toMatch(/^https:\/\/aio\.example\.com\//);
    expect(s.filename).toBe("Some.Movie.1994.WEB-DL.1080p-Dual-Lat.mkv");
    expect(typeof s.score).toBe("number");
    expect(s.reasons.length).toBeGreaterThan(0);
  });
});
