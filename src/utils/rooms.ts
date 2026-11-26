import { navigate } from "../router";
import { apiFetch } from "./api";

/**
 * POST /createRoom (optionally preloading a video, which starts paused) and go to the new room.
 * Returns the room id (without the leading slash).
 */
export async function createRoom(
  opts: { video?: string; openNewTab?: boolean; replace?: boolean } = {},
): Promise<string> {
  const response = await apiFetch("/createRoom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video: opts.video ?? "" }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't create a room (${response.status})`);
  }
  const { name } = (await response.json()) as { name: string };
  const path = "/watch" + name;
  if (opts.openNewTab) {
    window.open(path);
  } else {
    navigate(path, { replace: opts.replace });
  }
  return name.replace(/^\//, "");
}

/**
 * Owners: DELETE /rooms/:roomId (Home's recent rooms; the room page uses the CMD:deleteRoom socket command).
 * Resolves true when the room is gone (deleted now, or it didn't exist anymore).
 */
export async function deleteRoom(roomId: string): Promise<boolean> {
  const response = await apiFetch(
    `/rooms/${encodeURIComponent(roomId.replace(/^\//, ""))}`,
    { method: "DELETE" },
  );
  return response.status === 204 || response.status === 404;
}

/** What to call a room: its title from room settings when set, otherwise the readable generated name. */
export function roomDisplayName(roomId: string, title?: string): string {
  return title?.trim() || prettyRoomName(roomId);
}

/** A readable name for a room id ("brave-otter-sings" -> "Brave otter sings"). */
export function prettyRoomName(roomId: string): string {
  const words = roomId
    .replace(/^\/+/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .join(" ");
  if (!words) {
    return "Room";
  }
  return words[0].toUpperCase() + words.slice(1);
}
