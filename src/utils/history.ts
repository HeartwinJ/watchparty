import { navigate } from "../router";
import { apiFetch } from "./api";

/**
 * Server-side watch history (PLAN 6d "Continue watching"): GET /history, DELETE /history/:id,
 * POST /history/:id/resume. Items never carry the video URL (AIOStreams URLs hold a debrid credential); resuming
 * asks the server to start a room on the stored URL.
 */
export interface HistoryItem {
  id: number;
  roomId: string;
  kind: "aiostreams" | "youtube" | "url";
  title: string;
  /** "S02E04 · Episode title", "E05" or null */
  subtitle: string | null;
  poster: string | null;
  /** Seconds */
  position: number;
  /** Seconds, null when unknown */
  duration: number | null;
  /** ms since epoch */
  updatedAt: number;
  finished: boolean;
  /** Same title (a series' episodes share one) */
  group: string;
}

export async function fetchHistory(
  limit = 50,
  signal?: AbortSignal,
): Promise<HistoryItem[]> {
  const response = await apiFetch(`/history?limit=${limit}`, { signal });
  if (!response.ok) {
    throw new Error(`history ${response.status}`);
  }
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as HistoryItem[]) : [];
}

export async function deleteHistoryItem(id: number): Promise<void> {
  const response = await apiFetch(`/history/${id}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`history delete ${response.status}`);
  }
}

/** Starts a new room on the item, paused at its saved position, and goes there */
export async function resumeHistoryItem(id: number): Promise<string> {
  const response = await apiFetch(`/history/${id}/resume`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`history resume ${response.status}`);
  }
  const { roomId } = (await response.json()) as { roomId: string };
  navigate("/watch/" + encodeURIComponent(roomId));
  return roomId;
}

/**
 * The "Continue watching" row: newest first, one card per title (the latest episode of a series), and only when
 * that latest entry isn't finished.
 */
export function continueWatching(
  items: HistoryItem[],
  max = 12,
): HistoryItem[] {
  const seen = new Set<string>();
  const result: HistoryItem[] = [];
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const group = item.group || String(item.id);
    if (seen.has(group)) {
      continue;
    }
    seen.add(group);
    if (!item.finished) {
      result.push(item);
    }
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

/** 0–1, or null when the duration is unknown */
export function historyProgress(item: HistoryItem): number | null {
  if (!item.duration || item.duration <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, item.position / item.duration));
}

/** "42 min left", "1 h 5 min left", "<1 min left"; or "At 12:34" when the duration is unknown */
export function formatTimeLeft(item: HistoryItem): string {
  if (!item.duration || item.duration <= 0) {
    return "At " + formatClock(item.position);
  }
  const left = Math.max(0, item.duration - item.position);
  const min = Math.round(left / 60);
  if (min < 1) {
    return "<1 min left";
  }
  if (min < 60) {
    return `${min} min left`;
  }
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

function formatClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
