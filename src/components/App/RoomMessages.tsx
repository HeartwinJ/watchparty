import React, { useEffect } from "react";
import { Button, Loader } from "@mantine/core";
import {
  IconAlertTriangle,
  IconHome,
  IconRefresh,
  IconWifiOff,
} from "@tabler/icons-react";
import { navigate } from "../../router";
import { ScreenShareModal } from "../Modal/ScreenShareModal";
import { FileShareModal } from "../Modal/FileShareModal";
import { SubtitleModal } from "../Modal/SubtitleModal";
import { SubtitleSearch } from "./subtitleSearch/SubtitleSearch";
import type { Room } from "./hooks/useRoom";
import { toast } from "./ui/toast";
import styles from "./shell/Shell.module.css";

/**
 * The share/subtitle modals (owned by the player and picker work), the loading and error overlays, the
 * reconnecting banner, and toasts for the server's error/success messages.
 */
export const RoomMessages = ({ room }: { room: Room }) => {
  const { state, store } = room;

  useEffect(() => {
    if (state.errorMessage) {
      toast(state.errorMessage, { tone: "danger" });
    }
  }, [state.errorMessage]);
  useEffect(() => {
    if (state.successMessage) {
      toast(state.successMessage, { tone: "success" });
    }
  }, [state.successMessage]);

  return (
    <React.Fragment>
      {state.isScreenShareModalOpen && (
        <ScreenShareModal
          closeModal={() => store.set({ isScreenShareModalOpen: false })}
          startScreenShare={room.share.startScreenShare}
        />
      )}
      {state.isFileShareModalOpen && (
        <FileShareModal
          closeModal={() => store.set({ isFileShareModalOpen: false })}
          startFileShare={room.share.startFileShare}
        />
      )}
      {state.isSubtitleModalOpen && (
        <SubtitleModal
          closeModal={() => store.set({ isSubtitleModalOpen: false })}
          setRoomSubtitle={room.cmd.setSubtitle}
          roomSubtitle={state.roomSubtitle}
          roomMedia={state.roomMedia}
          getMediaDisplayName={room.getMediaDisplayName}
          setSubtitleMode={room.player.current().setSubtitleMode}
          getSubtitleMode={room.player.current().getSubtitleMode}
        />
      )}
      <SubtitleSearch
        opened={state.isSubtitleSearchOpen}
        onClose={() => store.set({ isSubtitleSearchOpen: false })}
        mediaUrl={state.roomMedia}
        videoMeta={state.videoMeta}
        setRoomSubtitle={room.cmd.setSubtitle}
        openFileNameSearch={room.subtitles.openModal}
      />
      {state.warningMessage && !state.overlayMsg && (
        <div className={styles.banner} role="status">
          <IconWifiOff size={16} aria-hidden="true" />
          {state.warningMessage}
        </div>
      )}
      {state.connection === "starting" && !state.overlayMsg && (
        <div className={styles.overlay} role="status" aria-live="polite">
          <Loader size="md" />
          <div className={styles.overlayText}>Joining the room…</div>
        </div>
      )}
      {state.overlayMsg && (
        <div className={styles.overlay}>
          <div
            className={styles.errorCard}
            role="alertdialog"
            aria-labelledby="room-error-title"
          >
            <IconAlertTriangle
              size={28}
              className={styles.errorIcon}
              aria-hidden="true"
            />
            <h2 id="room-error-title" className={styles.errorTitle}>
              {state.overlayMsg}
            </h2>
            <p className={styles.errorText}>
              Check your connection, then try again.
            </p>
            <div className={styles.errorActions}>
              <Button
                leftSection={<IconRefresh size={16} />}
                onClick={() => window.location.reload()}
                data-autofocus
              >
                Try again
              </Button>
              <Button
                variant="default"
                leftSection={<IconHome size={16} />}
                onClick={() => navigate("/")}
              >
                Go home
              </Button>
            </div>
          </div>
        </div>
      )}
    </React.Fragment>
  );
};
