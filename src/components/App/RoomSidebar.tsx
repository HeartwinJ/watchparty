import { Badge, Button, TextInput } from "@mantine/core";
import { IconSettings, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { generateName } from "../../utils/generateName";
import { Chat } from "../Chat/Chat";
import { People } from "../People/People";
import { InviteButton } from "../InviteButton/InviteButton";
import type { Room } from "./hooks/useRoom";
import styles from "./App.module.css";

/** The right column: name, invite, people, settings and chat. */
export const RoomSidebar = ({ room }: { room: Room }) => {
  const { state, store } = room;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        position: "relative",
        width: state.showChatColumn ? 400 : 0,
        maxWidth: 400,
        overflow: "hidden",
        gap: "4px",
      }}
      className={`${
        (state.fullScreen
          ? styles.fullHeightColumnFullscreen
          : styles.fullHeightColumn) +
        " " +
        styles.rightColumn
      }`}
    >
      <div style={{ display: "flex", width: "100%", gap: "4px" }}>
        <TextInput
          style={{
            visibility: state.showChatColumn ? undefined : "hidden",
            flexGrow: 1,
          }}
          value={state.myName}
          onChange={(e) => room.updateName(e.target.value)}
          onFocus={(e) => e.target.select()}
          leftSection={<IconUser />}
          rightSectionWidth={70}
          rightSection={
            <Button
              size="compact-xs"
              onClick={async () => room.updateName(await generateName())}
            >
              Random
            </Button>
          }
        />
        <InviteButton />
      </div>
      <div style={{ display: "flex", gap: "4px" }}>
        <Button
          color="grey"
          onClick={() =>
            store.set({ showPeopleColumn: !store.get().showPeopleColumn })
          }
          fullWidth
          leftSection={<IconUsersGroup />}
          rightSection={<Badge circle>{state.participants.length}</Badge>}
        >
          People
        </Button>
        <Button
          color="grey"
          title="Settings"
          fullWidth
          onClick={() => store.set({ settingsModalOpen: true })}
          leftSection={<IconSettings />}
        >
          Settings
        </Button>
      </div>
      {state.connection === "connected" && (
        <div
          style={{
            position: "absolute",
            background: "rgba(10, 10, 10, 0.6)",
            zIndex: 200,
            left: 0,
            top: 76,
            height: state.showPeopleColumn ? "calc(100% - 120px)" : "0%",
            width: "100%",
            overflowY: "auto",
            transition: "height ease-out 0.5s",
          }}
        >
          <People
            participants={state.participants}
            nameMap={state.nameMap}
            pictureMap={state.pictureMap}
            tsMap={state.tsMap}
          />
        </div>
      )}
      <Chat
        chat={state.chat}
        nameMap={state.nameMap}
        pictureMap={state.pictureMap}
        cmd={room.cmd}
        scrollTimestamp={state.scrollTimestamp}
        getMediaDisplayName={room.getMediaDisplayName}
        ref={room.chatRef}
        hide={!state.showChatColumn}
      />
    </div>
  );
};
