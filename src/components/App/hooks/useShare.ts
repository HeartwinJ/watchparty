import { useMemo } from "react";
import { getIceServers } from "../../../utils/iceServers";
import { openFileSelector } from "../../../utils/utils";
import { isClientTranscodeSupported } from "../../../utils/clientTranscode";
import config from "../../../config";
import type { RoomStore } from "../roomState";
import type { RoomCommands, SignalMessage } from "../socketEvents";
import type { PlayerApi } from "./usePlayer";
import type { ConvertApi } from "./useConvert";
import { findSharer } from "../logic/media";
import { stripExtmapAllowMixed, tuneAnswerSdp } from "../logic/sdp";

/**
 * Mutable WebRTC state for screen/file share. Not React state: connections change during signaling and nothing
 * renders them directly (the store's isPublishing flag drives the UI).
 */
export interface ShareSession {
  /** The stream this device is sharing (screen capture, or captureStream() of the <video> playing a file) */
  localStream?: MediaStream;
  /** Whether localStream comes from a file played in our own <video> */
  isFile: boolean;
  /** As the sharer: one connection per viewer, by client id */
  publisherConns: PCDict;
  /** As a viewer: the connection to the sharer */
  consumerConn?: RTCPeerConnection;
}

export const createShareSession = (): ShareSession => ({
  isFile: false,
  publisherConns: {},
});

/**
 * Screen share and file share. Both publish a MediaStream peer-to-peer to every viewer: the room media becomes
 * screenshare:// or fileshare://, the server relays signaling (signalSS) and the ICE servers come from /iceServers.
 */
