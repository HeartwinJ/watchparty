import { useState } from "react";
import { ActionIcon, Button, Menu } from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconDots,
  IconGripVertical,
  IconList,
  IconPlayerPlayFilled,
  IconPlayerTrackNext,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { decodeEntities, formatTimestamp } from "../../../utils/utils";
import type { Room } from "../hooks/useRoom";
import { useRoomUi } from "../ui/RoomUi";
import { mediaKindLabel, shortMediaTitle } from "./roomInfo";
import styles from "./Shell.module.css";

/** Now playing + the room's playlist ("Up next"), with reorder, remove and play now/next. */
export const QueuePanel = ({ room }: { room: Room }) => {
  const { state, playlist: api } = room;
  const ui = useRoomUi();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const items = state.playlist;
  const nowTitle = shortMediaTitle(
    state.roomMedia,
    room.getMediaDisplayName(state.roomMedia),
  );

  const onDrop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) {
      api.move(dragIndex, to);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className={styles.panelBody}>
      <div className={styles.scroll}>
        {state.roomMedia && (
          <>
            <div className={styles.sectionLabel}>Now playing</div>
            <div className={`${styles.qItem} ${styles.qNow}`}>
              <Thumb url={state.roomMedia} />
              <div className={styles.qInfo}>
                <div className={styles.qTitle} title={nowTitle}>
                  {nowTitle}
                </div>
                <div className={styles.qMeta}>
                  {!state.roomPaused && <Eq />}
                  {state.roomPaused ? "Paused" : "Playing"} ·{" "}
                  {mediaKindLabel(state.roomMedia)}
                </div>
              </div>
            </div>
          </>
        )}
        <div className={styles.sectionLabel}>Up next</div>
        {items.length === 0 ? (
          <div className={styles.empty}>
            <IconList size={28} aria-hidden="true" />
            <div className={styles.emptyTitle}>The queue is empty</div>
            <div className={styles.emptyText}>
              Add videos and they'll play one after another for everyone.
            </div>
          </div>
        ) : (
          <ol className={styles.qList} aria-label="Up next">
            {items.map((item, index) => {
              const title = decodeEntities(
                item.name && item.name !== item.url
                  ? item.name
                  : shortMediaTitle(item.url, item.url),
              );
              const meta = [
                // The server labels plain links "Video URL"; the type label says the same
                item.channel === "Video URL" ? "" : item.channel,
                item.type === "youtube" ? "YouTube" : mediaKindLabel(item.url),
                item.duration ? formatTimestamp(item.duration) : "",
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={`${index}-${item.url}`}
                  className={styles.qItem}
                  data-dragging={dragIndex === index || undefined}
                  data-over={
                    (overIndex === index && dragIndex !== index) || undefined
                  }
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(index);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(index));
                  }}
                  onDragOver={(e) => {
                    if (dragIndex === null) {
                      return;
                    }
                    e.preventDefault();
                    setOverIndex(index);
                  }}
                  onDragLeave={() =>
                    setOverIndex((o) => (o === index ? null : o))
                  }
                  onDrop={(e) => {
                    e.preventDefault();
                    onDrop(index);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                >
                  <span className={styles.grip} aria-hidden="true">
                    <IconGripVertical size={16} />
                  </span>
                  <Thumb url={item.url} img={item.img} />
                  <div className={styles.qInfo}>
                    <div className={styles.qTitle} title={title}>
                      {title}
                    </div>
                    {meta && <div className={styles.qMeta}>{meta}</div>}
                  </div>
                  <Menu position="bottom-end" width={200} withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={28}
                        className={styles.qAction}
                        aria-label={`Options for ${title}`}
                      >
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconPlayerPlayFilled size={14} />}
                        onClick={() => api.play(index)}
                      >
                        Play now
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconPlayerTrackNext size={14} />}
                        disabled={index === 0}
                        onClick={() => api.move(index, 0)}
                      >
                        Play next
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconArrowUp size={14} />}
                        disabled={index === 0}
                        onClick={() => api.move(index, index - 1)}
                      >
                        Move up
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconArrowDown size={14} />}
                        disabled={index === items.length - 1}
                        onClick={() => api.move(index, index + 1)}
                      >
                        Move down
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="var(--wp-danger)"
                        leftSection={<IconX size={14} />}
                        onClick={() => api.remove(index)}
                      >
                        Remove
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={28}
                    className={styles.qAction}
                    aria-label={`Remove ${title} from the queue`}
                    onClick={() => api.remove(index)}
                  >
                    <IconX size={16} />
                  </ActionIcon>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <div className={styles.panelFoot}>
        <Button
          variant="default"
          fullWidth
          leftSection={<IconPlus size={16} />}
          onClick={() => ui.openPicker({ mode: "queue" })}
        >
          Add to queue
        </Button>
      </div>
    </div>
  );
};

/** A 16:9 thumbnail: the item's image, or a tinted placeholder with the source type. */
const Thumb = ({ url, img }: { url: string; img?: string }) => (
  <span className={styles.thumb} aria-hidden="true">
    {img ? (
      <img src={img} alt="" loading="lazy" />
    ) : (
      <span className={styles.thumbLabel}>
        {mediaKindLabel(url) || "Video"}
      </span>
    )}
  </span>
);

const Eq = () => (
  <span className={styles.eq} aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);
