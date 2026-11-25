import React, { useState } from "react";
import { Modal, Button, Checkbox } from "@mantine/core";
import {
  IconDeviceDesktop,
  IconFileUpload,
  IconUpload,
} from "@tabler/icons-react";
import { isClientTranscodeSupported } from "../../utils/clientTranscode";
import styles from "./ShareModal.module.css";

export const FileShareModal = (props: {
  closeModal: () => void;
  startFileShare: (options?: { convert?: boolean }) => void;
}) => {
  const { closeModal } = props;
  const [convert, setConvert] = useState(false);
  const canConvert = isClientTranscodeSupported();
  return (
    <Modal
      opened
      onClose={closeModal}
      title={
        <span className={styles.title}>
          <span className={styles.titleIcon}>
            <IconFileUpload size={20} />
          </span>
          Share a file
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
        Pick a video on this device and everyone watches it with you.
      </p>
      <ul className={styles.notes}>
        <li>
          <IconUpload size={16} />
          Your video goes to each viewer from this device (about 5 Mbps upload
          per viewer).
        </li>
        <li>
          <IconDeviceDesktop size={16} />
          Keep this tab open while sharing.
        </li>
      </ul>
      <div className={styles.option}>
        <Checkbox
          disabled={!canConvert}
          checked={convert}
          onChange={(e) => setConvert(e.currentTarget.checked)}
          label="Convert on this device before sharing"
          description={
            canConvert
              ? "Use it if the video or audio doesn't come through (e.g. MKV, HEVC, AC-3). Uses your CPU/GPU, and lets you pick between audio tracks."
              : "Your browser doesn't support WebCodecs, which converting needs."
          }
        />
      </div>
      <div className={styles.actions}>
        <Button variant="default" onClick={closeModal}>
          Cancel
        </Button>
        <Button
          data-autofocus
          leftSection={<IconFileUpload size={16} />}
          onClick={() => {
            props.startFileShare({ convert });
            props.closeModal();
          }}
        >
          Choose file
        </Button>
      </div>
    </Modal>
  );
};
