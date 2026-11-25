import { toast } from "../ui/toast";

/** The link to share for the current room (no query string or hash). */
export function inviteLink(
  loc: Pick<Location, "origin" | "pathname"> = window.location,
) {
  return loc.origin + loc.pathname;
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
export async function copyInviteLink(link = inviteLink()): Promise<boolean> {
  try {
    await writeClipboard(link);
    toast("Link copied", {
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
