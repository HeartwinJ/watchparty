import { useState } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { Button, Modal, Switch, TextInput } from "@mantine/core";
import { isClientTranscodeSupported } from "../../../utils/clientTranscode";
import {
  getCurrentSettings,
  updateSettings,
} from "../../Settings/LocalSettings";
import type { Room } from "../hooks/useRoom";
import { useRoomUi } from "../ui/RoomUi";
import styles from "./Shell.module.css";

/**
 * Room settings. "On this device" settings apply immediately and are stored per device.
 * The room-wide section (title, ready check, next-episode offset) waits for server support (wave 2).
 */
export const RoomSettingsModal = ({ room }: { room: Room }) => {
  const ui = useRoomUi();
  const { state } = room;
  // On phones the modal is a bottom sheet
  const isPhone = useMediaQuery("(max-width: 768px)", false, {
    getInitialValueInEffect: false,
  });
  // LocalSettings lives in localStorage (not React state), so re-render on change
  const [, setVersion] = useState(0);
  const settings = getCurrentSettings();
  const setLocal = (patch: Partial<Settings>) => {
    updateSettings(JSON.stringify({ ...getCurrentSettings(), ...patch }));
    setVersion((v) => v + 1);
  };

  return (
    <Modal
      opened={ui.settingsOpen}
      onClose={ui.closeSettings}
      title="Room settings"
      centered={!isPhone}
      radius="xl"
      size={isPhone ? "100%" : 460}
      zIndex={400}
      transitionProps={isPhone ? { transition: "slide-up" } : undefined}
      classNames={{
        title: styles.modalTitle,
        body: styles.modalBody,
        inner: isPhone ? styles.sheetInner : undefined,
        content: isPhone ? styles.sheetContent : undefined,
      }}
    >
      <div className={styles.settingsSection}>
        <div className={styles.sectionLabelFlat}>On this device</div>
        <Switch
          labelPosition="left"
          classNames={{ root: styles.switchRow, body: styles.switchBody }}
          label="Message sound"
          description="Play a sound for new chat messages while you're in another tab."
          checked={!settings.disableChatSound}
          onChange={(e) =>
            setLocal({ disableChatSound: !e.currentTarget.checked })
          }
        />
        <Switch
          labelPosition="left"
          classNames={{ root: styles.switchRow, body: styles.switchBody }}
          label="Chat bubbles over video"
          description="Show new messages on the video when the sidebar is hidden or in fullscreen."
          checked={ui.chatOverlayEnabled}
          onChange={(e) => ui.setChatOverlayEnabled(e.currentTarget.checked)}
        />
        {isClientTranscodeSupported() && (
          <Switch
            labelPosition="left"
            classNames={{ root: styles.switchRow, body: styles.switchBody }}
            label="Auto-convert when needed"
            description="Convert links your browser can't play (e.g. AC3 audio or MKV) on this device. Uses CPU/GPU, and lets you pick between audio tracks."
            checked={state.convertEnabled}
            onChange={(e) =>
              room.convert.setConvertEnabled(e.currentTarget.checked)
            }
          />
        )}
      </div>

      {/* TODO(wave 2): room-wide settings need server support (stored in room state, a system message on save). */}
      {false && (
        <div className={styles.settingsSection}>
          <div className={styles.sectionLabelFlat}>Everyone in this room</div>
          <TextInput
            label="Room title"
            description="Shown in the top bar and in everyone's recent rooms."
            maxLength={60}
          />
          <Switch
            labelPosition="left"
            classNames={{ root: styles.switchRow, body: styles.switchBody }}
            label="Ready check"
            description="When someone is buffering or joins mid-play, pause for everyone and resume once all viewers have enough buffered."
          />
          <TextInput
            label="Next-episode card"
            description="Seconds before the end to offer the next episode."
            type="number"
            defaultValue={25}
          />
        </div>
      )}

      <div className={styles.modalFoot}>
        <Button onClick={ui.closeSettings}>Done</Button>
      </div>
    </Modal>
  );
};
