import { useState, type PointerEvent } from "react";
import {
  ActionIcon,
  Button,
  Drawer,
  Indicator,
  Popover,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronDown,
  IconHeadset,
  IconMicrophone,
  IconMicrophoneOff,
  IconVideo,
  IconVideoOff,
} from "@tabler/icons-react";
import { AvatarStack } from "../../Avatar/Avatar";
import type { Room } from "../hooks/useRoom";
import { inCall, memberConnection } from "./callReducer";
import { CAMERA_KEY, PTT_KEY } from "./logic";
import { CallPanel } from "./CallPanel";
import styles from "./Call.module.css";

/**
 * The voice call in the room's top bar: "Voice" with who's in the call (opens the call panel), and once joined a
 * mic button (mute toggle, or hold-to-talk with push-to-talk on). Phones get the panel as a bottom drawer.
 */
export const CallControl = ({
  room,
  isPhone,
}: {
  room: Room;
  isPhone: boolean;
}) => {
  const { state, clientId, call } = room;
  const c = state.call;
  const joined = inCall(c);
  const [open, setOpen] = useState(false);
  const people = c.members.map((m) => ({
    id: m.clientId,
    name: state.nameMap[m.clientId],
    picture: state.pictureMap[m.clientId],
  }));
  const reconnecting =
    joined &&
    (c.status === "joining" ||
      c.members.some(
        (m) => memberConnection(c, m, clientId) === "reconnecting",
      ));
  const label = joined
    ? `Voice call, ${c.members.length} in the call${reconnecting ? ", reconnecting" : ""}`
    : c.members.length
      ? `Voice call, ${c.members.length} in the call. Join`
      : "Voice call";

  const trigger = isPhone ? (
    <Indicator
      disabled={!c.members.length || joined}
      label={c.members.length}
      size={16}
      offset={4}
      color="copper"
    >
      <ActionIcon
        variant={joined ? "light" : "default"}
        color={joined ? "copper" : undefined}
        size={36}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        <IconHeadset size={18} />
      </ActionIcon>
    </Indicator>
  ) : (
    <Indicator
      disabled={!reconnecting}
      color="var(--wp-warning)"
      size={8}
      offset={4}
      processing
    >
      <Button
        variant={joined ? "light" : "default"}
        color={joined ? "copper" : undefined}
        size="sm"
        h={30}
        px={10}
        className={styles.trigger}
        leftSection={<IconHeadset size={16} />}
        rightSection={joined ? <IconChevronDown size={14} /> : undefined}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {people.length > 0 ? (
          <AvatarStack users={people} size={20} max={3} speaking={c.speaking} />
        ) : (
          <span className={styles.triggerLabel}>Voice</span>
        )}
      </Button>
    </Indicator>
  );

  return (
    <span className={styles.control}>
      {joined && !isPhone && <CameraButton room={room} />}
      {joined && <MicButton room={room} />}
      {isPhone ? (
        <>
          {trigger}
          <Drawer
            opened={open}
            onClose={() => setOpen(false)}
            position="bottom"
            size="auto"

            withCloseButton
            zIndex={400}
          >
            <CallPanel room={room} />
          </Drawer>
        </>
      ) : (
        <Popover
          opened={open}
          onChange={setOpen}
          position="bottom-end"
          width={320}
          withinPortal
          zIndex={400}
          trapFocus={false}
        >
          <Popover.Target>{trigger}</Popover.Target>
          <Popover.Dropdown>
            <CallPanel room={room} />
          </Popover.Dropdown>
        </Popover>
      )}
    </span>
  );
};

/** Camera on/off (V). Desktop only: phones have it in the call panel, to keep the top bar short. */
const CameraButton = ({ room }: { room: Room }) => {
  const c = room.state.call;
  const on = c.camera;
  return (
    <Tooltip
      label={`${on ? "Turn camera off" : "Turn camera on"} (${CAMERA_KEY.toUpperCase()})`}
    >
      <ActionIcon
        variant={on ? "light" : "default"}
        color={on ? "copper" : undefined}
        size={36}
        loading={c.cameraBusy}
        aria-label={on ? "Turn camera off" : "Turn camera on"}
        aria-pressed={on}
        aria-keyshortcuts={CAMERA_KEY}
        onClick={() => void room.call.toggleCamera()}
      >
        {on ? (
          <IconVideo size={18} className={styles.camOn} />
        ) : (
          <IconVideoOff size={18} />
        )}
      </ActionIcon>
    </Tooltip>
  );
};

/** Mute toggle (M), or with push-to-talk a button to hold */
const MicButton = ({ room }: { room: Room }) => {
  const c = room.state.call;
  if (c.pushToTalk) {
    const hold = (e: PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      room.call.pttDown();
    };
    return (
      <Tooltip label={`Hold to talk (or hold ${PTT_KEY.toUpperCase()})`}>
        <ActionIcon
          variant="default"
          size={36}
          className={styles.ptt}
          data-held={c.pttHeld || undefined}
          aria-label="Hold to talk"
          aria-pressed={c.pttHeld}
          onPointerDown={hold}
          onPointerUp={room.call.pttUp}
          onPointerCancel={room.call.pttUp}
          onLostPointerCapture={room.call.pttUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {c.pttHeld ? (
            <IconMicrophone size={18} />
          ) : (
            <IconMicrophoneOff size={18} />
          )}
        </ActionIcon>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={c.muted ? "Unmute (M)" : "Mute (M)"}>
      <ActionIcon
        variant={c.muted ? "light" : "default"}
        color={c.muted ? "var(--wp-danger)" : undefined}
        size={36}
        aria-label={c.muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={c.muted}
        aria-keyshortcuts="m"
        onClick={() => room.call.toggleMute()}
      >
        {c.muted ? (
          <IconMicrophoneOff size={18} className={styles.micOff} />
        ) : (
          <IconMicrophone size={18} className={styles.micOn} />
        )}
      </ActionIcon>
    </Tooltip>
  );
};
