// The chat panel over the player (fullscreen, or with the sidebar collapsed). Pure helpers: when it's offered, its
// open state, unread counting, the `c` key, its width and how much room the other overlays leave for it.

import { isPersonlessLine } from "./formatChat";

/** Below this player width (px) there's no room for a panel next to the video; quick chat (`c`) still works. */
export const CHAT_PANEL_MIN_PLAYER_WIDTH = 480;
/** Panel width: 40 % of the player (phones in landscape), between these bounds */
export const CHAT_PANEL_MIN_WIDTH = 260;
export const CHAT_PANEL_MAX_WIDTH = 380;
/** Gap between the panel and the player's right edge, px */
export const CHAT_PANEL_MARGIN = 12;

/**
 * Whether the panel (and its control-bar button) is offered: in fullscreen, or with the desktop sidebar collapsed
 * (same condition as quick chat; on the phone layout the bottom sheet has the chat). Never on a tiny player.
 */
export function chatPanelAllowed(opts: {
  fullscreen: boolean;
  sidebarCollapsed: boolean;
  phoneLayout: boolean;
  playerWidth: number;
}): boolean {
  const where = opts.fullscreen || (opts.sidebarCollapsed && !opts.phoneLayout);
  return where && opts.playerWidth >= CHAT_PANEL_MIN_PLAYER_WIDTH;
}

/** The panel's width for a player this wide (px) */
export function chatPanelWidth(playerWidth: number): number {
  return Math.round(
    Math.min(
      CHAT_PANEL_MAX_WIDTH,
      Math.max(CHAT_PANEL_MIN_WIDTH, playerWidth * 0.4),
      Math.max(0, playerWidth - 2 * CHAT_PANEL_MARGIN),
    ),
  );
}

/**
 * How much of the player's right side the open panel takes (panel + margin), so the video tiles, the next-episode
 * card and the centred pills can keep clear of it. 0 while it's closed.
 */
export function chatPanelReserve(open: boolean, playerWidth: number): number {
  return open ? chatPanelWidth(playerWidth) + CHAT_PANEL_MARGIN : 0;
}

export interface ChatPanelState {
  open: boolean;
  /** The last value of chatPanelAllowed */
  allowed: boolean;
}

export type ChatPanelAction =
  | { type: "allowed"; allowed: boolean }
  | { type: "toggle" }
  | { type: "open" }
  | { type: "close" };

export const INITIAL_CHAT_PANEL: ChatPanelState = {
  open: false,
  allowed: false,
};

/**
 * Open/closed. It starts collapsed every time it becomes available (entering fullscreen or collapsing the sidebar)
 * and closes when it stops being available (leaving fullscreen, opening the sidebar); it can't open while unavailable.
 */
export function chatPanelReducer(
  state: ChatPanelState,
  action: ChatPanelAction,
): ChatPanelState {
  switch (action.type) {
    case "allowed":
      return action.allowed === state.allowed
        ? state
        : { allowed: action.allowed, open: false };
    case "toggle":
      return state.allowed ? { ...state, open: !state.open } : state;
    case "open":
      return state.allowed && !state.open ? { ...state, open: true } : state;
    case "close":
      return state.open ? { ...state, open: false } : state;
  }
}

/**
 * What `c` does: focus the open panel's input, open the one-line quick chat (fullscreen / sidebar collapsed), or focus
 * the sidebar's chat input.
 */
export function chatKeyTarget(opts: {
  quickChatAllowed: boolean;
  panelOpen: boolean;
}): "panel" | "quick" | "sidebar" {
  if (opts.panelOpen) {
    return "panel";
  }
  return opts.quickChatAllowed ? "quick" : "sidebar";
}

/** Identifies a chat line (the same key ChatOverlay uses) */
export const chatLineKey = (m: ChatMessage) =>
  `${m.timestamp}|${m.id}|${m.cmd ?? ""}`;

/**
 * Whether a line counts towards the unread badge: messages people typed, not your own. System lines (paused, changed
 * the video, now playing, settings changes, ...) don't count: the player already shows what happened (OSD, bubbles),
 * and counting them would make the badge mean "something happened" instead of "someone wrote to you".
 */
export function isUnreadLine(m: ChatMessage, clientId: string): boolean {
  return !m.cmd && !m.system && !isPersonlessLine(m) && m.id !== clientId;
}

export interface UnreadState {
  /** Keys of the lines already accounted for */
  keys: Set<string>;
  unread: number;
  /** The chatInitCount these keys belong to */
  initCount: number;
}

export const INITIAL_UNREAD: UnreadState = {
  keys: new Set(),
  unread: 0,
  initCount: -1,
};

/**
 * Counts messages that arrive while the chat isn't visible (the panel is closed and the sidebar's chat tab isn't on
 * screen). Visible resets the count. A history load (REC:chatinit, on connect and reconnect: `initCount` changed)
 * never counts; reactions don't change keys, so they never count either.
 */
export function updateUnread(
  prev: UnreadState,
  opts: {
    chat: ChatMessage[];
    initCount: number;
    visible: boolean;
    clientId: string;
  },
): UnreadState {
  const keys = new Set(opts.chat.map(chatLineKey));
  if (opts.visible) {
    return { keys, unread: 0, initCount: opts.initCount };
  }
  if (opts.initCount !== prev.initCount) {
    return { keys, unread: prev.unread, initCount: opts.initCount };
  }
  let fresh = 0;
  for (const m of opts.chat) {
    if (!prev.keys.has(chatLineKey(m)) && isUnreadLine(m, opts.clientId)) {
      fresh++;
    }
  }
  return { keys, unread: prev.unread + fresh, initCount: opts.initCount };
}

/** Badge text: "1"…"99", then "99+" */
export const formatUnread = (n: number) => (n > 99 ? "99+" : String(n));

/**
 * How far the on-screen keyboard covers the bottom of the layout viewport (px), from `window.visualViewport`. Browsers
 * that resize only the visual viewport for the keyboard (Chrome on Android by default) would otherwise put the panel's
 * input under it. Small differences (toolbars, pinch zoom rounding) are ignored.
 */
export function keyboardInset(
  layoutHeight: number,
  viewport: { height: number; offsetTop: number } | null | undefined,
): number {
  if (!viewport || !(layoutHeight > 0)) {
    return 0;
  }
  const covered = layoutHeight - viewport.height - viewport.offsetTop;
  return covered > 80 ? Math.round(covered) : 0;
}
