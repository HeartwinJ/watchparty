import React, { useEffect, useState } from "react";
import { IconPlayerPlayFilled, IconX } from "@tabler/icons-react";
import {
  continueWatching,
  deleteHistoryItem,
  fetchHistory,
  formatTimeLeft,
  historyProgress,
  resumeHistoryItem,
  type HistoryItem,
} from "../../utils/history";
import { avatarColor } from "../Avatar/avatar";
import { toast } from "../App/ui/toast";
import styles from "./ContinueWatching.module.css";

/**
 * Home's "Continue watching" row (PLAN 6d): unfinished items from the server-side history, newest first, one per
 * title. A card starts a new room paused where it was left. Hidden while loading, on errors and when empty.
 */
export const ContinueWatching = () => {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [resuming, setResuming] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchHistory(200, ctrl.signal)
      .then((all) => setItems(continueWatching(all)))
      .catch((e) => {
        if (!ctrl.signal.aborted) {
          console.warn("[history]", e);
        }
      });
    return () => ctrl.abort();
  }, []);

  if (items.length === 0) {
    return null;
  }

  const resume = async (item: HistoryItem) => {
    if (resuming !== null) {
      return;
    }
    setResuming(item.id);
    try {
      await resumeHistoryItem(item.id);
    } catch (e) {
      console.warn("[history]", e);
      toast(`Couldn't resume ${item.title}. Try again in a moment.`, {
        tone: "danger",
      });
      setResuming(null);
    }
  };

  const remove = async (item: HistoryItem) => {
    const previous = items;
    setItems(items.filter((i) => i.id !== item.id));
    try {
      await deleteHistoryItem(item.id);
    } catch (e) {
      console.warn("[history]", e);
      setItems(previous);
      toast(`Couldn't remove ${item.title}.`, { tone: "danger" });
    }
  };

  return (
    <section aria-labelledby="continue-title">
      <div className={styles.head}>
        <h2 id="continue-title">Continue watching</h2>
      </div>
      <ul className={styles.row}>
        {items.map((item) => (
          <ContinueCard
            key={item.id}
            item={item}
            busy={resuming === item.id}
            onResume={() => resume(item)}
            onRemove={() => remove(item)}
          />
        ))}
      </ul>
    </section>
  );
};

const ContinueCard = ({
  item,
  busy,
  onResume,
  onRemove,
}: {
  item: HistoryItem;
  busy: boolean;
  onResume: () => void;
  onRemove: () => void;
}) => {
  const [posterFailed, setPosterFailed] = useState(false);
  const progress = historyProgress(item);
  const timeLeft = formatTimeLeft(item);
  const label = [item.title, item.subtitle, timeLeft]
    .filter(Boolean)
    .join(", ");
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.card}
        onClick={onResume}
        aria-busy={busy}
        disabled={busy}
        aria-label={`Resume ${label}`}
      >
        <span
          className={styles.poster}
          style={{ "--g": avatarColor(item.group) } as React.CSSProperties}
          aria-hidden="true"
        >
          {item.poster && !posterFailed ? (
            <img
              src={item.poster}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setPosterFailed(true)}
            />
          ) : (
            <span className={styles.initial}>
              {item.title.trim().charAt(0).toUpperCase() || "?"}
            </span>
          )}
          <span className={styles.play}>
            <IconPlayerPlayFilled size={18} />
          </span>
        </span>
        <span className={styles.body}>
          <span className={styles.title}>{item.title}</span>
          {item.subtitle && <span className={styles.sub}>{item.subtitle}</span>}
          <span className={styles.left}>{busy ? "Starting…" : timeLeft}</span>
          {progress !== null && (
            <span className={styles.bar} aria-hidden="true">
              <span style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        className={styles.remove}
        onClick={onRemove}
        aria-label={`Remove ${item.title} from Continue watching`}
        title="Remove"
      >
        <IconX size={14} />
      </button>
    </li>
  );
};
