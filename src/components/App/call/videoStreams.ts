import { useSyncExternalStore } from "react";
// The call's video streams on this device: our camera preview and each member's incoming video track, with whether
// frames are arriving. Mutable (MediaStreams don't belong in the room store); the tiles and the call panel read it
// through `useCallVideo` (useSyncExternalStore), which re-renders only when something here changes.

export interface RemoteVideo {
  stream: MediaStream;
  /** Frames are arriving (the track isn't muted). False right after it arrives and while their camera is off. */
  live: boolean;
}

export interface VideoSnapshot {
  /** Our camera (pre-join preview or in the call), or null when it's off */
  local: MediaStream | null;
  remote: Record<string, RemoteVideo>;
}

interface RemoteEntry {
  track: MediaStreamTrack;
  stream: MediaStream;
  off: () => void;
}

export class CallVideo {
  private listeners = new Set<() => void>();
  private local: MediaStream | null = null;
  private remote = new Map<string, RemoteEntry>();
  private snapshot: VideoSnapshot = { local: null, remote: {} };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snapshot;

  private changed() {
    const remote: Record<string, RemoteVideo> = {};
    for (const [id, e] of this.remote) {
      remote[id] = {
        stream: e.stream,
        live: e.track.readyState === "live" && !e.track.muted,
      };
    }
    this.snapshot = { local: this.local, remote };
    this.listeners.forEach((fn) => fn());
  }

  setLocal(track: MediaStreamTrack | null) {
    if ((this.local?.getVideoTracks()[0] ?? null) === track) {
      return;
    }
    this.local = track ? new MediaStream([track]) : null;
    this.changed();
  }

  /** A member's incoming video track (a new one replaces the old) */
  addRemote(id: string, track: MediaStreamTrack) {
    if (track.kind !== "video") {
      return;
    }
    this.drop(id);
    const update = () => this.changed();
    track.addEventListener?.("mute", update);
    track.addEventListener?.("unmute", update);
    track.addEventListener?.("ended", update);
    this.remote.set(id, {
      track,
      stream: new MediaStream([track]),
      off: () => {
        track.removeEventListener?.("mute", update);
        track.removeEventListener?.("unmute", update);
        track.removeEventListener?.("ended", update);
      },
    });
    this.changed();
  }

  private drop(id: string) {
    const e = this.remote.get(id);
    if (e) {
      e.off();
      this.remote.delete(id);
    }
    return Boolean(e);
  }

  /** Their peer connection closed */
  remove(id: string) {
    if (this.drop(id)) {
      this.changed();
    }
  }

  /** Left the call */
  clear() {
    for (const id of [...this.remote.keys()]) {
      this.drop(id);
    }
    this.local = null;
    this.changed();
  }
}

/** Re-renders when the call's video streams change */
export function useCallVideo(video: CallVideo): VideoSnapshot {
  return useSyncExternalStore(video.subscribe, video.getSnapshot);
}
