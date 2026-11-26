// The last few messages people typed, shown above quick chat for context. Pure.
import { isPersonlessLine } from "./formatChat";

/** How many messages quick chat shows above the bar */
export const QUICK_CHAT_PREVIEW_COUNT = 3;

export interface PreviewLine {
  key: string;
  name: string;
  text: string;
}

/**
 * The newest `count` messages typed by people (oldest first), with "You" for your own. System lines (play, pause,
 * seek, now playing, settings, …: anything with a `cmd` or `system`), lines without a person and blank messages are
 * skipped, so the preview is the conversation only.
 */
export function recentConversation(
  chat: readonly ChatMessage[],
  nameMap: StringDict,
  clientId: string,
  count = QUICK_CHAT_PREVIEW_COUNT,
): PreviewLine[] {
  const out: PreviewLine[] = [];
  for (let i = chat.length - 1; i >= 0 && out.length < count; i--) {
    const m = chat[i];
    if (m.cmd || m.system || isPersonlessLine(m) || !m.msg?.trim()) {
      continue;
    }
    out.push({
      key: `${m.timestamp}|${m.id}`,
      name: m.id === clientId ? "You" : nameMap[m.id] || "Someone",
      text: m.msg,
    });
  }
  return out.reverse();
}
