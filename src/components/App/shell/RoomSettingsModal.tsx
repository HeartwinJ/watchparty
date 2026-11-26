import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@mantine/hooks";
import {
  ActionIcon,
  Button,
  Chip,
  Group,
  Input,
  Modal,
  NumberInput,
  Switch,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconCopy,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconRefresh,
} from "@tabler/icons-react";
import { useAuth } from "../../AuthGate/AuthGate";
import { copyText } from "./invite";
import { isClientTranscodeSupported } from "../../../utils/clientTranscode";
import {
  getCurrentSettings,
  updateSettings,
} from "../../Settings/LocalSettings";
import type { Room } from "../hooks/useRoom";
import { useRoomUi } from "../ui/RoomUi";
import { toast } from "../ui/toast";
import { prettyRoomName } from "../../../utils/rooms";
import {
  NEXT_EPISODE_OFFSET_MAX,
  NEXT_EPISODE_OFFSET_MIN,
  offsetToSend,
  ROOM_PASSWORD_MAX,
  ROOM_PASSWORD_MIN,
  ROOM_TITLE_MAX,
  roomPasswordToSend,
  SKIP_INTRO_CUSTOM_MAX,
  SKIP_INTRO_CUSTOM_MIN,
  skipIntroChip,
  skipIntroToSend,
  titleToSend,
} from "./roomSettingsForm";
import {
  formatSkipIntro,
  SKIP_INTRO_PRESETS,
  skipIntroPresetLabel,
} from "../logic/introSkip";
import styles from "./Shell.module.css";

/**
 * Room settings. "On this device" settings apply immediately and are stored per device. "Everyone in this room"
 * (title, ready check, next-episode offset, room password) is for owners only: it's sent with CMD:roomSettings /
 * CMD:roomPassword and applies for everyone right away. Guests only see a note.
 */
export const RoomSettingsModal = ({
  room,
  roomId,
}: {
  room: Room;
  roomId: string;
}) => {
  const ui = useRoomUi();
  const { role } = useAuth();
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

      {role === "owner" ? (
        <RoomWideSettings room={room} roomId={roomId} />
      ) : (
        <div className={styles.settingsSection}>
          <div className={styles.sectionLabelFlat}>Everyone in this room</div>
          <p className={styles.settingsNote}>
            Only the room's owner can change the title, the ready check, the
            next-episode card, skip intro and the room password.
          </p>
          <p className={styles.settingsNote}>
            Skip intro:{" "}
            {state.roomSettings.skipIntro
              ? `videos start at ${formatSkipIntro(state.roomSettings.skipIntro)}`
              : "off"}
          </p>
        </div>
      )}

      <div className={styles.modalFoot}>
        <Button onClick={ui.closeSettings}>Done</Button>
      </div>
    </Modal>
  );
};

/** How long the next-episode input waits after the last keystroke/step before telling the room */
const OFFSET_SEND_DELAY_MS = 500;

/**
 * Room-wide settings (CMD:roomSettings). The title is sent on blur/Enter, the switch immediately and the offset
 * shortly after it stops changing. The inputs follow REC:roomSettings whenever they aren't being edited, so changes
 * from other people show up live.
 */
