import React, { useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Popover,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowsShuffle,
  IconCopy,
  IconDots,
  IconFile,
  IconHeadset,
  IconKey,
  IconMicrophoneOff,
  IconPencil,
  IconPhoneOff,
  IconScreenShare,
  IconUserX,
} from "@tabler/icons-react";
import { useAuth } from "../../AuthGate/AuthGate";
import { generateName } from "../../../utils/generateName";
import { isFileShare } from "../../../utils/utils";
import { UserAvatar } from "../../Avatar/Avatar";
import type { Room } from "../hooks/useRoom";
import {
  copyInviteLink,
  inviteLink,
  inviteLinkWithPassword,
  roomPassword,
} from "./invite";
import { describePlayback } from "./roomInfo";
import styles from "./Shell.module.css";

const NAME_MAX = 50;

/**
 * Invite box, then everyone in the room with their sharing and playback state. You can rename yourself here, and
 * owners can remove people (a removed guest loses access to the room).
 */
export const PeoplePanel = ({ room }: { room: Room }) => {
  const { state, clientId, player } = room;
  const isOwner = useAuth().role === "owner";
  const password = isOwner ? roomPassword(state.roomAccess) : undefined;
  const hasMedia = Boolean(state.roomMedia);
  const hasDuration = player.hasDuration();
  const referenceTs = hasDuration ? player.getLeaderTime() : undefined;
  // You first, then everyone else in join order
  const people = [...state.participants].sort(
    (a, b) => Number(b.id === clientId) - Number(a.id === clientId),
  );
  const link = inviteLink();

  return (
    <div className={styles.panelBody}>
      <div className={styles.scroll}>
        <div className={styles.inviteBox}>
          <div className={styles.inviteTitle}>Invite friends</div>
          <div className={styles.inviteRow}>
            <code className={styles.inviteLink} title={link}>
              {link.replace(/^https?:\/\//, "")}
            </code>
            {!password && (
              <Button
                size="compact-sm"
                leftSection={<IconCopy size={14} />}
                onClick={() => copyInviteLink(link)}
              >
                Copy
              </Button>
            )}
          </div>
          {password && (
            <div className={styles.inviteActions}>
              <Button
                size="compact-sm"
                leftSection={<IconCopy size={14} />}
                onClick={() => copyInviteLink(link)}
              >
                Copy link
              </Button>
              <Button
                size="compact-sm"
                variant="default"
                leftSection={<IconKey size={14} />}
                onClick={() =>
                  copyInviteLink(
                    inviteLinkWithPassword(password),
                    "Link with password copied",
                  )
                }
              >
                Copy with password
              </Button>
            </div>
          )}
          <div className={styles.inviteHint}>
            {state.roomAccess && !state.roomAccess.enabled
              ? "Anyone with the link can join."
              : password
                ? "With the plain link, they type the room password once."
                : "They'll need the room password once."}
          </div>
        </div>
        <div className={styles.sectionLabel}>
          In the room · {state.participants.length}
        </div>
        <ul className={styles.people}>
          {people.map((p) => {
            const isMe = p.id === clientId;
            const name = state.nameMap[p.id] || "Someone";
            const playback = state.readyCheck?.waitingFor.includes(p.id)
              ? { label: "Buffering…", tone: "warn" as const }
              : describePlayback({
                  ts: state.tsMap[p.id],
                  referenceTs,
                  hasMedia,
                  hasDuration,
                });
            const member = state.call.members.find((m) => m.clientId === p.id);
            const callMuted =
              member &&
              (isMe && state.call.status !== "idle"
                ? state.call.pushToTalk
                  ? !state.call.pttHeld
                  : state.call.muted
                : member.muted);
            const sharing = p.isScreenShare
              ? isFileShare(state.roomMedia)
                ? "Sharing a file"
                : "Sharing their screen"
              : null;
            return (
              <li key={p.id} className={styles.person}>
                <UserAvatar
                  id={p.id}
                  name={name}
                  picture={state.pictureMap[p.id]}
                  size={32}
                  presence
                  speaking={state.call.speaking.includes(p.id)}
                />
                <div className={styles.personInfo}>
                  <div className={styles.personName}>
                    <span className={styles.ellipsis}>{name}</span>
                    {isMe && <small> (you)</small>}
                  </div>
                  <div className={styles.personState}>
                    <span
                      className={styles.stateDot}
                      data-tone={playback.tone}
                      aria-hidden="true"
                    />
                    {playback.label}
                  </div>
                </div>
                {member && (
                  <Tooltip
                    label={
                      member.reconnecting
                        ? "In the voice call · reconnecting"
                        : callMuted
                          ? "In the voice call · muted"
                          : "In the voice call"
                    }
                  >
                    <span
                      className={callMuted ? styles.callMuted : styles.callIcon}
                      data-reconnecting={member.reconnecting || undefined}
                      aria-label={
                        callMuted
                          ? "In the voice call, muted"
                          : "In the voice call"
                      }
                    >
                      {callMuted ? (
                        <IconMicrophoneOff size={16} />
                      ) : (
                        <IconHeadset size={16} />
                      )}
                    </span>
                  </Tooltip>
                )}
                {sharing && (
                  <Tooltip label={sharing}>
                    <span className={styles.dim} aria-label={sharing}>
                      {isFileShare(state.roomMedia) ? (
                        <IconFile size={16} />
                      ) : (
                        <IconScreenShare size={16} />
                      )}
                    </span>
                  </Tooltip>
                )}
                {isMe && <EditName room={room} />}
                {!isMe && isOwner && (
                  <PersonMenu
                    name={name}
                    onKick={() => room.cmd.kickUser(p.id)}
                    call={
                      member
                        ? {
                            muted: member.muted,
                            onMute: () => room.call.moderate(p.id, "mute"),
                            onRemove: () => room.call.moderate(p.id, "remove"),
                          }
                        : undefined
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

/** Owners: actions on someone else (mute in / remove from the voice call, remove from the room) */
const PersonMenu = ({
  name,
  onKick,
  call,
}: {
  name: string;
  onKick: () => void;
  /** Set while they're in the voice call */
  call?: { muted: boolean; onMute: () => void; onRemove: () => void };
}) => (
  <Menu position="bottom-end" width={220} zIndex={400} withinPortal>
    <Menu.Target>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={30}
        aria-label={`Options for ${name}`}
      >
        <IconDots size={16} />
      </ActionIcon>
    </Menu.Target>
    <Menu.Dropdown>
      {call && (
        <>
          <Menu.Item
            leftSection={<IconMicrophoneOff size={16} />}
            disabled={call.muted}
            onClick={call.onMute}
          >
            Mute in call
            <div className={styles.menuHint}>They can unmute themselves</div>
          </Menu.Item>
          <Menu.Item
            leftSection={<IconPhoneOff size={16} />}
            onClick={call.onRemove}
          >
            Remove from call
          </Menu.Item>
          <Menu.Divider />
        </>
      )}
      <Menu.Item
        color="var(--wp-danger)"
        leftSection={<IconUserX size={16} />}
        onClick={onKick}
      >
        Remove from room
        <div className={styles.menuHint}>
          Guests can't come back until you change the password
        </div>
      </Menu.Item>
    </Menu.Dropdown>
  </Menu>
);

/** "You" popover: change your display name or pick a random one. */
const EditName = ({ room }: { room: Room }) => {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const open = () => {
    setDraft(room.state.myName);
    setOpened(true);
  };
  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    const name = draft.trim().slice(0, NAME_MAX);
    if (name && name !== room.state.myName) {
      room.updateName(name);
    }
    setOpened(false);
  };
  const randomize = async () => {
    setBusy(true);
    try {
      setDraft(await generateName());
    } catch {
      // Keep the current draft
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={260}
      trapFocus
      withinPortal
      zIndex={400}
    >
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={30}
          aria-label="Change your name"
          onClick={() => (opened ? setOpened(false) : open())}
        >
          <IconPencil size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <form onSubmit={save}>
          <TextInput
            label="Your name"
            value={draft}
            maxLength={NAME_MAX}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onFocus={(e) => e.currentTarget.select()}
            data-autofocus
            rightSection={
              <ActionIcon
                variant="subtle"
                color="gray"
                loading={busy}
                onClick={randomize}
                aria-label="Random name"
                title="Random name"
              >
                <IconArrowsShuffle size={16} />
              </ActionIcon>
            }
          />
          <Group justify="flex-end" mt="sm" gap="xs">
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => setOpened(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!draft.trim()}>
              Save
            </Button>
          </Group>
        </form>
      </Popover.Dropdown>
    </Popover>
  );
};
