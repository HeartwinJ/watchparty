import { useMemo, useRef } from "react";
import { ClientTranscoder, probeMedia } from "../../../utils/clientTranscode";
import {
  AUTO_CONVERT_KEY,
  type PlaybackState,
  type RoomState,
  type RoomStore,
} from "../roomState";
import { decidePlayback } from "../logic/playback";
import type { PlayerApi } from "./usePlayer";

/** What the player/top bar can show while this device converts the room's video */
export interface ConvertStatus {
  /** e.g. "Converting · 34% buffered" */
  label: string;
  /** 0–1, how much of the file has been converted */
  progress: number;
  /** The video is re-encoded (heavy on weak devices), not just remuxed */
  heavy: boolean;
  /** Why conversion is needed, e.g. "AC-3 audio isn't supported in this browser" */
  reason: string;
}

/** Pure: the conversion status line for the current state, or null when not converting */
export function getConvertStatus(
  state: Pick<RoomState, "playback" | "convertProgress">,
): ConvertStatus | null {
  const { playback, convertProgress } = state;
  if (playback?.mode !== "convert" || convertProgress === undefined) {
    return null;
  }
  const pct = Math.round(Math.min(Math.max(convertProgress, 0), 1) * 100);
  return {
    label: `Converting · ${pct}% buffered`,
    progress: convertProgress,
    heavy: playback.heavy,
    reason: playback.reason,
  };
}

/**
 * In-browser conversion of media the browser can't play natively (clientTranscode.ts: WebCodecs + mediabunny, both
 * loaded lazily). playUrl() probes every direct link this device is asked to play and picks direct play, conversion
 * or failure (logic/playback.ts), gated by the per-device "Auto-convert when needed" setting. Also used for
 * converted file shares (see useShare).
 */
