import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { getIceServers } from "../../../utils/iceServers";
import type { RoomStore } from "../roomState";
import type { CallModerationAction, RoomCommands } from "../socketEvents";
import type { PlayerApi } from "../hooks/usePlayer";
import { isInModal, isTypingTarget } from "../logic/shortcuts";
import { toast } from "../ui/toast";
import { CallAudio, listMics, openMic } from "./audio";
import {
  callReducer,
  inCall,
  remoteMembers,
  type CallAction,
} from "./callReducer";
import { Ducker } from "./ducking";
import {
  CALL_PREFS,
  createStateThrottle,
  isPttKey,
  isTransmitting,
  joinMuted,
  MIC_ERROR_TEXT,
  newCallSession,
  readPref,
  readRejoin,
  writePref,
  writeRejoin,
} from "./logic";
import { meterLevel } from "./speaking";
import { createMeshTransport, type CallTransport } from "./transport";
import { CAMERA_ERROR_TEXT, listCameras, openCamera } from "./video";
import { CallVideo } from "./videoStreams";

/** How long to wait for the server to list us after `join` */
const JOIN_TIMEOUT_MS = 8000;

/** Mutable call state for this page: media and connections, not React state (state.call drives the UI) */
interface CallSession {
  micStream: MediaStream | null;
  /** Our camera, while it's on (also before joining, as the preview) */
  camStream: MediaStream | null;
  /** Our preview and everyone's incoming video, for the tiles */
  video: CallVideo;
  /** Bumped on every camera on/off so a slow camera open that was cancelled doesn't finish */
  camSeq: number;
  audio: CallAudio | null;
  transport: CallTransport | null;
  ducker: Ducker;
  duckLevel: number;
  joinTimer: number | undefined;
  /** A reload rejoin was attempted on this page */
  rejoinTried: boolean;
  /** The pre-join panel is open (it holds the mic for the level meter) */
  previewing: boolean;
  /** Bumped on every join/leave so a slow join that was cancelled doesn't finish */
  seq: number;
}

/**
 * The room's voice call (audio only for now). Server-authoritative membership (REC:callState), media over
 * `CallTransport` (a P2P mesh today), speaking detection and movie ducking on this device. See README.md.
 */
