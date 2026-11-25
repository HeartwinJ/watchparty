// Synthetic test fixtures for the picker (fake titles and example.com URLs only).
import type {
  Meta,
  StreamDTO,
  StreamList,
  TitleRef,
} from "../../../api/addons";

export const stream = (over: Partial<StreamDTO> = {}): StreamDTO => ({
  url: "https://aio.example.com/api/v1/debrid/playback/fake-1/file.mkv",
  name: "AIO 1080p",
  title: null,
  filename: "Example.Movie.2021.1080p.WEB-DL.AAC2.0.H.264-GRP.mp4",
  resolution: "1080p",
  sizeBytes: 2.1e9,
  bitrateMbps: 5,
  durationSec: 7200,
  source: "WEB-DL",
  remux: false,
  videoCodec: "h264",
  bitDepth: 8,
  hdr: [],
  audio: ["aac"],
  languages: [],
  container: "mp4",
  cached: true,
  service: "TB",
  addon: "Example",
  indexer: null,
  releaseGroup: "GRP",
  bingeGroup: "example|1080p|web-dl",
  tier: "direct",
  reasons: [],
  score: 100,
  ...over,
});

export const streamList: StreamList = {
  streams: [
    stream({ filename: "Direct.One.mp4" }),
    stream({
      url: "https://aio.example.com/api/v1/debrid/playback/fake-2/file.mkv",
      filename: "Light.Two.mkv",
      container: "mkv",
      audio: ["eac3"],
      tier: "convert-light",
      cached: false,
    }),
    stream({
      url: "https://aio.example.com/api/v1/debrid/playback/fake-3/file.mkv",
      filename: "Heavy.Three.2160p.HEVC.mkv",
      resolution: "2160p",
      videoCodec: "hevc",
      bitDepth: 10,
      hdr: ["HDR10"],
      container: "mkv",
      tier: "convert-heavy",
    }),
    stream({
      url: "https://aio.example.com/api/v1/debrid/playback/fake-4/file.mkv",
      filename: "Remux.Four.2160p.REMUX.mkv",
      resolution: "2160p",
      sizeBytes: 80e9,
      videoCodec: "hevc",
      audio: ["truehd", "atmos"],
      remux: true,
      container: "mkv",
      tier: "unlikely",
      reasons: ["REMUX", "TrueHD audio only"],
    }),
  ],
  counts: { direct: 1, "convert-light": 1, "convert-heavy": 1, unlikely: 1 },
  total: 4,
};

export const movie: TitleRef = {
  id: "tt0000001",
  type: "movie",
  kind: "movie",
  name: "Example Movie",
  year: 2021,
  poster: "https://images.example.com/movie.jpg",
};

export const show: TitleRef = {
  id: "tt0000002",
  type: "series",
  kind: "series",
  name: "Example Show",
  year: 2019,
  poster: "https://images.example.com/show.jpg",
};

export const showMeta: Meta = {
  id: "tt0000002",
  type: "series",
  name: "Example Show",
  year: 2019,
  releaseInfo: "2019–2022",
  poster: null,
  background: null,
  logo: null,
  description: "A synthetic show.",
  runtime: "50 min",
  genres: ["Drama"],
  imdbId: "tt0000002",
  seasons: [
    {
      season: 1,
      episodes: [
        {
          id: "tt0000002:1:1",
          season: 1,
          episode: 1,
          title: "Pilot",
          released: "2019-01-01T00:00:00.000Z",
          thumbnail: null,
        },
        {
          id: "tt0000002:1:2",
          season: 1,
          episode: 2,
          title: "Second",
          released: "2019-01-08T00:00:00.000Z",
          thumbnail: null,
        },
      ],
    },
    {
      season: 2,
      episodes: [
        {
          id: "tt0000002:2:1",
          season: 2,
          episode: 1,
          title: "Return",
          released: "2020-01-01T00:00:00.000Z",
          thumbnail: null,
        },
      ],
    },
  ],
};
