import { useEffect, useMemo, useRef } from "react";
import { notifications } from "@mantine/notifications";
import type { RoomStore } from "../roomState";
import type { RoomCommands } from "../socketEvents";
import type { PlayerApi } from "./usePlayer";
import {
  describeReadyCheckChange,
  isReadyToPlay,
  StallDebounce,
} from "../logic/readyCheck";
import { toast } from "../ui/toast";

/** How often this device checks its buffer (reports are only sent when they change) */
const POLL_MS = 500;
const TOAST_ID = "wp-ready-check";

/**
 * Ready check (PLAN 6d), client side: reports this device's readiness (CMD:readyState) whenever it changes, and
 * handles REC:readyCheck (state for the pill/People tab, toasts). The server pauses and resumes the room.
 */
export function useReadyCheck(opts: {
  store: RoomStore;
  cmd: RoomCommands;
  player: PlayerApi;
  clientId: string;
  connected: boolean;
}) {
  const { store, cmd, player, clientId } = opts;
  /** The last report sent ("" = send the next one regardless) */
  const lastSent = useRef("");
  const lastMedia = useRef("");
  const wasReady = useRef(false);
  const stall = useRef(new StallDebounce());

  const api = useMemo(() => {
    /** Reads this device's player and decides {ready, buffering} */
    const measure = () => {
      const s = store.get();
      const p = player.current();
      const notBlocking =
        !s.roomMedia ||
        player.isWebRTCShare() ||
        s.isLiveStream ||
        s.nonPlayableMedia ||
        s.playback?.mode === "fail";
      const youtube = player.usingYoutube();
      const currentTime = p.getCurrentTime() || 0;
      const ready = isReadyToPlay({
        notBlocking,
        loading: s.loading,
        currentTime,
        duration: p.getDuration(),
        ranges: p.getTimeRanges(),
        readyState: youtube ? undefined : p.getVideoEl()?.readyState,
        ytBuffering: youtube && s.buffering,
        converting: s.playback?.mode === "convert",
        wasReady: wasReady.current,
      });
      wasReady.current = ready;
      const buffering = stall.current.update(
        !notBlocking && !s.loading && !s.roomPaused && s.buffering,
        Date.now(),
      );
      return { ready, buffering, time: player.toRoomTime(currentTime) };
    };

    const poll = () => {
      const s = store.get();
      if (s.roomMedia !== lastMedia.current) {
        // New video: the server forgot the old reports
        lastMedia.current = s.roomMedia;
        lastSent.current = "";
        wasReady.current = false;
      }
      if (!s.socketConnected || !s.roomSettings.readyCheck) {
        // Report again once reconnected (the server treats a reconnect as a fresh join) or the setting is turned on
        lastSent.current = "";
        return;
      }
      const report = measure();
      const key = `${report.ready}|${report.buffering}`;
      if (key !== lastSent.current) {
        lastSent.current = key;
        cmd.reportReadyState(report);
      }
    };

    /** REC:readyCheck */
    const onState = (next: ReadyCheckState) => {
      const s = store.get();
      const prev = s.readyCheck;
      store.set({ readyCheck: next });
      if (next.active && !prev?.active) {
        // Make sure the server has our current state
        lastSent.current = "";
      }
      const message = describeReadyCheckChange(prev, next, s.nameMap, clientId);
      if (message) {
        toast(message.text, { id: TOAST_ID, tone: message.tone });
        store.set({ playerNotice: { text: message.text, at: Date.now() } });
      } else if (!next.active && prev?.active) {
        notifications.hide(TOAST_ID);
      }
    };

    return {
      poll,
      onState,
      /** "Resume now" */
      skip: () => cmd.skipReadyCheck(),
    };
  }, [store, cmd, player, clientId]);

  useEffect(() => {
    if (!opts.connected) {
      return;
    }
    lastSent.current = "";
    const id = window.setInterval(api.poll, POLL_MS);
    return () => window.clearInterval(id);
  }, [opts.connected, api]);

  return api;
}

export type ReadyCheckApi = ReturnType<typeof useReadyCheck>;
