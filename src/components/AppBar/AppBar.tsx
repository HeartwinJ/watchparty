import { ActionIcon, Menu } from "@mantine/core";
import { IconDots, IconHome, IconLogout, IconPlus } from "@tabler/icons-react";
import { navigate } from "../../router";
import { useAuth } from "../AuthGate/AuthGate";
import { Brand } from "../Brand/Brand";
import styles from "./AppBar.module.css";

/** The header of the non-room pages: brand on the left, a small overflow menu on the right. */
export const AppBar = ({ onNewRoom }: { onNewRoom?: () => void }) => {
  const { authRequired, logout } = useAuth();
  return (
    <header className={styles.appbar}>
      <Brand />
      <Menu position="bottom-end" width={200} zIndex={400}>
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
          {onNewRoom ? (
            <Menu.Item leftSection={<IconPlus size={16} />} onClick={onNewRoom}>
              Start a room
            </Menu.Item>
          ) : (
            <Menu.Item
              leftSection={<IconHome size={16} />}
              onClick={() => navigate("/")}
            >
              Home
            </Menu.Item>
          )}
          {authRequired && (
            <>
              <Menu.Divider />
              <Menu.Item
                color="var(--wp-danger)"
                leftSection={<IconLogout size={16} />}
                onClick={logout}
              >
                Log out
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </header>
  );
};
