import { useMemo, useRef } from "react";
import { ClientTranscoder } from "../../../utils/clientTranscode";
import type { RoomStore } from "../roomState";
import type { PlayerApi } from "./usePlayer";

/**
 * In-browser conversion of media the browser can't play natively (clientTranscode.ts: WebCodecs + mediabunny, both
 * loaded lazily). Used for links when "Convert" is on, and for converted file shares (see useShare).
 */
export function useConvert(opts: {
  store: RoomStore;
  player: PlayerApi;
  showError: (message: string) => void;
}) {
  const { store, player, showError } = opts;
  const transcoderRef = useRef<ClientTranscoder | undefined>(undefined);

  return useMemo(() => {
    // Stops client-side conversion (if running) and releases its resources
    const stopConvert = () => {
      transcoderRef.current?.stop();
      transcoderRef.current = undefined;
      const { convertProgress, audioTracks } = store.get();
      if (convertProgress !== undefined || audioTracks !== undefined) {
        store.set({
          convertProgress: undefined,
          audioTracks: undefined,
          audioTrackId: undefined,
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
    ) => {
      const transcoder = new ClientTranscoder({
        source,
        video,
        startTime,
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

    // Plays a media URL in this browser after converting it. Only affects this client: the room's media URL is
    // unchanged.
    const convertAndPlay = async (src: string, time: number) => {
      const video = player.html().getVideoEl();
      const transcoder = createTranscoder(src, video, time, (err) => {
        // Conversion failed while playing. Carry on without it.
        showError(
          `Conversion failed: ${err.message}. Playing without conversion.`,
        );
        stopConvert();
        player.current().setSrcAndTime(src, video.currentTime);
      });
      try {
        await transcoder.start();
      } catch (err) {
        console.error(err);
        if (isCurrent(transcoder)) {
          // Typically a CORS restriction or a link that isn't a media file
          stopConvert();
          const reason =
            err instanceof Error ? err.message : "Unable to convert this video";
          showError(`${reason}. Playing without conversion.`);
          await player.current().setSrcAndTime(src, time);
        }
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

    const setConvertEnabled = (convertEnabled: boolean) => {
      window.localStorage.setItem(
        "watchparty-convert",
        convertEnabled ? "1" : "0",
      );
      store.set({ convertEnabled });
      window.location.reload();
    };

    return {
      stopConvert,
      isCurrent,
      createTranscoder,
      convertAndPlay,
      setAudioTrack,
      setConvertEnabled,
    };
  }, [store, player, showError]);
}

export type ConvertApi = ReturnType<typeof useConvert>;
