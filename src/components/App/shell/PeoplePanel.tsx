import React, { useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Popover,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowsShuffle,
  IconCopy,
  IconFile,
  IconPencil,
  IconScreenShare,
} from "@tabler/icons-react";
import { generateName } from "../../../utils/generateName";
import { isFileShare } from "../../../utils/utils";
import { UserAvatar } from "../../Avatar/Avatar";
import type { Room } from "../hooks/useRoom";
import { copyInviteLink, inviteLink } from "./invite";
import { describePlayback } from "./roomInfo";
import styles from "./Shell.module.css";

const NAME_MAX = 50;

/** Invite box, then everyone in the room with their sharing and playback state. You can rename yourself here. */
export const PeoplePanel = ({ room }: { room: Room }) => {
  const { state, clientId, player } = room;
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
            <Button
              size="compact-sm"
              leftSection={<IconCopy size={14} />}
              onClick={() => copyInviteLink(link)}
            >
              Copy
            </Button>
          </div>
          <div className={styles.inviteHint}>
            They'll need the instance password once.
          </div>
        </div>
        <div className={styles.sectionLabel}>
          In the room · {state.participants.length}
        </div>
        <ul className={styles.people}>
          {people.map((p) => {
            const isMe = p.id === clientId;
            const name = state.nameMap[p.id] || "Someone";
            const playback = describePlayback({
              ts: state.tsMap[p.id],
              referenceTs,
              hasMedia,
              hasDuration,
            });
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
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

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
