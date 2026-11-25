import React, { useEffect, useId, useState } from "react";
import { IconList, IconMessage, IconUsers } from "@tabler/icons-react";
import { Chat } from "../../Chat/Chat";
import type { Room } from "../hooks/useRoom";
import { QueuePanel } from "./QueuePanel";
import { PeoplePanel } from "./PeoplePanel";
import styles from "./Shell.module.css";

export type SideTab = "chat" | "queue" | "people";
const TABS: SideTab[] = ["chat", "queue", "people"];

const isSideTab = (v: string): v is SideTab => TABS.includes(v as SideTab);

/**
 * Chat / Queue / People tabs, used by both the desktop sidebar and the phone bottom sheet.
 * `visible` is false while the sidebar is collapsed or the sheet is minimised, so unread chat keeps counting.
 */
export const SidePanels = ({
  room,
  visible,
  onTabSelect,
}: {
  room: Room;
  visible: boolean;
  onTabSelect?: (tab: SideTab) => void;
}) => {
  const { state, store } = room;
  const [tab, setTab] = useState<SideTab>(() =>
    isSideTab(store.get().currentTab)
      ? (store.get().currentTab as SideTab)
      : "chat",
  );
  const baseId = useId();

  // useChat counts unread messages unless currentTab is "chat"
  useEffect(() => {
    const currentTab = visible ? tab : "none";
    store.set(
      currentTab === "chat" ? { currentTab, unreadCount: 0 } : { currentTab },
    );
  }, [visible, tab, store]);

  const select = (next: SideTab) => {
    setTab(next);
    onTabSelect?.(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    let next: SideTab | undefined;
    if (e.key === "ArrowRight") {
      next = TABS[(i + 1) % TABS.length];
    } else if (e.key === "ArrowLeft") {
      next = TABS[(i + TABS.length - 1) % TABS.length];
    } else if (e.key === "Home") {
      next = TABS[0];
    } else if (e.key === "End") {
      next = TABS[TABS.length - 1];
    }
    if (next) {
      e.preventDefault();
      select(next);
      document.getElementById(`${baseId}-tab-${next}`)?.focus();
    }
  };

  const counts: Record<SideTab, React.ReactNode> = {
    chat:
      state.unreadCount > 0 ? (
        <span
          className={styles.unread}
          aria-label={`${state.unreadCount} unread`}
        >
          {state.unreadCount > 99 ? "99+" : state.unreadCount}
        </span>
      ) : null,
    queue: state.playlist.length ? (
      <span className={styles.count}>{state.playlist.length}</span>
    ) : null,
    people: state.participants.length ? (
      <span className={styles.count}>{state.participants.length}</span>
    ) : null,
  };
  const labels: Record<SideTab, string> = {
    chat: "Chat",
    queue: "Queue",
    people: "People",
  };
  const icons: Record<SideTab, React.ReactNode> = {
    chat: <IconMessage size={16} aria-hidden="true" />,
    queue: <IconList size={16} aria-hidden="true" />,
    people: <IconUsers size={16} aria-hidden="true" />,
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Sidebar"
        className={styles.tabs}
        onKeyDown={onKeyDown}
      >
        {TABS.map((t) => (
          <button
            key={t}
            id={`${baseId}-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${baseId}-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            className={styles.tab}
            onClick={() => select(t)}
          >
            {icons[t]}
            {labels[t]}
            {counts[t]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-chat`}
        aria-labelledby={`${baseId}-tab-chat`}
        className={styles.panel}
        hidden={tab !== "chat"}
        data-panel
      >
        <Chat
          chat={state.chat}
          nameMap={state.nameMap}
          pictureMap={state.pictureMap}
          cmd={room.cmd}
          scrollTimestamp={state.scrollTimestamp}
          getMediaDisplayName={room.getMediaDisplayName}
          ref={room.chatRef}
          hide={tab !== "chat" || !visible}
        />
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-queue`}
        aria-labelledby={`${baseId}-tab-queue`}
        className={styles.panel}
        hidden={tab !== "queue"}
        data-panel
      >
        {tab === "queue" && <QueuePanel room={room} />}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-people`}
        aria-labelledby={`${baseId}-tab-people`}
        className={styles.panel}
        hidden={tab !== "people"}
        data-panel
      >
        {tab === "people" && <PeoplePanel room={room} />}
      </div>
    </>
  );
};
