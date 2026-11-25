import type React from "react";
import { Button } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import type { Room } from "../hooks/useRoom";
import { useRoomUi } from "../ui/RoomUi";
import { mediaKindLabel, shortMediaTitle } from "./roomInfo";
import styles from "./Shell.module.css";

/** Phone only: what's playing under the video, with "Change" to open the source picker. */
export const NowPlayingStrip = ({
  room,
  ref,
}: {
  room: Room;
  ref?: React.Ref<HTMLDivElement>;
}) => {
  const { state } = room;
  const ui = useRoomUi();
  const title = shortMediaTitle(
    state.roomMedia,
    room.getMediaDisplayName(state.roomMedia),
  );
  return (
    <div className={styles.nowStrip} ref={ref}>
      <div className={styles.nowInfo}>
        <div className={styles.nowTitle}>{title || "Nothing playing"}</div>
        <div className={styles.nowMeta}>
          {title
            ? mediaKindLabel(state.roomMedia)
            : "Pick a video for everyone"}
        </div>
      </div>
      <Button
        variant="light"
        size="sm"
        leftSection={<IconSearch size={16} />}
        onClick={ui.openPicker}
      >
        {title ? "Change" : "Pick"}
      </Button>
    </div>
  );
};
