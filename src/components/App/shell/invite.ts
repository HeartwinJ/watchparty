import { toast } from "../ui/toast";

/** The link to share for the current room (no query string or hash). */
export function inviteLink(
  loc: Pick<Location, "origin" | "pathname"> = window.location,
) {
  return loc.origin + loc.pathname;
}

/** The room password to put in invite links: owners only get it, and only while it's required */
export function roomPassword(access: RoomAccessInfo | null) {
  return access?.enabled && access.password ? access.password : undefined;
}

/**
 * The room link with the room password in the fragment ("#pw=..."). Fragments never reach the server; the room
 * password screen reads it, joins, and strips it from the address bar.
 */
export function inviteLinkWithPassword(
  password: string,
  loc: Pick<Location, "origin" | "pathname"> = window.location,
) {
  return `${inviteLink(loc)}#pw=${encodeURIComponent(password)}`;
}

/** Copies plain text (e.g. the room password) and confirms with a toast. */
export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await writeClipboard(text);
    toast(`${what} copied`, { id: "invite-copied", tone: "success" });
    return true;
  } catch {
    toast(`Couldn't copy the ${what.toLowerCase()}.`, {
      id: "invite-copied",
      tone: "danger",
    });
    return false;
  }
}

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Older browsers / insecure contexts
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand?.("copy");
  el.remove();
  if (!ok) {
    throw new Error("copy failed");
  }
}

/** Copies the room link and confirms with a toast. Resolves to whether it worked. */
export async function copyInviteLink(
  link = inviteLink(),
  message = "Link copied",
): Promise<boolean> {
  try {
    await writeClipboard(link);
    toast(message, {
      id: "invite-copied",
      tone: "success",
    });
    return true;
  } catch {
    toast(`Couldn't copy the link. Share it manually: ${link}`, {
      id: "invite-copied",
      tone: "danger",
      duration: 8000,
    });
    return false;
  }
}
