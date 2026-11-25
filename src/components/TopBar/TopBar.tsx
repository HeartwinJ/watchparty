import React, { useCallback } from "react";
import { Button } from "@mantine/core";
import { apiFetch } from "../../utils/api";
import appStyles from "../App/App.module.css";
import { useAuth } from "../AuthGate/AuthGate";
import { IconCirclePlusFilled, IconLogout } from "@tabler/icons-react";

export async function createRoom(
  openNewTab: boolean | undefined,
  video: string = "",
) {
  const response = await apiFetch("/createRoom", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video,
    }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't create a room (${response.status})`);
  }
  const data = await response.json();
  const { name } = data;
  if (openNewTab) {
    window.open("/watch" + name);
  } else {
    window.location.assign("/watch" + name);
  }
}

export const NewRoomButton = (props: {
  size?: string;
  openNewTab?: boolean;
}) => {
  const onClick = useCallback(async () => {
    await createRoom(props.openNewTab);
  }, [props.openNewTab]);
  return (
    <Button
      size={props.size}
      onClick={onClick}
      leftSection={<IconCirclePlusFilled />}
    >
      New Room
    </Button>
  );
};

export const LogoutButton = () => {
  const { authRequired, logout } = useAuth();
  if (!authRequired) {
    return null;
  }
  return (
    <Button color="gray" onClick={logout} leftSection={<IconLogout />}>
      Log out
    </Button>
  );
};

export const TopBar = (props: { hideNewRoom?: boolean }) => {
  return (
    <React.Fragment>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          padding: "4px 8px",
          rowGap: "8px",
        }}
      >
        <a href="/" style={{ display: "flex" }}>
          <img style={{ width: "56px", height: "56px" }} src="/logo192.png" />
        </a>
        <a href="/" style={{ display: "flex", textDecoration: "none" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
            }}
          >
            <div
              style={{
                textTransform: "uppercase",
                fontWeight: 700,
                color: "#2185d0",
                fontSize: "30px",
                lineHeight: "30px",
              }}
            >
              Watch
            </div>
            <div
              style={{
                textTransform: "uppercase",
                fontWeight: 700,
                color: "#21ba45",
                fontSize: "30px",
                lineHeight: "30px",
                marginLeft: "auto",
              }}
            >
              Party
            </div>
          </div>
        </a>
        <div
          className={appStyles.mobileStack}
          style={{
            display: "flex",
            marginLeft: "auto",
            alignItems: "center",
            gap: "4px",
          }}
        >
          {!props.hideNewRoom && <NewRoomButton openNewTab />}
          <LogoutButton />
        </div>
      </div>
    </React.Fragment>
  );
};
