/**
 * /history routes, all behind requireAuth:
 * - GET /history?limit= → HistoryItem[] (newest first, never any URL)
 * - DELETE /history/:id → 204 (404 when unknown)
 * - POST /history/:id/resume → {roomId}: a new room hosting the stored video (+ metadata), paused at the saved
 *   position. The entry moves to the new room. Finished items restart from the beginning.
 */
import express, { type RequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import {
  deleteHistory,
  getHistoryEntry,
  listHistory,
  upsertHistory,
} from "./history.ts";

export const HISTORY_LIST_DEFAULT = 50;
export const HISTORY_LIST_MAX = 200;

export type HistoryRouterOptions = {
  db: DatabaseSync;
  requireAuth: RequestHandler;
  /**
   * Creates a room preloaded with a video, paused at `position`, and returns its id ("/name"), or undefined when
   * no room name could be allocated.
   */
  createRoom: (opts: {
    video: string;
    meta: VideoMeta | null;
    position: number;
  }) => string | undefined;
};

/** Positive integer ids only */
function parseId(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !/^[1-9]\d{0,15}$/.test(raw)) {
    return undefined;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function parseLimit(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) {
    return HISTORY_LIST_DEFAULT;
  }
  return Math.min(HISTORY_LIST_MAX, Math.max(1, Number(raw)));
}

export function createHistoryRouter(opts: HistoryRouterOptions) {
  const { db, requireAuth } = opts;
  const router = express.Router();

  router.get("/history", requireAuth, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(listHistory(db, parseLimit(req.query.limit)));
    } catch (e) {
      console.warn("[history] list failed:", e);
      res.status(500).json({ error: "history_unavailable" });
    }
  });

  router.delete("/history/:id", requireAuth, (req, res) => {
    const id = parseId(req.params.id);
    if (id === undefined) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    if (!deleteHistory(db, id)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(204).end();
  });

  router.post("/history/:id/resume", requireAuth, (req, res) => {
    const id = parseId(req.params.id);
    if (id === undefined) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    const entry = getHistoryEntry(db, id);
    if (!entry) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const position = entry.finished ? 0 : Math.max(0, entry.position);
    const roomId = opts.createRoom({
      video: entry.url,
      meta: entry.meta,
      position,
    });
    if (!roomId) {
      res.status(503).json({ error: "could not allocate a room name" });
      return;
    }
    // Move the entry to the new room, so Home shows one card and the new room keeps the known duration
    try {
      upsertHistory(db, {
        roomId,
        itemKey: entry.itemKey,
        groupKey: entry.group,
        kind: entry.kind,
        title: entry.title,
        subtitle: entry.subtitle,
        poster: entry.poster,
        url: entry.url,
        meta: entry.meta,
        position,
        duration: entry.duration,
        finished: false,
      });
      if (roomId !== entry.roomId) {
        deleteHistory(db, entry.id);
      }
    } catch (e) {
      console.warn("[history] failed to move the entry:", e);
    }
    res.json({ roomId: roomId.replace(/^\//, "") });
  });

  return router;
}