export function useCall(opts: {
  store: RoomStore;
  cmd: RoomCommands;
  clientId: string;
  roomId: string;
  player: PlayerApi;
}) {
  const { store, cmd, clientId, roomId, player } = opts;
  const session = useRef<CallSession>({
    micStream: null,
    camStream: null,
    video: new CallVideo(),
    camSeq: 0,
    audio: null,
    transport: null,
    ducker: new Ducker(),
    duckLevel: 1,
    joinTimer: undefined,
    rejoinTried: false,
    previewing: false,
    seq: 0,
  }).current;
  // One call session id per page load: a socket reconnect keeps it (and the peer connections), a reload doesn't
  const callSession = useMemo(() => newCallSession(), []);

  const api = useMemo(() => {
    const dispatch = (action: CallAction) =>
      store.set({ call: callReducer(store.get().call, action) });
    const call = () => store.get().call;
    const nameOf = (actor: PlaybackActor) =>
      store.get().nameMap[actor.id] || actor.name || "Someone";

    const stateThrottle = createStateThrottle<boolean>((muted) =>
      cmd.call({ action: "state", muted }),
    );

    const micTrack = () => session.micStream?.getAudioTracks()[0] ?? null;
    const cameraTrack = () => session.camStream?.getVideoTracks()[0] ?? null;

    const setDuck = (level: number) => {
      if (level === session.duckLevel) {
        return;
      }
      session.duckLevel = level;
      player.html().setDuck(level);
      player.youtube().setDuck(level);
    };

    const ensureAudio = () => {
      if (!session.audio) {
        const audio = new CallAudio();
        audio.onSpeaking = (ids) => dispatch({ type: "speaking", ids });
        audio.onTick = (remoteSpeaking) => {
          const level = session.ducker.update(
            {
              enabled: call().ducking && inCall(call()),
              remoteSpeaking,
            },
            performance.now(),
          );
          setDuck(Math.round(level * 100) / 100);
        };
        audio.onBlocked = () => {
          if (call().audioBlocked) {
            return;
          }
          dispatch({ type: "patch", patch: { audioBlocked: true } });
          toast("Your browser paused the call audio.", {
            id: "wp-call-audio",
            tone: "warning",
            duration: 15000,
            action: { label: "Play call audio", onClick: unblockAudio },
          });
        };
        session.audio = audio;
      }
      return session.audio;
    };

    const unblockAudio = async () => {
      const ok = await session.audio?.unblock();
      dispatch({ type: "patch", patch: { audioBlocked: !ok } });
    };

    /** Opens the transmit gate (push-to-talk or the mute toggle) and tells the room */
    const applyTransmit = () => {
      const s = call();
      const on = isTransmitting(s);
      const track = micTrack();
      if (track) {
        track.enabled = on || !inCall(s);
      }
      if (inCall(s)) {
        stateThrottle.push(!on);
        writeRejoin(roomId, { muted: s.muted });
      }
    };

    const stopMic = () => {
      session.micStream?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      session.micStream = null;
      session.audio?.setLocal(clientId, null);
    };

    const adoptStream = (stream: MediaStream) => {
      const old = session.micStream;
      const track = stream.getAudioTracks()[0];
      session.micStream = stream;
      if (track) {
        const s = call();
        track.enabled = inCall(s) ? isTransmitting(s) : true;
        track.onended = onMicLost;
      }
      session.audio?.setLocal(clientId, track ?? null);
      session.transport?.setLocalTrack("audio", track ?? null);
      if (old && old !== stream) {
        old.getTracks().forEach((t) => {
          t.onended = null;
          t.stop();
        });
      }
    };

    /** Opens the remembered mic unless one is live; false and a micError when it can't */
    const ensureMic = async (): Promise<boolean> => {
      const current = micTrack();
      if (current && current.readyState === "live") {
        return true;
      }
      const result = await openMic(readPref(CALL_PREFS.mic));
      if (!result.ok) {
        dispatch({ type: "patch", patch: { micError: result.error } });
        return false;
      }
      dispatch({ type: "patch", patch: { micError: null } });
      adoptStream(result.stream);
      return true;
    };

    /** The mic went away (headset unplugged): switch to the default one, or mute */
    const onMicLost = async () => {
      if (!session.micStream) {
        return;
      }
      const result = await openMic(null);
      if (result.ok) {
        adoptStream(result.stream);
        const label = result.stream.getAudioTracks()[0]?.label;
        toast(
          label
            ? `Microphone disconnected. Using ${label} now.`
            : "Microphone disconnected. Switched to the default microphone.",
          { id: "wp-call-mic", tone: "warning" },
        );
      } else {
        stopMic();
        if (inCall(call())) {
          setMuted(true);
        }
        dispatch({ type: "patch", patch: { micError: result.error } });
        toast("Microphone disconnected.", {
          id: "wp-call-mic",
          tone: "danger",
        });
      }
    };

    /** devicechange while in the call: the mic we use may be gone (not every browser ends the track) */
    const checkMic = async () => {
      const track = micTrack();
      if (!inCall(call()) || !track) {
        return;
      }
      if (track.readyState === "ended") {
        return onMicLost();
      }
      const id = track.getSettings?.().deviceId;
      const mics = await listMics();
      if (id && mics.length && !mics.some((m) => m.deviceId === id)) {
        return onMicLost();
      }
    };

    // --- Camera ---

    /** Stops the camera (the light goes off) and stops sending video; the senders stay, so no renegotiation */
    const releaseCamera = () => {
      session.camStream?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      session.camStream = null;
      session.video.setLocal(null);
      session.transport?.setLocalTrack("video", null);
    };

    const adoptCamera = (stream: MediaStream) => {
      const old = session.camStream;
      const track = stream.getVideoTracks()[0] ?? null;
      session.camStream = stream;
      if (track) {
        track.onended = onCameraLost;
      }
      session.video.setLocal(track);
      // replaceTrack once a peer has a video sender, else addTrack (one renegotiation per peer)
      session.transport?.setLocalTrack("video", track);
      if (old && old !== stream) {
        old.getTracks().forEach((t) => {
          t.onended = null;
          t.stop();
        });
      }
    };

    const sendCamera = (on: boolean) => {
      if (inCall(call())) {
        cmd.call({ action: "state", camera: on });
      }
    };

    /**
     * Turns the camera on (the remembered one, or `deviceId`) or off. Before joining it's the preview (we join with it
     * on); in the call everyone sees it. A camera that can't start shows why and leaves the call alone. Resolves to
     * whether the camera is on.
     */
    const setCamera = async (
      on: boolean,
      deviceId?: string,
    ): Promise<boolean> => {
      const seq = ++session.camSeq;
      if (!on) {
        const wasOn = call().camera;
        releaseCamera();
        dispatch({
          type: "patch",
          patch: { camera: false, cameraBusy: false },
        });
        if (wasOn) {
          sendCamera(false);
        }
        return false;
      }
      dispatch({
        type: "patch",
        patch: { cameraBusy: true, cameraError: null },
      });
      const id = deviceId ?? readPref(CALL_PREFS.camera);
      let result = await openCamera(id);
      if (
        !result.ok &&
        result.error === "in-use" &&
        session.camStream &&
        seq === session.camSeq
      ) {
        // Phones can't run two cameras at once: let go of the current one and try again
        releaseCamera();
        result = await openCamera(id);
      }
      if (seq !== session.camSeq) {
        // Turned off (or left) while the camera was opening
        if (result.ok) {
          result.stream.getTracks().forEach((t) => t.stop());
        }
        return Boolean(cameraTrack());
      }
      if (!result.ok) {
        const wasOn = call().camera;
        const stillOn = Boolean(cameraTrack());
        dispatch({
          type: "patch",
          patch: {
            camera: stillOn,
            cameraBusy: false,
            cameraError: result.error,
          },
        });
        if (wasOn && !stillOn) {
          sendCamera(false);
        }
        toast(CAMERA_ERROR_TEXT[result.error].title, {
          id: "wp-call-camera",
          tone: "danger",
        });
        return stillOn;
      }
      adoptCamera(result.stream);
      if (deviceId) {
        writePref(CALL_PREFS.camera, deviceId);
      }
      const wasOn = call().camera;
      dispatch({
        type: "patch",
        patch: { camera: true, cameraBusy: false, cameraError: null },
      });
      if (!wasOn) {
        sendCamera(true);
      }
      return true;
    };

    /** V and the camera buttons. Pressing it while the camera is still opening cancels. */
    const toggleCamera = () => {
      const s = call();
      return setCamera(!(s.camera || s.cameraBusy));
    };

    /** The camera picker: remembered for next time, and switched right away (replaceTrack) when it's on */
    const setCameraDevice = async (deviceId: string) => {
      writePref(CALL_PREFS.camera, deviceId);
      const current = cameraTrack()?.getSettings?.().deviceId;
      if (call().camera && current !== deviceId) {
        await setCamera(true, deviceId);
      }
    };

    /** The camera ended on its own (unplugged, taken by the system): turn it off */
    const onCameraLost = () => {
      if (!session.camStream) {
        return;
      }
      void setCamera(false);
      toast("Camera disconnected. It's off now.", {
        id: "wp-call-camera",
        tone: "warning",
      });
    };

    /** devicechange: the camera we use may be gone (not every browser ends the track) */
    const checkCamera = async () => {
      const track = cameraTrack();
      if (!track) {
        return;
      }
      if (track.readyState === "ended") {
        return onCameraLost();
      }
      const id = track.getSettings?.().deviceId;
      const cameras = await listCameras();
      if (id && cameras.length && !cameras.some((c) => c.deviceId === id)) {
        return onCameraLost();
      }
    };

    const setTilesHidden = (hidden: boolean) => {
      writePref(CALL_PREFS.tilesHidden, hidden ? "1" : null);
      dispatch({ type: "patch", patch: { tilesHidden: hidden } });
    };

    /** Pre-join: open the mic so the panel can show its level */
    const startPreview = async () => {
      session.previewing = true;
      await ensureAudio().start();
      await ensureMic();
      if (!session.previewing) {
        // Closed while the mic was opening
        stopPreview();
      }
    };

    /** The pre-join panel closed without joining */
    const stopPreview = () => {
      session.previewing = false;
      if (inCall(call()) || call().busy) {
        return;
      }
      void setCamera(false);
      stopMic();
      session.audio?.close();
      session.audio = null;
    };

    const setDevice = async (deviceId: string) => {
      const result = await openMic(deviceId);
      if (!result.ok) {
        dispatch({ type: "patch", patch: { micError: result.error } });
        toast(MIC_ERROR_TEXT[result.error].title, {
          id: "wp-call-mic",
          tone: "danger",
        });
        return;
      }
      dispatch({ type: "patch", patch: { micError: null } });
      adoptStream(result.stream);
      writePref(CALL_PREFS.mic, deviceId);
    };

    /** Our mic's level for a meter, 0..1 */
    const getLevel = () => meterLevel(session.audio?.levelOf(clientId) ?? -100);

    const clearJoinTimer = () => {
      window.clearTimeout(session.joinTimer);
      session.joinTimer = undefined;
    };

    /** Ends the call on this device (media, connections, ducking). Doesn't tell the server. */
    const cleanup = () => {
      session.seq++;
      clearJoinTimer();
      stateThrottle.cancel();
      session.transport?.close();
      session.transport = null;
      session.camSeq++;
      releaseCamera();
      session.video.clear();
      stopMic();
      session.audio?.close();
      session.audio = null;
      session.ducker.reset();
      setDuck(1);
      dispatch({ type: "left" });
    };

    const join = async (rejoin?: { muted: boolean }) => {
      const s = call();
      if (inCall(s) || s.busy) {
        return;
      }
      const seq = ++session.seq;
      dispatch({ type: "patch", patch: { busy: true, micError: null } });
      await ensureAudio().start();
      const micOk = await ensureMic();
      if (seq !== session.seq) {
        return;
      }
      if (!micOk) {
        dispatch({ type: "patch", patch: { busy: false } });
        if (rejoin) {
          const kind = call().micError ?? "unknown";
          toast(
            `Couldn't rejoin the voice call: ${MIC_ERROR_TEXT[kind].title}.`,
            {
              id: "wp-call",
              tone: "danger",
              action: { label: "Try again", onClick: () => join(rejoin) },
            },
          );
          writeRejoin(roomId, null);
        }
        return;
      }
      const iceServers = await getIceServers();
      if (seq !== session.seq) {
        return;
      }
      const audio = ensureAudio();
      session.transport = createMeshTransport({
        selfId: clientId,
        session: callSession,
        iceServers,
        send: cmd.callSignal,
        events: {
          onTrack: (id, track) =>
            track.kind === "video"
              ? session.video.addRemote(id, track)
              : audio.addRemote(id, track),
          onPeerClosed: (id) => {
            audio.remove(id);
            session.video.remove(id);
            dispatch({ type: "peer", clientId: id, status: null });
          },
          onPeerStatus: (id, status) =>
            dispatch({ type: "peer", clientId: id, status }),
        },
      });
      session.transport.setLocalTrack("audio", micTrack());
      // Turned on in the pre-join preview: everyone gets it from the first offer
      session.transport.setLocalTrack(
        "video",
        call().camera ? cameraTrack() : null,
      );
      const muted = rejoin ? rejoin.muted : joinMuted(store.get());
      dispatch({ type: "joining", session: callSession, muted });
      sendJoin();
      session.joinTimer = window.setTimeout(() => {
        if (call().status === "joining") {
          cleanup();
          writeRejoin(roomId, null);
          toast("Couldn't join the voice call. Try again in a moment.", {
            id: "wp-call",
            tone: "danger",
          });
        }
      }, JOIN_TIMEOUT_MS);
      if (!rejoin && muted) {
        toast(
          call().pushToTalk
            ? "You joined the call. Hold T to talk."
            : "You joined muted because the video is playing. Press M to unmute.",
          { id: "wp-call" },
        );
      }
    };

    /** `join` with our current state (first join, a socket reconnect, a reload) */
    const sendJoin = () => {
      const s = call();
      const on = isTransmitting(s);
      const track = micTrack();
      if (track) {
        track.enabled = on;
      }
      cmd.call({
        action: "join",
        session: callSession,
        muted: !on,
        camera: s.camera && Boolean(cameraTrack()),
      });
      stateThrottle.reset(!on);
      writeRejoin(roomId, { muted: s.muted });
    };

    const leave = () => {
      if (inCall(call())) {
        cmd.call({ action: "leave" });
      }
      writeRejoin(roomId, null);
      cleanup();
    };

    const setMuted = (muted: boolean) => {
      dispatch({ type: "muted", muted });
      applyTransmit();
    };

    /** M: toggles the mic; returns the new muted state */
    const toggleMute = () => {
      const muted = !call().muted;
      setMuted(muted);
      return muted;
    };

    const pttDown = () => {
      if (inCall(call()) && call().pushToTalk) {
        dispatch({ type: "ptt", held: true });
        applyTransmit();
      }
    };
    const pttUp = () => {
      if (call().pttHeld) {
        dispatch({ type: "ptt", held: false });
        applyTransmit();
      }
    };

    const setPushToTalk = (on: boolean) => {
      writePref(CALL_PREFS.pushToTalk, on ? "1" : null);
      dispatch({ type: "patch", patch: { pushToTalk: on } });
      dispatch({ type: "ptt", held: false });
      applyTransmit();
    };
    const setDucking = (on: boolean) => {
      writePref(CALL_PREFS.ducking, on ? "1" : null);
      dispatch({ type: "patch", patch: { ducking: on } });
    };

    const moderate = (target: string, action: CallModerationAction) =>
      cmd.moderateCall(target, action);

    // --- Socket events (wired in useRoom) ---

    const onState = (state: CallState) => {
      const before = call();
      dispatch({ type: "server", state, selfId: clientId });
      const after = call();
      if (after.status === "joined" && before.status === "joining") {
        clearJoinTimer();
      }
      if (inCall(after)) {
        session.transport?.setPeers(
          remoteMembers(after, clientId).map((m) => ({
            clientId: m.clientId,
            session: m.session,
            reconnecting: m.reconnecting,
          })),
        );
      } else if (inCall(before)) {
        // We're no longer listed (timed out while offline, or another tab took over)
        cleanup();
        writeRejoin(roomId, null);
        toast("You're no longer in the voice call.", { id: "wp-call" });
      }
    };

    const onSignal = (signal: CallSignalEvent) =>
      session.transport?.handleSignal(signal);

    const onModerated = (event: CallModeratedEvent) => {
      if (!inCall(call())) {
        return;
      }
      const name = nameOf(event.by);
      if (event.action === "camera") {
        if (call().camera || call().cameraBusy) {
          void setCamera(false);
          toast(`${name} turned off your camera.`, { id: "wp-call-camera" });
        }
      } else if (event.action === "mute") {
        setMuted(true);
        toast(`${name} muted you in the call. Unmute when you're ready.`, {
          id: "wp-call",
        });
      } else {
        writeRejoin(roomId, null);
        cleanup();
        toast(`${name} removed you from the voice call.`, {
          id: "wp-call",
          tone: "warning",
        });
      }
    };

    /** Socket (re)connected: resume the call we're in, or rejoin after a reload of this tab */
    const onConnect = () => {
      const s = call();
      if (inCall(s)) {
        dispatch({ type: "joining", session: callSession, muted: s.muted });
        sendJoin();
        return;
      }
      const marker = readRejoin(roomId);
      if (marker && !session.rejoinTried && !s.busy) {
        session.rejoinTried = true;
        join(marker);
      }
    };

    const onDisconnect = (reason: string) => {
      // The server closed us (another tab took over, kicked): this tab is out. Otherwise media keeps flowing
      // peer-to-peer while the socket reconnects, and onConnect rejoins.
      if (reason === "io server disconnect" && inCall(call())) {
        cleanup();
      }
    };

    /** Unmount / room change: leave (sent before the socket closes) */
    const teardown = () => {
      if (
        inCall(call()) ||
        session.micStream ||
        session.audio ||
        session.camStream
      ) {
        leave();
      }
    };

    return {
      startPreview,
      stopPreview,
      setDevice,
      getLevel,
      levelOf: (id: string) => meterLevel(session.audio?.levelOf(id) ?? -100),
      /** The deviceId of the mic in use (for the picker) */
      currentDeviceId: () =>
        micTrack()?.getSettings?.().deviceId ?? readPref(CALL_PREFS.mic),
      listMics,
      setCamera: (on: boolean) => setCamera(on),
      toggleCamera,
      setCameraDevice,
      /** The deviceId of the camera in use, or the remembered one (for the picker) */
      currentCameraId: () =>
        cameraTrack()?.getSettings?.().deviceId ?? readPref(CALL_PREFS.camera),
      listCameras,
      checkCamera,
      setTilesHidden,
      /** Our preview and everyone's incoming video (useCallVideo) */
      video: session.video,
      join: () => join(),
      leave,
      setMuted,
      toggleMute,
      pttDown,
      pttUp,
      setPushToTalk,
      setDucking,
      moderate,
      unblockAudio,
      onState,
      onSignal,
      onModerated,
      onConnect,
      onDisconnect,
      teardown,
      checkMic,
    };
  }, [store, cmd, clientId, roomId, player, session, callSession]);

  // Push-to-talk: hold T (not while typing or in a dialog); releasing the window lets go too
  const status = useStoreCallStatus(store);
  useEffect(() => {
    if (!status.inCall || !status.pushToTalk) {
      return;
    }
    const down = (e: KeyboardEvent) => {
      if (
        !isPttKey(e.key) ||
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        isTypingTarget(e.target) ||
        isInModal(e.target)
      ) {
        return;
      }
      e.preventDefault();
      api.pttDown();
    };
    const up = (e: KeyboardEvent) => {
      if (isPttKey(e.key)) {
        api.pttUp();
      }
    };
    const release = () => api.pttUp();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      api.pttUp();
    };
  }, [api, status.inCall, status.pushToTalk]);

  // Headset or camera unplugged etc. while in the call (or while the camera preview runs)
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if ((!status.inCall && !status.camera) || !devices?.addEventListener) {
      return;
    }
    const onChange = () => {
      void api.checkMic();
      void api.checkCamera();
    };
    devices.addEventListener("devicechange", onChange);
    return () => devices.removeEventListener("devicechange", onChange);
  }, [api, status.inCall, status.camera]);

  // Leave when the room page goes away (a layout effect, so `leave` is sent before the socket disconnects)
  const apiRef = useRef(api);
  apiRef.current = api;
  useLayoutEffect(() => () => apiRef.current.teardown(), [roomId]);

  return api;
}

/** The call flags the key/device listeners depend on (useRoom re-renders on every store change) */
function useStoreCallStatus(store: RoomStore) {
  const { call } = store.get();
  return {
    inCall: inCall(call),
    pushToTalk: call.pushToTalk,
    camera: call.camera,
  };
}

export type CallApi = ReturnType<typeof useCall>;
