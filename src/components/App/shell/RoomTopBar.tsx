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
  IconLink,
  IconLogout,
  IconPencil,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import { navigate } from "../../../router";
import { prettyRoomName } from "../../../utils/rooms";
import { useAuth } from "../../AuthGate/AuthGate";
import { AvatarStack } from "../../Avatar/Avatar";
import { Brand } from "../../Brand/Brand";
import type { Room } from "../hooks/useRoom";
import { useRoomUi } from "../ui/RoomUi";
import { copyInviteLink } from "./invite";
import { shortMediaTitle } from "./roomInfo";
import { requestShortcutsOverlay } from "./shortcuts";
import styles from "./Shell.module.css";

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
  const { authRequired, logout } = useAuth();
  const title = shortMediaTitle(
    state.roomMedia,
    room.getMediaDisplayName(state.roomMedia),
  );
  // TODO(wave 2): show the room title from room settings once the server stores one
  const roomName = prettyRoomName(roomId);
  const people = state.participants.map((p) => ({
    id: p.id,
    name: state.nameMap[p.id],
    picture: state.pictureMap[p.id],
  }));
  const unread = ui.sidebarCollapsed && state.unreadCount > 0;

  return (
    <header className={styles.topbar}>
      {!isPhone && <Brand showWord={false} />}
      <UnstyledButton
        className={styles.roomName}
        onClick={ui.openSettings}
        title="Room settings"
      >
        <span className={styles.ellipsis}>{roomName}</span>
        <IconPencil size={14} aria-hidden="true" className={styles.dim} />
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
        {/* SLOT(B): <SyncIndicator room={room} /> */}
        {!isPhone && people.length > 0 && (
          <span className={styles.avatars}>
            <AvatarStack users={people} />
          </span>
        )}
        {isPhone ? (
          <ActionIcon
            variant="default"
            size={36}
            aria-label="Copy invite link"
            onClick={() => copyInviteLink()}
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
            onClick={() => copyInviteLink()}
            aria-label="Copy invite link"
          >
            <span className={styles.inviteLabel}>Invite</span>
          </Button>
        )}
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
            <Menu.Divider />
            <Menu.Item
              leftSection={<IconArrowLeft size={16} />}
              onClick={() => navigate("/")}
            >
              Leave room
            </Menu.Item>
            {authRequired && (
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
    </header>
  );
};
