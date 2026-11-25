/**
 * SourcePicker: the room's command palette for choosing what to watch. Mount it once inside <RoomUiProvider>:
 *
 *   <SourcePicker room={room} />
 *
 * It opens when useRoomUi().pickerOpen is true (top-bar trigger, "/" key, openPickerAt(...)), and also shows the
 * room-wide "X can't play this stream" toasts (REC:playbackIssue) with "Pick another" / "Share converted stream",
 * and fills the player's subtitle menu with the current AIOStreams title's subtitles (useAutoSubtitles).
 */
import { useEffect, useMemo, useRef } from "react";
import { isClientTranscodeSupported } from "../../../utils/clientTranscode";
import { isDirectVideoUrl } from "../../../utils/utils";
import type { StreamDTO } from "../../../api/addons";
import type { Room } from "../hooks/useRoom";
import { findSharer, withDisplayName } from "../logic/media";
import { toast, type ToastAction } from "../ui/toast";
import { useRoomUi } from "../ui/RoomUi";
import { PickerPalette } from "./PickerPalette";
import {
  buildVideoMeta,
  saveRecent,
  streamDisplayName,
  type StreamContext,
} from "./pickerLogic";
import type { PickerActions } from "./types";
import { useAutoSubtitles } from "./useAutoSubtitles";

export function SourcePicker({ room }: { room: Room }) {
  const ui = useRoomUi();
  const actions = usePickerActions(room);
  usePlaybackIssueToasts(room);
  useAutoSubtitles(room.state.videoMeta, room.store);
  return (
    <PickerPalette
      opened={ui.pickerOpen}
      onClose={ui.closePicker}
      actions={actions}
      target={ui.pickerTarget}
      mode={ui.pickerMode}
    />
  );
}

function streamItem(stream: StreamDTO, ctx: StreamContext) {
  const name = streamDisplayName(ctx.title.name, ctx.episode);
  return {
    // The name rides along in the URL fragment so the top bar/chat/queue never show the credential-bearing URL
    url: withDisplayName(stream.url, name),
    name,
    meta: buildVideoMeta(ctx, stream),
  };
}

/** Maps the palette's actions onto the room (same commands the old RoomToolbar/ComboBox used) */
export function usePickerActions(room: Room): PickerActions {
  const { cmd, playlist, store, share, clientId } = room;
  const sharer = findSharer(room.state.participants);
  const sharing: PickerActions["sharing"] = room.state.isPublishing
    ? "me"
    : sharer
      ? sharer.id === clientId
        ? "me"
        : "other"
      : "none";
  const currentMeta = room.state.videoMeta;
  return useMemo<PickerActions>(
    () => ({
      playUrl: (url, opts) => {
        cmd.setMedia(url);
        saveRecent({
          kind: "url",
          url,
          name: opts?.name ?? url,
          img: opts?.img,
          at: Date.now(),
        });
      },
      queueUrl: (url, opts) => {
        if (opts?.name) {
          playlist.addItem({ url, name: opts.name, img: opts.img });
        } else {
          playlist.add(url);
        }
      },
      playStream: (stream, ctx) => {
        const item = streamItem(stream, ctx);
        cmd.setMedia(item.url);
        cmd.setVideoMeta(item.url, item.meta);
        saveRecent({ kind: "title", context: ctx, at: Date.now() });
      },
      queueStream: (stream, ctx) => {
        const item = streamItem(stream, ctx);
        playlist.addItem({
          url: item.url,
          name: item.name,
          img: item.meta.poster ?? undefined,
          meta: item.meta,
        });
      },
      shareScreen: () => store.set({ isScreenShareModalOpen: true }),
      shareFile: () => store.set({ isFileShareModalOpen: true }),
      stopSharing: () => share.stopPublishing(),
      sharing,
      currentMeta,
    }),
    [cmd, playlist, store, share, sharing, currentMeta],
  );
}

/** Shows REC:playbackIssue to everyone, with ways out: pick another stream, or share a converted one */
function usePlaybackIssueToasts(room: Room) {
  const ui = useRoomUi();
  const issue = room.state.playbackIssue;
  const latest = useRef({ room, ui });
  latest.current = { room, ui };
  useEffect(() => {
    if (!issue) {
      return;
    }
    const { room, ui } = latest.current;
    const { videoMeta, roomMedia, playback } = room.store.get();
    const mine = issue.userId === room.clientId;
    const actions: ToastAction[] = [];
    if (videoMeta) {
      actions.push({
        label: "Pick another",
        onClick: () => ui.openPickerAt({ kind: "streams", videoMeta }),
      });
    }
    // Someone else can't play it, but this device can: offer to convert once and stream it to them
    const thisDeviceCanPlay =
      playback?.mode === "direct" || playback?.mode === "convert";
    if (
      !mine &&
      thisDeviceCanPlay &&
      isDirectVideoUrl(roomMedia) &&
      isClientTranscodeSupported()
    ) {
      actions.push({
        label: "Share converted stream",
        onClick: () => {
          const time = room.player.html().getVideoEl()?.currentTime ?? 0;
          room.share.startUrlShare(roomMedia, {
            startTime: time,
            meta: videoMeta,
          });
        },
      });
    }
    toast(
      `${mine ? "You" : issue.name} can't play this stream: ${issue.reason}`,
      {
        tone: "warning",
        id: `wp-issue-${issue.userId}`,
        actions,
        duration: actions.length ? 10000 : 6000,
      },
    );
  }, [issue]);
}
