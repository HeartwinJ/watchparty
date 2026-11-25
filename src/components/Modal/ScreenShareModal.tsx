import React from "react";
import { Modal, Button } from "@mantine/core";
import {
  IconBrowser,
  IconScreenShare,
  IconUpload,
  IconVolume,
} from "@tabler/icons-react";
import styles from "./ShareModal.module.css";

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
      title={
        <span className={styles.title}>
          <span className={styles.titleIcon}>
            <IconScreenShare size={20} />
          </span>
          Share your screen
        </span>
      }
      centered
      size={460}
      zIndex={410}
      classNames={{
        content: styles.content,
        header: styles.header,
        body: styles.body,
      }}
    >
      <p className={styles.lead}>
        Everyone in the room will see the window, tab or screen you pick.
      </p>
      <ul className={styles.notes}>
        <li>
          <IconBrowser size={16} />
          Works in Chrome and Edge on desktop.
        </li>
        <li>
          <IconVolume size={16} />
          Audio is shared only for a whole screen or a browser tab, not a single
          app window.
        </li>
        <li>
          <IconUpload size={16} />
          Your video goes to each viewer from this device (about 5 Mbps upload
          per viewer).
        </li>
      </ul>
      <div className={styles.actions}>
        <Button variant="default" onClick={closeModal}>
          Cancel
        </Button>
        <Button
          data-autofocus
          leftSection={<IconScreenShare size={16} />}
          onClick={() => {
            startScreenShare();
            closeModal();
          }}
        >
          Start sharing
        </Button>
      </div>
    </Modal>
  );
};