const RoomWideSettings = ({ room, roomId }: { room: Room; roomId: string }) => {
  const { roomSettings, socketConnected } = room.state;
  const { setRoomSettings } = room.cmd;

  const send = (patch: Partial<RoomSettings>) => {
    if (!socketConnected) {
      toast("Not connected to the room right now. Try again in a moment.", {
        id: "wp-room-settings",
        tone: "warning",
      });
      return false;
    }
    setRoomSettings(patch);
    return true;
  };

  // Title: a local draft while editing
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const saveTitle = () => {
    if (titleDraft === null) {
      return;
    }
    const title = titleToSend(titleDraft, roomSettings.title);
    if (title !== undefined) {
      send({ title });
    }
    setTitleDraft(null);
  };

  // Next-episode offset: a local draft while editing, sent after a short pause
  const [offsetDraft, setOffsetDraft] = useState<string | number | null>(null);
  const offsetTimer = useRef<number | undefined>(undefined);
  const sendOffset = (value: string | number) => {
    window.clearTimeout(offsetTimer.current);
    const offset = offsetToSend(value, roomSettings.nextEpisodeOffset);
    if (offset !== undefined) {
      send({ nextEpisodeOffset: offset });
    }
  };
  useEffect(() => () => window.clearTimeout(offsetTimer.current), []);

  return (
    <div className={styles.settingsSection}>
      <div className={styles.sectionLabelFlat}>Everyone in this room</div>
      <TextInput
        label="Room title"
        description="Shown in the top bar and in everyone's recent rooms. Leave empty to use the generated name."
        placeholder={prettyRoomName(roomId)}
        maxLength={ROOM_TITLE_MAX}
        value={titleDraft ?? roomSettings.title}
        // The modal closes on Escape in a window capture listener, so stopPropagation() can't stop it; this can
        data-mantine-stop-propagation={titleDraft !== null || undefined}
        onChange={(e) => setTitleDraft(e.currentTarget.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            saveTitle();
          } else if (e.key === "Escape" && titleDraft !== null) {
            // Discard the draft instead of closing the modal
            e.stopPropagation();
            setTitleDraft(null);
          }
        }}
      />
      <Switch
        labelPosition="left"
        classNames={{ root: styles.switchRow, body: styles.switchBody }}
        label="Ready check"
        description="When someone is buffering or joins mid-play, pause for everyone and resume once all viewers have enough buffered."
        checked={roomSettings.readyCheck}
        onChange={(e) => send({ readyCheck: e.currentTarget.checked })}
      />
      <Switch
        labelPosition="left"
        classNames={{ root: styles.switchRow, body: styles.switchBody }}
        label="Auto-sync subtitles"
        description="When subtitles are loaded for a video, match them to the speech once (one viewer's device listens) and set the offset for everyone. An offset someone set by hand is kept."
        checked={roomSettings.autoSyncSubtitles}
        onChange={(e) => send({ autoSyncSubtitles: e.currentTarget.checked })}
      />
      <NumberInput
        label="Next-episode card"
        description={`Seconds before the end of an episode to offer the next one (${NEXT_EPISODE_OFFSET_MIN}–${NEXT_EPISODE_OFFSET_MAX}).`}
        min={NEXT_EPISODE_OFFSET_MIN}
        max={NEXT_EPISODE_OFFSET_MAX}
        step={5}
        allowDecimal={false}
        allowNegative={false}
        clampBehavior="blur"
        suffix=" s"
        value={offsetDraft ?? roomSettings.nextEpisodeOffset}
        onChange={(value) => {
          setOffsetDraft(value);
          window.clearTimeout(offsetTimer.current);
          offsetTimer.current = window.setTimeout(
            () => sendOffset(value),
            OFFSET_SEND_DELAY_MS,
          );
        }}
        onBlur={() => {
          if (offsetDraft !== null) {
            sendOffset(offsetDraft);
            setOffsetDraft(null);
          }
        }}
      />
      <SkipIntroSetting
        value={roomSettings.skipIntro}
        onChange={(skipIntro) => send({ skipIntro })}
      />
      <RoomPasswordSettings room={room} />
    </div>
  );
};

/**
 * Skip intro: preset chips (Off, 15s … 2:00) plus Custom with a seconds input (1–600). A chip is sent right away;
 * the custom value after it stops changing (or on blur).
 */
