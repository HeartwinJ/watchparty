/**
 * Whether a Matroska/WebM file packs its audio with lacing (several frames in one block, one timestamp per block).
 *
 * Firefox plays laced audio fine on its normal path, but once the element is routed into Web Audio (Volume boost /
 * Night mode, see components/App/audioBoost.ts) it places each frame by its timestamp and leaves gaps between the
 * frames of a lace: the audio stutters several times a second. useConvert re-packs such files into fragmented MP4
 * (a copy, no re-encoding) while the boost is on in Firefox.
 *
 * The scan reads the file's track list and the first audio blocks with a few range requests, and answers false
 * whenever it isn't sure (unknown layout, too far into the file, a read error).
 */

/** Reads up to `length` bytes at `offset` (fewer at the end of the file) */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cluster: 0x1f43b675,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
};
/** Top-level elements that end a Cluster of unknown size */
const TOP_LEVEL = new Set([
  ID.Cluster,
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x1941a469, // Attachments
  0x1043a770, // Chapters
  0x114d9b74, // SeekHead
  0x1549a966, // Info
  ID.Tracks,
]);
const AUDIO_TRACK = 2;
const CHUNK = 64 * 1024;
/** Give up after this many reads, clusters or audio blocks (all unlaced so far = not laced) */
const MAX_READS = 16;
const MAX_CLUSTERS = 4;
const AUDIO_BLOCKS = 8;
const MAX_TRACKS_BYTES = 1024 * 1024;

interface Vint {
  value: number;
  length: number;
}

/** An EBML variable-length integer; ids keep their marker bit, sizes don't (-1 = unknown size) */
function readVint(buf: Uint8Array, pos: number, keepMarker: boolean) {
  const first = buf[pos];
  if (first === undefined || first === 0) {
    return null;
  }
  const length = Math.clz32(first) - 23;
  if (length > 8 || pos + length > buf.length) {
    return null;
  }
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    allOnes &&= buf[pos + i] === 0xff;
  }
  return {
    value: !keepMarker && allOnes ? -1 : value,
    length,
  } satisfies Vint;
}

interface Header {
  id: number;
  /** Bytes of data, -1 = unknown */
  size: number;
  /** Where the data starts */
  data: number;
}

function parseHeader(buf: Uint8Array, pos: number, at: number): Header | null {
  const id = readVint(buf, pos, true);
  if (!id || id.length > 4) {
    return null;
  }
  const size = readVint(buf, pos + id.length, false);
  if (!size) {
    return null;
  }
  return { id: id.value, size: size.value, data: at + id.length + size.length };
}

/** The numbers of the audio tracks in a Tracks element's data */
export function audioTrackNumbers(buf: Uint8Array): Set<number> {
  const numbers = new Set<number>();
  const uint = (start: number, end: number) => {
    let v = 0;
    for (let i = start; i < end; i++) {
      v = v * 256 + buf[i];
    }
    return v;
  };
  let pos = 0;
  while (pos < buf.length) {
    const entry = parseHeader(buf, pos, pos);
    if (!entry || entry.size < 0) {
      break;
    }
    const end = Math.min(entry.data + entry.size, buf.length);
    if (entry.id === ID.TrackEntry) {
      let number = 0;
      let type = 0;
      let p = entry.data;
      while (p < end) {
        const child = parseHeader(buf, p, p);
        if (!child || child.size < 0) {
          break;
        }
        const childEnd = Math.min(child.data + child.size, end);
        if (child.id === ID.TrackNumber) {
          number = uint(child.data, childEnd);
        } else if (child.id === ID.TrackType) {
          type = uint(child.data, childEnd);
        }
        p = childEnd;
      }
      if (type === AUDIO_TRACK && number) {
        numbers.add(number);
      }
    }
    pos = end;
  }
  return numbers;
}

