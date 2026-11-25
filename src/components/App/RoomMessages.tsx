import React from "react";
import { Alert, Overlay, Title } from "@mantine/core";
import { ErrorModal } from "../Modal/ErrorModal";
import { ScreenShareModal } from "../Modal/ScreenShareModal";
import { FileShareModal } from "../Modal/FileShareModal";
import { SubtitleModal } from "../Modal/SubtitleModal";
import { SettingsModal } from "../Settings/SettingsModal";
import type { Room } from "./hooks/useRoom";
import styles from "./App.module.css";

/** Modals, the loading/error overlays and the error/success/reconnecting alerts. */
export const RoomMessages = ({ room }: { room: Room }) => {
  const { state, store } = room;
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
      {state.connection === "starting" && (
        <Overlay className={styles.flexCenter}>
          <Title order={2}>Loading...</Title>
        </Overlay>
      )}
      {state.overlayMsg && <ErrorModal error={state.overlayMsg} />}
      <SettingsModal
        modalOpen={state.settingsModalOpen}
        setModalOpen={(settingsModalOpen) => store.set({ settingsModalOpen })}
      />
      {state.errorMessage && (
        <Alert
          title="Error"
          color="red"
          style={{
            position: "fixed",
            bottom: "10px",
            right: "10px",
            zIndex: 1000,
          }}
        >
          {state.errorMessage}
        </Alert>
      )}
      {state.successMessage && (
        <Alert
          title="Success"
          color="green"
          style={{
            position: "fixed",
            bottom: "10px",
            right: "10px",
            zIndex: 1000,
          }}
        >
          {state.successMessage}
        </Alert>
      )}
      {state.warningMessage && (
        <Alert
          color="yellow"
          style={{
            position: "fixed",
            top: "10px",
            left: "50%",
            transform: "translate(-50%, 0)",
            zIndex: 1000,
          }}
        >
          {state.warningMessage}
        </Alert>
      )}
    </React.Fragment>
  );
};