export const SkipIntroSetting = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (seconds: number) => void;
}) => {
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState<string | number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const sendCustom = (v: string | number) => {
    window.clearTimeout(timer.current);
    const seconds = skipIntroToSend(v, value);
    if (seconds !== undefined) {
      onChange(seconds);
    }
  };
  const chip = skipIntroChip(value, customOpen);
  const shown = draft ?? (value || "");
  const preview = Number(shown);
  return (
    <Input.Wrapper
      label="Skip intro"
      description="Every video the room switches to from the beginning (a pick, the queue, the next episode) starts this far in. Not for resumed videos, screen/file shares, live streams or short videos (under 5 minutes or twice the skip)."
    >
      <Chip.Group
        multiple={false}
        value={chip}
        onChange={(v) => {
          if (v === "custom") {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          setDraft(null);
          const seconds = Number(v);
          if (seconds !== value) {
            onChange(seconds);
          }
        }}
      >
        <Group gap={6} mt={8}>
          {SKIP_INTRO_PRESETS.map((s) => (
            <Chip key={s} value={String(s)} size="xs">
              {skipIntroPresetLabel(s)}
            </Chip>
          ))}
          <Chip value="custom" size="xs">
            Custom
          </Chip>
        </Group>
      </Chip.Group>
      {chip === "custom" && (
        <NumberInput
          mt={8}
          aria-label="Custom skip intro in seconds"
          description={
            Number.isFinite(preview) && preview > 0
              ? `Starts at ${formatSkipIntro(Math.min(SKIP_INTRO_CUSTOM_MAX, preview))}`
              : `${SKIP_INTRO_CUSTOM_MIN}–${SKIP_INTRO_CUSTOM_MAX} seconds`
          }
          inputWrapperOrder={["input", "description"]}
          min={SKIP_INTRO_CUSTOM_MIN}
          max={SKIP_INTRO_CUSTOM_MAX}
          step={5}
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="blur"
          suffix=" s"
          placeholder="Seconds"
          value={shown}
          onChange={(v) => {
            setDraft(v);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(
              () => sendCustom(v),
              OFFSET_SEND_DELAY_MS,
            );
          }}
          onBlur={() => {
            if (draft !== null) {
              sendCustom(draft);
              setDraft(null);
            }
          }}
        />
      )}
    </Input.Wrapper>
  );
};

/**
 * The room password (owners only): masked with a reveal toggle, copy, regenerate, set your own, and on/off. A new
 * password or turning it on signs every guest out (the server revokes their access).
 */
export const RoomPasswordSettings = ({ room }: { room: Room }) => {
  const { roomAccess: access, socketConnected } = room.state;
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  if (!access) {
    return null;
  }
  const send = (cmd: Parameters<Room["cmd"]["setRoomPassword"]>[0]) => {
    if (!socketConnected) {
      toast("Not connected to the room right now. Try again in a moment.", {
        id: "wp-room-settings",
        tone: "warning",
      });
      return false;
    }
    room.cmd.setRoomPassword(cmd);
    return true;
  };
  const toSave = draft === null ? undefined : roomPasswordToSend(draft);
  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (toSave !== undefined && send({ action: "set", password: toSave })) {
      setDraft(null);
      setRevealed(true);
    }
  };

  return (
    <div className={styles.passwordBox}>
      <Switch
        labelPosition="left"
        classNames={{ root: styles.switchRow, body: styles.switchBody }}
        label="Require a password"
        description={
          access.enabled
            ? "Guests with the link type this password once. You never need it."
            : "Anyone with the link can join. Turning this on signs out guests who joined without it."
        }
        checked={access.enabled}
        onChange={(e) =>
          send({ action: "enable", enabled: e.currentTarget.checked })
        }
      />
      {access.enabled && access.password && draft === null && (
        <>
          <div className={styles.passwordLabel}>Room password</div>
          <div className={styles.passwordValueRow}>
            <code
              className={styles.passwordValue}
              aria-label={revealed ? "Room password" : "Room password (hidden)"}
            >
              {revealed ? access.password : "•".repeat(12)}
            </code>
            <Tooltip label={revealed ? "Hide" : "Show"} openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={revealed ? "Hide password" : "Show password"}
                onClick={() => setRevealed((r) => !r)}
              >
                {revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Copy" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Copy password"
                onClick={() => copyText(access.password!, "Password")}
              >
                <IconCopy size={16} />
              </ActionIcon>
            </Tooltip>
          </div>
          <div className={styles.passwordActions}>
            <Button
              variant="default"
              size="compact-sm"
              leftSection={<IconRefresh size={14} />}
              onClick={() => {
                if (send({ action: "regenerate" })) {
                  setRevealed(true);
                }
              }}
            >
              Regenerate
            </Button>
            <Button
              variant="default"
              size="compact-sm"
              leftSection={<IconPencil size={14} />}
              onClick={() => setDraft("")}
            >
              Set your own
            </Button>
          </div>
          <div className={styles.inviteHint}>
            Changing it signs out every guest until they enter the new one.
          </div>
        </>
      )}
      {draft !== null && (
        <form onSubmit={save}>
          <TextInput
            label="New room password"
            description={`${ROOM_PASSWORD_MIN}–${ROOM_PASSWORD_MAX} characters. Guests will need it to get back in.`}
            value={draft}
            maxLength={ROOM_PASSWORD_MAX * 2}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            data-mantine-stop-propagation
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Cancel the edit instead of closing the modal
                e.stopPropagation();
                setDraft(null);
              }
            }}
          />
          <Group justify="flex-end" mt="sm" gap="xs">
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={toSave === undefined}>
              Save password
            </Button>
          </Group>
        </form>
      )}
    </div>
  );
};