export function useShare(opts: {
  store: RoomStore;
  cmd: RoomCommands;
  clientId: string;
  player: PlayerApi;
  convert: ConvertApi;
  session: ShareSession;
  showError: (message: string) => void;
}) {
  const { store, cmd, clientId, player, convert, session, showError } = opts;

  return useMemo(() => {
    const setLocalStream = (
      stream: MediaStream | undefined,
      isFile: boolean,
    ) => {
      session.localStream = stream;
      session.isFile = isFile;
      store.set({ isPublishing: Boolean(stream) });
    };

    const stopPublishing = async () => {
      convert.stopConvert();
      if (session.localStream) {
        cmd.leaveScreenShare();
        // We don't actually need to unmute if it's a fileshare but this is fine
        player.localSetMute(false);
      }
      session.localStream?.getTracks().forEach((track) => {
        track.stop();
      });
      if (session.consumerConn) {
        session.consumerConn.close();
        session.consumerConn = undefined;
      }
      Object.values(session.publisherConns).forEach((pc) => {
        pc.close();
      });
      session.publisherConns = {};
      setLocalStream(undefined, false);
    };

    const startScreenShare = async () => {
      if (navigator.mediaDevices.getDisplayMedia) {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          //@ts-expect-error
          video: { height: 720, logicalSurface: true },
          audio: {
            autoGainControl: false,
            channelCount: 2,
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: 48000,
            sampleSize: 16,
          },
        });
        setLocalStream(stream, false);
        // Warm the ICE server cache before viewers start connecting
        await getIceServers();
        cmd.joinScreenShare(false);
      }
    };

    // Shares a file from this device. With convert, the file is first transcoded in this browser (see useConvert),
    // then shared the same way as an unconverted file.
    const startFileShare = async (options?: { convert?: boolean }) => {
      const files = await openFileSelector();
      if (!files) {
        return;
      }
      const file = files[0];
      if (options?.convert && !isClientTranscodeSupported()) {
        showError("Your browser doesn't support converting videos");
        return;
      }
      convert.stopConvert();
      player.current().clearState();
      const video = player.html().getVideoEl();
      if (options?.convert) {
        const transcoder = convert.createTranscoder(file, video, 0, (err) => {
          // Conversion failed mid-share
          showError(`Conversion failed: ${err.message}`);
          stopPublishing();
        });
        try {
          await transcoder.start();
        } catch (err) {
          console.error(err);
          if (convert.isCurrent(transcoder)) {
            convert.stopConvert();
            showError(
              err instanceof Error
                ? err.message
                : "Unable to convert this file",
            );
          }
          return;
        }
        if (!convert.isCurrent(transcoder)) {
          // Cancelled while starting up
          return;
        }
      } else {
        video.src = URL.createObjectURL(file);
      }
      video.play();
      //@ts-expect-error captureStream isn't in the DOM types for HTMLMediaElement
      const stream: MediaStream | undefined = video?.captureStream();
      setLocalStream(stream, true);
      if (stream) {
        // Warm the ICE server cache before viewers start connecting
        await getIceServers();
        cmd.joinScreenShare(true);
      }
    };

    const sendSignal = (to: string, msg: SignalMessage, sharer?: boolean) =>
      cmd.signal(to, msg, sharer);

    // Creates the connections for the current roster (called on every roster change)
    const setupRTCConnections = async () => {
      if (!player.isWebRTCShare()) {
        return;
      }
      // Everything below runs synchronously after this, so concurrent calls can't create duplicate connections
      const iceServers = await getIceServers();
      if (!player.isWebRTCShare()) {
        return;
      }
      const { participants } = store.get();
      const sharer = findSharer(participants);
      const localTrack = session.localStream?.getVideoTracks()[0];
      if (localTrack && !localTrack.onended) {
        // Stop sharing if the local stream stops
        localTrack.onended = () => stopPublishing();
      }

      // We're the sharer, create a connection to each other member
      if (sharer?.id === clientId) {
        // Delete and close any connections that aren't in the current member list (maybe someone disconnected)
        // This allows them to rejoin later
        const clientIds = new Set(participants.map((p) => p.id));
        Object.entries(session.publisherConns).forEach(([key, value]) => {
          if (!clientIds.has(key)) {
            value.close();
            delete session.publisherConns[key];
          }
        });

        participants.forEach((user) => {
          const id = user.id;
          if (id === clientId && session.isFile) {
            // Don't set up a connection to ourselves if sharing file
            return;
          }
          if (!session.publisherConns[id]) {
            // Set up the RTCPeerConnection for sharing media to each member
            const pc = new RTCPeerConnection({ iceServers });
            session.publisherConns[id] = pc;
            const stream = session.localStream;
            stream?.getTracks().forEach((track) => {
              pc.addTrack(track, stream);
            });
            pc.onicecandidate = (event) => {
              // We generated an ICE candidate, send it to peer
              if (event.candidate) {
                sendSignal(id, { ice: event.candidate }, true);
              }
            };
            pc.onnegotiationneeded = async () => {
              // Start connection for peer's video
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              sendSignal(id, { sdp: pc.localDescription }, true);
            };
          }
        });
      }
      // We're a watcher, establish connection to sharer
      // If screensharing, sharer also does this
      // If filesharing, sharer does not do this since we use our own <video>
      if (sharer && !session.consumerConn && !session.isFile) {
        const pc = new RTCPeerConnection({ iceServers });
        session.consumerConn = pc;
        pc.onicecandidate = (event) => {
          // We generated an ICE candidate, send it to sharer
          if (event.candidate) {
            sendSignal(sharer.id, { ice: event.candidate });
          }
        };
        pc.ontrack = (event: RTCTrackEvent) => {
          // Mount the stream from sharer
          const video = player.html().getVideoEl();
          if (video) {
            video.src = "";
            video.srcObject = event.streams[0];
            player.localPlay();
          }
        };
      }
    };

    // Handles a signaling message relayed by the server
    const handleSignal = async (data: {
      msg: SignalMessage;
      from: string;
      sharer: boolean;
    }) => {
      config.NODE_ENV === "development" && console.log(data);
      // setupRTCConnections waits for the ICE servers before creating connections, so wait for them too
      // (it awaited first, so its connections exist by the time this continues)
      await getIceServers();
      const { msg, from } = data;
      // Determine whether the message came from the sharer or the sharee
      const pc = data.sharer
        ? session.consumerConn
        : session.publisherConns[from];
      if (!pc) {
        console.warn("signalSS: no connection for", from);
        return;
      }
      if (msg.ice !== undefined) {
        pc.addIceCandidate(new RTCIceCandidate(msg.ice));
      } else if (msg.sdp && msg.sdp.type === "offer") {
        const offer = {
          type: msg.sdp.type,
          sdp: stripExtmapAllowMixed(msg.sdp.sdp ?? ""),
        };
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        //@ts-expect-error window.chrome is Chromium-only
        const isChromium = Boolean(window.chrome);
        if (answer.sdp) {
          answer.sdp = tuneAnswerSdp(answer.sdp, isChromium);
        }
        await pc.setLocalDescription(answer);
        sendSignal(from, { sdp: pc.localDescription }, !data.sharer);
      } else if (msg.sdp && msg.sdp.type === "answer") {
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    };

    return {
      startScreenShare,
      startFileShare,
      stopPublishing,
      setupRTCConnections,
      handleSignal,
    };
  }, [store, cmd, clientId, player, convert, session, showError]);
}

export type ShareApi = ReturnType<typeof useShare>;
