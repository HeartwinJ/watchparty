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
 * A readable name for a room id ("brave-otter-sings" -> "Brave otter sings").
 * TODO(wave 2): rooms get a title in room settings; prefer it over the id when it exists.
 */
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