export function useConvert(opts: {
  store: RoomStore;
  player: PlayerApi;
  showError: (message: string) => void;
  /** Tells the room this device can't play the video (CMD:playbackIssue) */
  reportIssue?: (reason: string) => void;
  /** Shown when conversion kicks in, e.g. a toast */
  onConvertStart?: (reason: string, heavy: boolean) => void;
}) {
  const { store, player, showError } = opts;
  const transcoderRef = useRef<ClientTranscoder | undefined>(undefined);
  // Invalidates an in-flight probe/playback when the media changes
  const playGenRef = useRef(0);
  const callbacksRef = useRef(opts);
  callbacksRef.current = opts;

  return useMemo(() => {
    const setPlayback = (playback: PlaybackState | undefined) =>
      store.set({ playback });

    // Stops client-side conversion (if running) and releases its resources
    const stopConvert = () => {
      playGenRef.current += 1;
      transcoderRef.current?.stop();
      transcoderRef.current = undefined;
      const { convertProgress, audioTracks, playback } = store.get();
      if (
        convertProgress !== undefined ||
        audioTracks !== undefined ||
        playback !== undefined
      ) {
        store.set({
          convertProgress: undefined,
          audioTracks: undefined,
          audioTrackId: undefined,
          playback: undefined,
        });
      }
    };

    const isCurrent = (transcoder: ClientTranscoder) =>
      transcoderRef.current === transcoder;

    const createTranscoder = (
      source: File | string,
      video: HTMLMediaElement,
      startTime: number,
      onError: (err: Error) => void,
      audioTrackId?: number,
    ) => {
      const transcoder = new ClientTranscoder({
        source,
        video,
        startTime,
        audioTrackId,
        onProgress: (fraction) => {
          if (isCurrent(transcoder)) {
            store.set({ convertProgress: fraction });
          }
        },
        onAudioTracks: (audioTracks, audioTrackId) => {
          if (isCurrent(transcoder)) {
            store.set({ audioTracks, audioTrackId });
          }
        },
        onError,
      });
      transcoderRef.current = transcoder;
      store.set({ convertProgress: 0 });
      return transcoder;
    };

    const report = (reason: string) => {
      console.warn("[playback] can't play:", reason);
      callbacksRef.current.reportIssue?.(reason);
    };

    /**
     * Plays the URL directly. If the browser then fails to decode it, report it to the room (or, when allowed,
     * fall back to converting it).
     */
    const playDirect = async (
      src: string,
      time: number,
      gen: number,
      fallback?: () => void,
    ) => {
      const video = player.html().getVideoEl();
      const onError = () => {
        const err = video.error;
        if (playGenRef.current !== gen || !err) {
          return;
        }
        // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED
        if (err.code !== 3 && err.code !== 4) {
          return;
        }
        if (fallback) {
          fallback();
          return;
        }
        const reason =
          err.code === 4
            ? "This browser can't play this video format"
            : "This browser couldn't decode the video";
        setPlayback({ mode: "fail", reason });
        report(reason);
      };
      video.addEventListener("error", onError, { once: true });
      await player.current().setSrcAndTime(src, time);
    };

    // Plays a media URL in this browser after converting it. Only affects this client: the room's media URL is
    // unchanged.
    const convertAndPlay = async (
      src: string,
      time: number,
      audioTrackId?: number,
    ) => {
      const gen = playGenRef.current;
      const video = player.html().getVideoEl();
      const transcoder = createTranscoder(
        src,
        video,
        time,
        (err) => {
          // Conversion failed while playing. Carry on without it.
          showError(
            `Conversion failed: ${err.message}. Playing without conversion.`,
          );
          stopConvert();
          const fresh = playGenRef.current;
          setPlayback({ mode: "direct" });
          playDirect(src, video.currentTime, fresh);
        },
        audioTrackId,
      );
      try {
        await transcoder.start();
      } catch (err) {
        console.error(err);
        if (isCurrent(transcoder) && playGenRef.current === gen) {
          // Typically a CORS restriction or a link that isn't a media file
          stopConvert();
          const reason =
            err instanceof Error ? err.message : "Unable to convert this video";
          showError(`${reason}. Playing without conversion.`);
          const fresh = playGenRef.current;
          setPlayback({ mode: "direct" });
          await playDirect(src, time, fresh);
        }
      }
    };

    /**
     * Entry point for direct links (REC:host): with auto-convert on, probe the real tracks first and decide how to
     * play them; with it off, play directly and only report failures.
     */
    const playUrl = async (src: string, time: number) => {
      const gen = ++playGenRef.current;
      if (!store.get().convertEnabled) {
        setPlayback({ mode: "direct" });
        await playDirect(src, time, gen);
        return;
      }
      setPlayback({ mode: "probing" });
      let decision;
      let canConvert = false;
      try {
        const probe = await probeMedia(src);
        canConvert = probe.transcodeSupported;
        decision = decidePlayback(probe, { autoConvert: true });
      } catch (e) {
        // Not readable from here (no CORS, not a media file, timeout): let the <video> element try
        console.warn(
          "[playback] probe failed, playing directly:",
          e instanceof Error ? e.message : e,
        );
        if (playGenRef.current === gen) {
          setPlayback({ mode: "direct" });
          await playDirect(src, time, gen);
        }
        return;
      }
      if (playGenRef.current !== gen) {
        return;
      }
      // Never log the URL: AIOStreams playback links carry a debrid credential
      console.log(
        "[playback] decision:",
        decision.mode,
        decision.mode === "direct" ? (decision.note ?? "") : decision.reason,
      );
      if (decision.mode === "direct") {
        setPlayback({ mode: "direct", note: decision.note });
        // canPlayType can be optimistic; if decoding fails, convert instead
        const fallback = canConvert
          ? () => {
              const reason = "This browser couldn't decode the video";
              setPlayback({ mode: "convert", heavy: false, reason });
              callbacksRef.current.onConvertStart?.(reason, false);
              convertAndPlay(src, player.html().getVideoEl().currentTime);
            }
          : undefined;
        await playDirect(src, time, gen, fallback);
      } else if (decision.mode === "convert") {
        const { heavy, reason, audioTrackId } = decision;
        setPlayback({ mode: "convert", heavy, reason });
        callbacksRef.current.onConvertStart?.(reason, heavy);
        await convertAndPlay(src, time, audioTrackId);
      } else {
        setPlayback({ mode: "fail", reason: decision.reason });
        report(decision.reason);
        // Try anyway: e.g. video without sound is better than nothing
        await player.current().setSrcAndTime(src, time);
      }
    };

    // Switches the audio track of the file being converted (e.g. another language). Local to this device for links,
    // for a shared file it changes what everyone hears since viewers receive the converted stream.
    const setAudioTrack = async (id: number) => {
      try {
        await transcoderRef.current?.selectAudioTrack(id);
      } catch (err) {
        console.error(err);
        showError(
          err instanceof Error ? err.message : "Unable to change audio track",
        );
      }
    };

    /** The per-device "Auto-convert when needed" switch. Applies to the next video this device loads. */
    const setConvertEnabled = (convertEnabled: boolean) => {
      try {
        window.localStorage.setItem(
          AUTO_CONVERT_KEY,
          convertEnabled ? "1" : "0",
        );
      } catch {
        // Not persisted (private mode)
      }
      store.set({ convertEnabled });
    };

    return {
      stopConvert,
      isCurrent,
      createTranscoder,
      convertAndPlay,
      playUrl,
      setAudioTrack,
      setConvertEnabled,
    };
  }, [store, player, showError]);
}

export type ConvertApi = ReturnType<typeof useConvert>;
