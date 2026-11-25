import React, { useState } from "react";
import { Modal, Switch } from "@mantine/core";
import { getCurrentSettings, updateSettings } from "./LocalSettings";
import styles from "./Settings.module.css";

interface SettingsModalProps {
  modalOpen: boolean;
  setModalOpen: (open: boolean) => void;
}

export const SettingsModal = ({
  modalOpen,
  setModalOpen,
}: SettingsModalProps) => {
  const [, setUpdateTS] = useState(0);
  return (
    <Modal
      opened={modalOpen}
      onClose={() => setModalOpen(false)}
      centered
      title={"Settings"}
    >
      <div>
        <div className={styles.sectionHeader}>Local Settings</div>
        <div style={{ marginTop: "4px", width: "100%" }}>
          <Switch
            label="Disable chat notification sound"
            description="Don't play a sound when a chat message is sent while you're on another tab"
            checked={Boolean(getCurrentSettings().disableChatSound)}
            onChange={(e) => {
              updateSettings(
                JSON.stringify({
                  ...getCurrentSettings(),
                  disableChatSound: e.currentTarget.checked,
                }),
              );
              setUpdateTS(Date.now());
            }}
          />
        </div>
      </div>
    </Modal>
  );
};
