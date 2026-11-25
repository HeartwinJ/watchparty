import React, { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { useRoom, type Room } from "./hooks/useRoom";
import { RoomMessages } from "./RoomMessages";
import { PlayerArea } from "./PlayerArea";
import { RoomUiProvider, useRoomUi } from "./ui/RoomUi";
import { RoomTopBar } from "./shell/RoomTopBar";
import { SidePanels } from "./shell/SidePanels";
import { NowPlayingStrip } from "./shell/NowPlayingStrip";
import { RoomSettingsModal } from "./shell/RoomSettingsModal";
import { BottomSheetHandle, useBottomSheet } from "./shell/BottomSheet";
import { SidebarResizeHandle, useSidebarWidth } from "./shell/SidebarResize";
import { useSlashShortcut } from "./shell/shortcuts";
import { shortMediaTitle } from "./shell/roomInfo";
import { recordRecentRoom } from "../../utils/recentRooms";
import styles from "./App.module.css";
import { SourcePicker } from "./picker/SourcePicker";

/** Phone layout cut-off (design README: ≤ 768 px) */
export const PHONE_QUERY = "(max-width: 768px)";

/** The room page (/watch/:roomId). State and behavior live in hooks/useRoom.ts; see README.md. */
export const App = ({ urlRoomId }: { urlRoomId: string }) => {
  const room = useRoom(urlRoomId);
  return (
    <RoomUiProvider>
      <RoomLayout room={room} roomId={urlRoomId} />
    </RoomUiProvider>
  );
};

/**
 * Desktop: CSS grid with the top bar (52px) over the stage and a resizable, collapsible sidebar.
 * Phone (≤ 768px): top bar (48px), 16:9 video, now-playing strip, and the sidebar as a bottom sheet.
 * The sidebar panels stay mounted in the same place in the tree across breakpoints so chat keeps its state.
 */
const RoomLayout = ({ room, roomId }: { room: Room; roomId: string }) => {
  const { state } = room;
  const ui = useRoomUi();
  const isPhone = useMediaQuery(PHONE_QUERY, false, {
    getInitialValueInEffect: false,
  });
  const sidebar = useSidebarWidth();
  const nowStripRef = useRef<HTMLDivElement>(null);
  const sheet = useBottomSheet({
    enabled: isPhone,
    dockedEdgeRef: nowStripRef,
  });

  useSlashShortcut(ui.openPicker);
  useRecentRoom(room, roomId);

  // Unread chat counts while the chat isn't visible (collapsed sidebar, minimised sheet or another tab)
  const panelsVisible = isPhone ? sheet.snap !== "min" : !ui.sidebarCollapsed;

  const collapsed = !isPhone && ui.sidebarCollapsed;
  const roomStyle = {
    "--room-sidebar-w": `${collapsed ? 0 : sidebar.width}px`,
    "--room-sidebar-inner-w": `${sidebar.width}px`,
  } as React.CSSProperties;

  return (
    <div
      className={styles.room}
      data-layout={isPhone ? "phone" : "desktop"}
      data-sidebar={collapsed ? "collapsed" : "open"}
      data-resizing={sidebar.resizing || undefined}
      style={roomStyle}
    >
      <RoomTopBar room={room} roomId={roomId} isPhone={isPhone} />
      <main className={styles.stage} aria-label="Video">
        <div className={styles.player}>
          {/* The player (agent B) fills this box; fullscreen is handled inside it */}
          <PlayerArea room={room} />
        </div>
      </main>
      {isPhone && <NowPlayingStrip room={room} ref={nowStripRef} />}
      <aside
        className={styles.sidebar}
        aria-label="Chat, queue and people"
        data-snap={isPhone ? sheet.snap : undefined}
        data-dragging={sheet.dragging || undefined}
        style={isPhone ? sheet.style : undefined}
      >
        {isPhone ? (
          <BottomSheetHandle sheet={sheet} />
        ) : (
          <SidebarResizeHandle sidebar={sidebar} hidden={collapsed} />
        )}
        <div className={styles.sidebarInner}>
          <SidePanels
            room={room}
            visible={panelsVisible}
            onTabSelect={() => {
              if (isPhone && sheet.snap === "min") {
                sheet.setSnap("docked");
              }
            }}
          />
        </div>
      </aside>
      <RoomMessages room={room} />
      <RoomSettingsModal room={room} />
      <SourcePicker room={room} />
    </div>
  );
};

/** Remembers this room (and the title of what's playing) for the home page's recent rooms. */
function useRecentRoom(room: Room, roomId: string) {
  const { roomMedia, connection } = room.state;
  const connected = connection === "connected";
  const displayName = room.getMediaDisplayName(roomMedia);
  const title = shortMediaTitle(roomMedia, displayName);
  const [recorded, setRecorded] = useState(false);
  const record = useCallback(
    (lastTitle?: string) => recordRecentRoom({ roomId, lastTitle }),
    [roomId],
  );
  useEffect(() => {
    if (connected && !recorded) {
      record();
      setRecorded(true);
    }
  }, [connected, recorded, record]);
  useEffect(() => {
    // Shares only make sense while they're live, so don't remember them as the room's title
    if (connected && roomMedia.startsWith("http")) {
      record(title);
    }
  }, [connected, roomMedia, title, record]);
}
