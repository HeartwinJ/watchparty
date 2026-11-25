import { ActionIcon } from "@mantine/core";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { isMobile } from "../../utils/utils";
import { TopBar } from "../TopBar/TopBar";
import { useRoom } from "./hooks/useRoom";
import { RoomMessages } from "./RoomMessages";
import { RoomToolbar } from "./RoomToolbar";
import { PlayerArea, PlayerControls } from "./PlayerArea";
import { RoomSidebar } from "./RoomSidebar";
import styles from "./App.module.css";

/** The room page (/watch/:roomId). State and behavior live in hooks/useRoom.ts; see README.md. */
export const App = ({ urlRoomId }: { urlRoomId: string }) => {
  const room = useRoom(urlRoomId);
  const { state, store } = room;
  return (
    <>
      <RoomMessages room={room} />
      {!state.fullScreen && <TopBar />}
      <div
        className={styles.mobileStack}
        style={{ margin: "0 8px", display: "flex", columnGap: "32px" }}
      >
        <div
          className={
            (state.fullScreen
              ? styles.fullHeightColumnFullscreen
              : styles.fullHeightColumn) +
            " " +
            styles.leftColumn
          }
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
              position: "relative",
              gap: "4px",
            }}
          >
            {!state.fullScreen && <RoomToolbar room={room} />}
            <PlayerArea room={room} />
            {state.roomMedia && <PlayerControls room={room} />}
            {!isMobile() && (
              <div className={styles.expandButton}>
                <ActionIcon
                  onClick={() => {
                    const showChatColumn = !store.get().showChatColumn;
                    store.set({ showChatColumn });
                    window.localStorage.setItem(
                      "watchparty-showchatcolumn",
                      Number(showChatColumn).toString(),
                    );
                  }}
                >
                  {state.showChatColumn ? (
                    <IconChevronRight size={16} />
                  ) : (
                    <IconChevronLeft size={16} />
                  )}
                </ActionIcon>
              </div>
            )}
          </div>
        </div>
        <RoomSidebar room={room} />
      </div>
    </>
  );
};
