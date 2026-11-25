import { Badge, Button, Menu, Switch, Tooltip } from "@mantine/core";
import {
  IconFile,
  IconList,
  IconScreenShare,
  IconX,
} from "@tabler/icons-react";
import { isMobile } from "../../utils/utils";
import { isClientTranscodeSupported } from "../../utils/clientTranscode";
import { ComboBox } from "../ComboBox/ComboBox";
import ChatVideoCard from "../ChatVideoCard/ChatVideoCard";
import type { Room } from "./hooks/useRoom";
import { findSharer } from "./logic/media";
import { withDisplayType } from "./logic/playlist";
import styles from "./App.module.css";

/** The URL bar plus the share, playlist and convert controls above the player. */
export const RoomToolbar = ({ room }: { room: Room }) => {
  const { state, store, playlist: playlistApi } = room;
  const sharer = findSharer(state.participants);
  const playlist = state.playlist;
  return (
    <>
      <div className={styles.mobileStack}>
        <ComboBox
          roomSetMedia={room.cmd.setMedia}
          playlistAdd={playlistApi.add}
          roomMedia={state.roomMedia}
          getMediaDisplayName={room.getMediaDisplayName}
        />
      </div>
      <div className={styles.mobileStack}>
        {state.isPublishing && (
          <Button
            color="red"
            onClick={room.share.stopPublishing}
            leftSection={<IconX />}
          >
            Stop Share
          </Button>
        )}
        {!state.isPublishing && !sharer && (
          <Button
            className={styles.shareButton}
            color="blue"
            onClick={() => store.set({ isScreenShareModalOpen: true })}
            leftSection={<IconScreenShare />}
          >
            Screenshare
          </Button>
        )}
        {!state.isPublishing && !sharer && (
          <Button
            className={styles.shareButton}
            color="violet"
            onClick={() => store.set({ isFileShareModalOpen: true })}
            leftSection={<IconFile />}
          >
            File
          </Button>
        )}
        <Menu>
          <Menu.Target>
            <Button
              color="grey"
              leftSection={<IconList />}
              rightSection={<Badge circle>{playlist.length}</Badge>}
              className={styles.shareButton}
            >
              Playlist
            </Button>
          </Menu.Target>
          <Menu.Dropdown
            style={{
              overflowY: playlist.length > 0 ? "scroll" : undefined,
              maxHeight: 400,
              maxWidth: isMobile() ? 400 : 600,
            }}
          >
            {playlist.length === 0 && (
              <Menu.Item disabled>
                There are no items in the playlist.
              </Menu.Item>
            )}
            {playlist.map((item, index) => (
              <Menu.Item key={index}>
                <ChatVideoCard
                  video={withDisplayType(item)}
                  index={index}
                  controls
                  onPlay={playlistApi.play}
                  onPlayNext={(index) => playlistApi.move(index, 0)}
                  onRemove={playlistApi.remove}
                />
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
        {isClientTranscodeSupported() && (
          <Tooltip
            multiline
            w={280}
            refProp="rootRef"
            label="Use CPU/GPU to convert content before playback (only with links, use if video or audio doesn't play, or to choose between audio tracks)"
          >
            <Switch
              label="Convert"
              checked={state.convertEnabled}
              onChange={(e) =>
                room.convert.setConvertEnabled(e.currentTarget.checked)
              }
              style={{ flexShrink: 0, alignSelf: "center" }}
            />
          </Tooltip>
        )}
      </div>
    </>
  );
};