/** A (Simple)Block's track number and lacing (0 = none), from the start of its data */
export function blockLacing(buf: Uint8Array) {
  const track = readVint(buf, 0, false);
  if (!track || buf.length < track.length + 3) {
    return null;
  }
  const flags = buf[track.length + 2];
  return { track: track.value, lacing: (flags >> 1) & 3 };
}

export async function hasLacedAudio(read: ReadRange): Promise<boolean> {
  let reads = 0;
  let window: Uint8Array = new Uint8Array(0);
  let windowStart = 0;
  /** `length` bytes at `offset`, or fewer at the end of the file */
  const bytes = async (offset: number, length: number) => {
    if (offset < windowStart || offset + length > windowStart + window.length) {
      if (++reads > MAX_READS) {
        throw new Error("too many reads");
      }
      window = await read(offset, Math.max(length, CHUNK));
      windowStart = offset;
    }
    return window.subarray(offset - windowStart, offset - windowStart + length);
  };
  const header = async (offset: number) =>
    parseHeader(await bytes(offset, 12), 0, offset);

  try {
    const ebml = await header(0);
    if (!ebml || ebml.id !== ID.EBML || ebml.size < 0) {
      return false;
    }
    const segment = await header(ebml.data + ebml.size);
    if (!segment || segment.id !== ID.Segment) {
      return false;
    }
    const segmentEnd =
      segment.size < 0 ? Infinity : segment.data + segment.size;
    let audio: Set<number> | null = null;
    let clusters = 0;
    let audioBlocks = 0;

    /** Checks one block; true/false = answer found, null = keep going */
    const checkBlock = async (data: number) => {
      const block = blockLacing(await bytes(data, 12));
      if (!block || !audio!.has(block.track)) {
        return null;
      }
      if (block.lacing !== 0) {
        return true;
      }
      return ++audioBlocks >= AUDIO_BLOCKS ? false : null;
    };

    let pos = segment.data;
    while (pos < segmentEnd) {
      const el = await header(pos);
      if (!el) {
        return false;
      }
      if (el.id === ID.Tracks) {
        if (el.size < 0 || el.size > MAX_TRACKS_BYTES) {
          return false;
        }
        audio = audioTrackNumbers(await bytes(el.data, el.size));
        if (audio.size === 0) {
          return false;
        }
      } else if (el.id === ID.Cluster) {
        if (!audio || ++clusters > MAX_CLUSTERS) {
          return false;
        }
        const end = el.size < 0 ? Infinity : el.data + el.size;
        let p = el.data;
        while (p < end) {
          const child = await header(p);
          if (!child) {
            return false;
          }
          if (el.size < 0 && TOP_LEVEL.has(child.id)) {
            // The next top-level element ends a cluster of unknown size
            break;
          }
          if (child.size < 0) {
            return false;
          }
          let answer: boolean | null = null;
          if (child.id === ID.SimpleBlock) {
            answer = await checkBlock(child.data);
          } else if (child.id === ID.BlockGroup) {
            let g = child.data;
            const groupEnd = child.data + child.size;
            while (g < groupEnd && answer === null) {
              const inner = await header(g);
              if (!inner || inner.size < 0) {
                return false;
              }
              if (inner.id === ID.Block) {
                answer = await checkBlock(inner.data);
              }
              g = inner.data + inner.size;
            }
          }
          if (answer !== null) {
            return answer;
          }
          p = child.data + child.size;
        }
        pos = p;
        continue;
      } else if (el.size < 0) {
        return false;
      }
      pos = el.data + el.size;
    }
    return false;
  } catch {
    return false;
  }
}

/** Range reads of a URL (the server must allow CORS and ranges); throws when it ignores the range */
export const urlRangeReader =
  (url: string, signal?: AbortSignal): ReadRange =>
  async (offset, length) => {
    const res = await fetch(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      signal,
    });
    if (res.status !== 206) {
      void res.body?.cancel();
      throw new Error(`range not supported (${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
