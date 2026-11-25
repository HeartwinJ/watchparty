import React, { useState } from "react";
import { Modal, Button, Checkbox } from "@mantine/core";
import { isClientTranscodeSupported } from "../../utils/clientTranscode";

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
      title="Share a file"
      size="auto"
      centered
    >
      <div>You're about to share a file from your device.</div>
      <ul>
        <li>
          Your video is streamed to each viewer from your device (about 5 Mbps
          upload per viewer).
        </li>
      </ul>
      <Checkbox
        mb="md"
        disabled={!canConvert}
        checked={convert}
        onChange={(e) => setConvert(e.currentTarget.checked)}
        label="Convert video on my device before sharing (use if video or audio doesn't share)"
        description={
          canConvert
            ? "Converts to a web-compatible format, which uses your CPU/GPU. Also allows choosing between audio tracks of converted files (e.g. languages)."
            : "Your browser doesn't support WebCodecs, which is required for converting."
        }
      />
      <Button
        onClick={() => {
          props.startFileShare({ convert });
          props.closeModal();
        }}
      >
        Start Fileshare
      </Button>
    </Modal>
  );
};
