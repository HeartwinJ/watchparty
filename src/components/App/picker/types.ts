import type { Episode, StreamDTO, TitleRef } from "../../../api/addons";
import type { StreamContext } from "./pickerLogic";

/** What the palette can do in the room. SourcePicker builds it from useRoom(); tests pass fakes. */
export interface PickerActions {
  /** Hosts a URL for the room (YouTube, HLS, DASH, direct file) */
  playUrl: (url: string, opts?: { name?: string; img?: string }) => void;
  queueUrl: (url: string, opts?: { name?: string; img?: string }) => void;
  /** Hosts an AIOStreams stream with a readable name, and sends its metadata to the room */
  playStream: (stream: StreamDTO, ctx: StreamContext) => void;
  queueStream: (stream: StreamDTO, ctx: StreamContext) => void;
  /** Open the existing share modals */
  shareScreen: () => void;
  shareFile: () => void;
  stopSharing: () => void;
  /** Whether anyone in the room is sharing */
  sharing: "none" | "me" | "other";
  /** The room's current AIOStreams video, to mark "playing now" and prefer the same release */
  currentMeta: VideoMeta | null;
}

/** One level of the drill-down. The root level shows the empty state, a pasted link or search results. */
export type Frame =
  | { kind: "root" }
  | { kind: "title"; title: TitleRef; imdbId?: string | null }
  | {
      kind: "episode";
      title: TitleRef;
      episode: Episode;
      imdbId?: string | null;
    };

export type SearchFilter = "all" | "titles" | "youtube";
