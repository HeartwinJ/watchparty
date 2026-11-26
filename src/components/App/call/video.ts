// Call video (camera): capture constraints, camera errors, and the per-sender caps that keep a P2P mesh light.
// A watch party first: the movie and the voices matter more than faces, so video is small, capped by how many
// people each sender uploads to, and gives way to audio on a congested link.
import { classifyMicError, type MicErrorKind } from "./logic";

/** What each sender's video may use, per receiving peer */
export interface VideoCaps {
  /** Bits per second, per peer connection */
  maxBitrate: number;
  /** Frame height to send (the capture is scaled down to this) */
  maxHeight: number;
  maxFramerate: number;
}

/**
 * Caps by how many people we send our camera to. In a full mesh every sender uploads one copy per peer, so the total
 * upload is roughly `peers × maxBitrate`: 1.2 Mbps for one peer, 1.4 for two, 1.2–1.6 for three or four, 1–1.4 Mbps
 * for five to seven (the call allows 8). Home uplinks of a few Mbps keep headroom for voice and everything else.
 */
export function videoCapsFor(peerCount: number): VideoCaps {
  if (peerCount <= 1) {
    return { maxBitrate: 1_200_000, maxHeight: 720, maxFramerate: 30 };
  }
  if (peerCount === 2) {
    return { maxBitrate: 700_000, maxHeight: 540, maxFramerate: 30 };
  }
  if (peerCount <= 4) {
    return { maxBitrate: 400_000, maxHeight: 360, maxFramerate: 24 };
  }
  return { maxBitrate: 200_000, maxHeight: 240, maxFramerate: 15 };
}

/**
 * Whether we send our camera to a peer: only while they show the video tiles (`wantsVideo`). A peer that doesn't say
 * (an older client) gets it, as before.
 */
export const sendsVideoTo = (peer: { wantsVideo?: boolean }) =>
  peer.wantsVideo !== false;

/** The caps for our video senders, counting only the peers that actually receive our camera (sendsVideoTo) */
export function videoCapsForPeers(
  peers: Iterable<{ wantsVideo?: boolean }>,
): VideoCaps {
  let receivers = 0;
  for (const p of peers) {
    if (sendsVideoTo(p)) {
      receivers++;
    }
  }
  return videoCapsFor(receivers);
}

/** `scaleResolutionDownBy` that brings a capture of `trackHeight` down to `maxHeight` (never up) */
export function scaleDownBy(
  trackHeight: number | undefined,
  maxHeight: number,
): number {
  const h = trackHeight && trackHeight > 0 ? trackHeight : CAPTURE.height;
  return Math.max(1, Math.round((h / maxHeight) * 100) / 100);
}

/** What we ask the camera for: 720p at most; senders scale it down per call size (videoCapsFor) */
export const CAPTURE = { width: 1280, height: 720, frameRate: 30 };

export function cameraConstraints(
  deviceId?: string | null,
): MediaTrackConstraints {
  return {
    width: { ideal: CAPTURE.width },
    height: { ideal: CAPTURE.height },
    frameRate: { ideal: CAPTURE.frameRate, max: CAPTURE.frameRate },
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: "user" } }),
  };
}

export type CameraErrorKind = MicErrorKind;

/** Same getUserMedia failures as the mic */
export const classifyCameraError: (err: unknown) => CameraErrorKind =
  classifyMicError;

export const CAMERA_ERROR_TEXT: Record<
  CameraErrorKind,
  { title: string; hint: string }
> = {
  blocked: {
    title: "Camera access is blocked",
    hint: "Allow the camera for this site in your browser's address bar or site settings, then try again.",
  },
  "in-use": {
    title: "Your camera is busy",
    hint: "Another app or tab may be using it. Close it (or pick another camera) and try again.",
  },
  "no-device": {
    title: "No camera found",
    hint: "Plug in a camera and try again. You can still talk without one.",
  },
  unsupported: {
    title: "Video isn't available here",
    hint: "This browser can't use the camera on this page. Video needs HTTPS and a recent browser.",
  },
  unknown: {
    title: "Couldn't start the camera",
    hint: "Try again, or pick another camera.",
  },
};

export type CameraResult =
  { ok: true; stream: MediaStream } | { ok: false; error: CameraErrorKind };

/** Opens the camera. A remembered device that's gone falls back to the default (front) camera. */
export async function openCamera(
  deviceId?: string | null,
): Promise<CameraResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: "unsupported" };
  }
  const attempt = async (id?: string | null): Promise<CameraResult> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: cameraConstraints(id),
    });
    const track = stream.getVideoTracks()[0];
    if (track && "contentHint" in track) {
      // Faces move: keep the frame rate, drop resolution first
      track.contentHint = "motion";
    }
    return { ok: true, stream };
  };
  try {
    return await attempt(deviceId);
  } catch (e) {
    const kind = classifyCameraError(e);
    if (deviceId && kind === "no-device") {
      try {
        return await attempt(null);
      } catch (e2) {
        return { ok: false, error: classifyCameraError(e2) };
      }
    }
    return { ok: false, error: kind };
  }
}

/** The cameras (labels only appear once camera permission was granted) */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices?.enumerateDevices();
    return (all ?? []).filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
}
