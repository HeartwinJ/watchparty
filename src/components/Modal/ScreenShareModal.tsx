import React from "react";
import { Modal, Button } from "@mantine/core";

export const ScreenShareModal = ({
  closeModal,
  startScreenShare,
}: {
  closeModal: () => void;
  startScreenShare: () => void;
}) => {
  return (
    <Modal
      opened={true}
      onClose={closeModal}
      title="Share your screen"
      centered
      size="auto"
    >
      <div>You're about to share your screen.</div>
      <ul>
        <li>This feature is only supported on Chrome and Edge on desktop.</li>
        <li>
          Audio sharing only works if sharing your entire screen or a browser
          tab, not an application.
        </li>
        <li>
          Your video is streamed to each viewer from your device (about 5 Mbps
          upload per viewer).
        </li>
      </ul>
      <Button
        onClick={() => {
          startScreenShare();
          closeModal();
        }}
      >
        Start Screenshare
      </Button>
    </Modal>
  );
};
