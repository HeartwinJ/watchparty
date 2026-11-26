import React, { useState } from "react";
import { ActionIcon, Button, TextInput } from "@mantine/core";
import {
  IconChevronRight,
  IconLink,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { navigate } from "../../router";
import { examples } from "../../utils/examples";
import { createRoom, deleteRoom, roomDisplayName } from "../../utils/rooms";
import {
  formatVisitedAgo,
  readRecentRooms,
  removeRecentRoom,
  type RecentRoom,
} from "../../utils/recentRooms";
import { DeleteRoomModal } from "../DeleteRoomModal/DeleteRoomModal";
import { isHttp } from "../../utils/utils";
import { AppBar } from "../AppBar/AppBar";
import { avatarColor } from "../Avatar/avatar";
import { mediaKindLabel } from "../App/shell/roomInfo";
import { toast } from "../App/ui/toast";
import { ContinueWatching } from "./ContinueWatching";
import styles from "./Home.module.css";

const TRY_LINKS = [
  { label: "YouTube", url: examples.find((e) => e.type === "youtube")?.url },
  { label: "HLS", url: examples.find((e) => e.url.includes(".m3u8"))?.url },
  { label: "WebM", url: examples.find((e) => e.url.endsWith(".webm"))?.url },
  { label: "DASH", url: examples.find((e) => e.url.includes(".mpd"))?.url },
].filter((t): t is { label: string; url: string } => Boolean(t.url));

/**
 * Home: start a room, paste a link to start one playing it, continue watching (server-side history) and this
 * device's recent rooms.
 */
export const Home = () => {
  const [starting, setStarting] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentRoom[]>(() => readRecentRooms());
  // Home is owner-only, so every recent room can be deleted from here (DELETE /rooms/:roomId)
  const [toDelete, setToDelete] = useState<RecentRoom | null>(null);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async () => {
    if (!toDelete || deleting) {
      return;
    }
    setDeleting(true);
    try {
      if (!(await deleteRoom(toDelete.roomId))) {
        throw new Error("delete failed");
      }
      setRecent(removeRecentRoom(toDelete.roomId));
      toast("Room deleted.");
      setToDelete(null);
    } catch (e) {
      console.error(e);
      toast("Couldn't delete the room. Try again in a moment.", {
        tone: "danger",
      });
    } finally {
      setDeleting(false);
    }
  };

  const start = async (video?: string) => {
    if (starting) {
      return;
    }
    setStarting(true);
    try {
      await createRoom({ video });
    } catch (e) {
      console.error(e);
      toast("Couldn't create a room. Try again in a moment.", {
        tone: "danger",
      });
      setStarting(false);
    }
  };

  const trimmed = link.trim();
  const isLink = isHttp(trimmed) && /^https?:\/\/\S+$/.test(trimmed);
  const detected = isLink ? mediaKindLabel(trimmed) : "";

  const onPaste = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed) {
      setLinkError("Paste a link first.");
      return;
    }
    if (!isLink) {
      setLinkError(
        "That doesn't look like a link. To search, start a room and press /.",
      );
      return;
    }
    void start(trimmed);
  };

  return (
    <div className={styles.page}>
      <AppBar onNewRoom={() => start()} />
      <main className={styles.home}>
        <section className={styles.hero}>
          <div className={styles.heroMain}>
            <h1>Watch together.</h1>
            <p>
              Start a room, send the link, press play. Everyone stays in sync.
            </p>
            <Button
              size="lg"
              h={48}
              className={styles.cta}
              leftSection={<IconPlus size={18} />}
              loading={starting && !trimmed}
              onClick={() => start()}
            >
              Start a room
            </Button>
          </div>
          <form className={styles.heroPaste} onSubmit={onPaste} noValidate>
            <h2 id="paste-title">Or paste a link to start right away</h2>
            <TextInput
              size="lg"
              radius="md"
              aria-labelledby="paste-title"
              placeholder="YouTube, .m3u8 or video URL"
              value={link}
              onChange={(e) => {
                setLink(e.currentTarget.value);
                setLinkError(null);
              }}
              error={linkError}
              leftSection={<IconLink size={18} />}
              rightSectionWidth={84}
              rightSection={
                <Button
                  type="submit"
                  size="compact-sm"
                  variant={isLink ? "filled" : "light"}
                  loading={starting && Boolean(trimmed)}
                >
                  Start
                </Button>
              }
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
            <div className={styles.detect} aria-live="polite">
              {detected ? (
                <>
                  <span className={styles.badge}>{detected}</span>
                  Opens a new room playing this link.
                </>
              ) : (
                "Opens a new room playing this link."
              )}
            </div>
            <div className={styles.chips}>
              <span>Try:</span>
              {TRY_LINKS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => {
                    setLink(t.url);
                    setLinkError(null);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </form>
        </section>

        <ContinueWatching />

        <section aria-labelledby="recent-title">
          <div className={styles.secHead}>
            <h2 id="recent-title">Recent rooms</h2>
            <span>On this device</span>
          </div>
          {recent.length === 0 ? (
            <div className={styles.emptyRooms}>
              Rooms you join show up here, so you can hop back in.
            </div>
          ) : (
            <ul className={styles.rooms}>
              {recent.map((r) => (
                <RecentRoomRow
                  key={r.roomId}
                  room={r}
                  onDelete={() => setToDelete(r)}
                />
              ))}
            </ul>
          )}
        </section>
        <DeleteRoomModal
          opened={toDelete !== null}
          roomName={
            toDelete ? roomDisplayName(toDelete.roomId, toDelete.roomTitle) : ""
          }
          busy={deleting}
          onCancel={() => setToDelete(null)}
          onConfirm={confirmDelete}
        />
      </main>
    </div>
  );
};

const RecentRoomRow = ({
  room,
  onDelete,
}: {
  room: RecentRoom;
  onDelete: () => void;
}) => {
  const href = `/watch/${encodeURIComponent(room.roomId)}`;
  const name = roomDisplayName(room.roomId, room.roomTitle);
  const open = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(href);
  };
  return (
    <li className={styles.roomItem}>
      <a href={href} onClick={open} className={styles.roomRow}>
        <span
          className={styles.still}
          style={{ "--g": avatarColor(room.roomId) } as React.CSSProperties}
          aria-hidden="true"
        />
        <span className={styles.roomInfo}>
          <span className={styles.roomName}>{name}</span>
          <span className={styles.roomSub}>
            {room.lastTitle || "Nothing played yet"}
          </span>
        </span>
        <span className={styles.when}>{formatVisitedAgo(room.visitedAt)}</span>
        <span className={styles.open}>
          <IconChevronRight size={16} aria-hidden="true" />
          <span className={styles.openLabel}>Open</span>
        </span>
      </a>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={30}
        className={styles.deleteRoom}
        aria-label={`Delete ${name}`}
        title="Delete room"
        onClick={onDelete}
      >
        <IconX size={16} />
      </ActionIcon>
    </li>
  );
};
