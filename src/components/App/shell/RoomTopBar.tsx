import {
  ActionIcon,
  Button,
  Indicator,
  Kbd,
  Menu,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconDots,
  IconKeyboard,
  IconLayoutSidebarRight,
  IconKey,
  IconLink,
  IconLogout,
  IconPencil,
  IconSearch,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { DeleteRoomModal } from "../../DeleteRoomModal/DeleteRoomModal";
import { navigate } from "../../../router";
import { roomDisplayName } from "../../../utils/rooms";
import { useAuth } from "../../AuthGate/AuthGate";
import { AvatarStack } from "../../Avatar/Avatar";
import { Brand } from "../../Brand/Brand";
import type { Room } from "../hooks/useRoom";
import { useRoomUi } from "../ui/RoomUi";
import { copyInviteLink, inviteLinkWithPassword, roomPassword } from "./invite";
import { shortMediaTitle } from "./roomInfo";
import { requestShortcutsOverlay } from "./shortcuts";
import styles from "./Shell.module.css";
import { SyncIndicator } from "../PlayerArea";
import { ConvertStatus } from "../picker/ConvertStatus";

/**
 * The room's top bar: home link, room name, the source-picker trigger, sync status, avatars, invite,
 * sidebar toggle and the overflow menu. On phones only the room name, sync, invite and menu remain.
 */
export const RoomTopBar = ({
  room,
  roomId,
  isPhone,
}: {
  room: Room;
  roomId: string;
  isPhone: boolean;
}) => {
  const { state } = room;
  const ui = useRoomUi();
  const { authRequired, logout, role } = useAuth();
  const isOwner = role === "owner";
  const title = shortMediaTitle(
    state.roomMedia,
    room.getMediaDisplayName(state.roomMedia),
  );
  const roomName = roomDisplayName(roomId, state.roomSettings.title);
  const people = state.participants.map((p) => ({
    id: p.id,
    name: state.nameMap[p.id],
    picture: state.pictureMap[p.id],
  }));
  const unread = ui.sidebarCollapsed && state.unreadCount > 0;
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <header className={styles.topbar}>
      {/* Guests can't go Home, so their logo isn't a link */}
      {!isPhone && <Brand showWord={false} link={isOwner} />}
      <UnstyledButton
        className={styles.roomName}
        onClick={ui.openSettings}
        title="Room settings"
      >
        <span className={styles.ellipsis}>{roomName}</span>
        {/* Guests can't rename the room (their settings are only "On this device") */}
        {isOwner && (
          <IconPencil size={14} aria-hidden="true" className={styles.dim} />
        )}
      </UnstyledButton>

      {!isPhone && (
        <UnstyledButton
          className={styles.pickerTrigger}
          onClick={ui.openPicker}
          aria-label={
            title
              ? `Now playing: ${title}. Change what's playing`
              : "Choose something to watch"
          }
          aria-keyshortcuts="/"
          title="Change what's playing (/)"
        >
          <IconSearch size={16} aria-hidden="true" />
          {title && (
            <>
              <span className={styles.now}>{title}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className={styles.placeholder}>
            {title ? "Play something else…" : "Paste a link or search…"}
          </span>
          <Kbd size="xs" className={styles.kbd}>
            /
          </Kbd>
        </UnstyledButton>
      )}

      <div className={styles.topbarRight}>
        <ConvertStatus status={room.convert.status} />
        <SyncIndicator room={room} />
        {!isPhone && people.length > 0 && (
          <span className={styles.avatars}>
            <AvatarStack users={people} />
          </span>
        )}
        <InviteButton
          isPhone={isPhone}
          password={isOwner ? roomPassword(state.roomAccess) : undefined}
        />
        {!isPhone && (
          <Tooltip
            label={ui.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            openDelay={400}
          >
            <Indicator
              disabled={!unread}
              size={8}
              offset={7}
              color="copper"
              processing={false}
            >
              <ActionIcon
                variant={ui.sidebarCollapsed ? "subtle" : "light"}
                color={ui.sidebarCollapsed ? "gray" : "copper"}
                size={36}
                onClick={ui.toggleSidebar}
                aria-label={
                  ui.sidebarCollapsed
                    ? `Show sidebar${unread ? `, ${state.unreadCount} unread messages` : ""}`
                    : "Hide sidebar"
                }
                aria-pressed={!ui.sidebarCollapsed}
              >
                <IconLayoutSidebarRight size={20} />
              </ActionIcon>
            </Indicator>
          </Tooltip>
        )}
        <Menu position="bottom-end" width={240} zIndex={400} withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={36}
              aria-label="More options"
            >
              <IconDots size={20} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconSearch size={16} />}
              rightSection={<Kbd size="xs">/</Kbd>}
              onClick={ui.openPicker}
            >
              Change video
            </Menu.Item>
            <Menu.Item
              leftSection={<IconSettings size={16} />}
              onClick={ui.openSettings}
            >
              Room settings
            </Menu.Item>
            <Menu.Item
              leftSection={<IconKeyboard size={16} />}
              rightSection={<Kbd size="xs">?</Kbd>}
              onClick={requestShortcutsOverlay}
            >
              Keyboard shortcuts
            </Menu.Item>
            {isOwner && (
              <>
                <Menu.Divider />
                <Menu.Item
                  leftSection={<IconArrowLeft size={16} />}
                  onClick={() => navigate("/")}
                >
                  Leave room
                </Menu.Item>
                <Menu.Item
                  color="var(--wp-danger)"
                  leftSection={<IconTrash size={16} />}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete room
                </Menu.Item>
              </>
            )}
            {authRequired && isOwner && (
              <Menu.Item
                color="var(--wp-danger)"
                leftSection={<IconLogout size={16} />}
                onClick={logout}
              >
                Log out
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      </div>
      {isOwner && (
        <DeleteRoomModal
          opened={confirmDelete}
          roomName={roomName}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            // The server answers with REC:roomDeleted, which takes us Home
            room.cmd.deleteRoom();
            setConfirmDelete(false);
          }}
        />
      )}
    </header>
  );
};

/**
 * "Invite": copies the room link. With a room password (owners), a menu offers the plain link (guests type the
 * password) or the link with the password in its fragment.
 */
const InviteButton = ({
  isPhone,
  password,
}: {
  isPhone: boolean;
  password: string | undefined;
}) => {
  const trigger = (onClick?: () => void) =>
    isPhone ? (
      <ActionIcon
        variant="default"
        size={36}
        aria-label={password ? "Invite" : "Copy invite link"}
        onClick={onClick}
      >
        <IconLink size={18} />
      </ActionIcon>
    ) : (
      <Button
        variant="default"
        size="sm"
        h={30}
        px={10}
        className={styles.invite}
        leftSection={<IconLink size={16} />}
        onClick={onClick}
        aria-label={password ? "Invite" : "Copy invite link"}
      >
        <span className={styles.inviteLabel}>Invite</span>
      </Button>
    );
  if (!password) {
    return trigger(() => copyInviteLink());
  }
  return (
    <Menu position="bottom-end" width={260} zIndex={400} withinPortal>
      <Menu.Target>{trigger()}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconLink size={16} />}
          onClick={() => copyInviteLink()}
        >
          Copy invite link
          <div className={styles.menuHint}>They'll type the room password</div>
        </Menu.Item>
        <Menu.Item
          leftSection={<IconKey size={16} />}
          onClick={() =>
            copyInviteLink(
              inviteLinkWithPassword(password),
              "Link with password copied",
            )
          }
        >
          Copy link with password
          <div className={styles.menuHint}>Joins without typing anything</div>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};
