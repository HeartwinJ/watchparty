import { describe, expect, it } from "vitest";
import {
  CHAT_PANEL_MARGIN,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  INITIAL_CHAT_PANEL,
  INITIAL_UNREAD,
  chatKeyTarget,
  chatPanelAllowed,
  chatPanelReducer,
  chatPanelReserve,
  chatPanelWidth,
  formatUnread,
  isUnreadLine,
  keyboardInset,
  updateUnread,
  type ChatPanelAction,
  type ChatPanelState,
  type UnreadState,
} from "./chatPanel";
import {
  positionFromOffset,
  stripInsets,
  stripOffset,
} from "../call/tileLayout";

const ME = "me";
const line = (
  id: string,
  timestamp: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id, timestamp, msg: "hi", ...extra });

describe("chatPanelAllowed", () => {
  const base = {
    fullscreen: false,
    sidebarCollapsed: false,
    phoneLayout: false,
    playerWidth: 1280,
  };
  it("is offered in fullscreen or with the desktop sidebar collapsed", () => {
    expect(chatPanelAllowed(base)).toBe(false);
    expect(chatPanelAllowed({ ...base, fullscreen: true })).toBe(true);
    expect(chatPanelAllowed({ ...base, sidebarCollapsed: true })).toBe(true);
  });
  it("not on the phone layout outside fullscreen (the bottom sheet has the chat)", () => {
    expect(
      chatPanelAllowed({ ...base, sidebarCollapsed: true, phoneLayout: true }),
    ).toBe(false);
    // A phone in landscape fullscreen
    expect(
      chatPanelAllowed({
        ...base,
        fullscreen: true,
        phoneLayout: true,
        playerWidth: 844,
      }),
    ).toBe(true);
  });
  it("not on a tiny player", () => {
    expect(
      chatPanelAllowed({ ...base, fullscreen: true, playerWidth: 390 }),
    ).toBe(false);
  });
});

describe("chatPanelWidth / chatPanelReserve", () => {
  it("is 40% of the player within bounds", () => {
    expect(chatPanelWidth(800)).toBe(320);
    expect(chatPanelWidth(1920)).toBe(CHAT_PANEL_MAX_WIDTH);
    expect(chatPanelWidth(500)).toBe(CHAT_PANEL_MIN_WIDTH);
    // Never wider than the player
    expect(chatPanelWidth(200)).toBe(200 - 2 * CHAT_PANEL_MARGIN);
  });
  it("reserves the panel plus its margin only while open", () => {
    expect(chatPanelReserve(false, 1280)).toBe(0);
    expect(chatPanelReserve(true, 1280)).toBe(
      CHAT_PANEL_MAX_WIDTH + CHAT_PANEL_MARGIN,
    );
  });
  it("keeps the video tiles clear of the open panel", () => {
    const player = { width: 1280, height: 720 };
    const strip = { width: 160, height: 300 };
    const reserve = chatPanelReserve(true, player.width);
    const insets = stripInsets({
      fullscreen: true,
      phone: false,
      controls: true,
      reserve: { right: reserve },
    });
    // A strip the user dragged to the far right is clamped left of the panel
    const pos = positionFromOffset({ x: 5000, y: 0 }, strip, player, insets);
    const at = stripOffset(pos, strip, player, insets);
    expect(at.x + strip.width).toBeLessThanOrEqual(player.width - reserve);
    // The default (top-left) doesn't move
    expect(stripOffset({ fx: 0, fy: 0 }, strip, player, insets).x).toBe(
      insets.left,
    );
  });
});

describe("chatPanelReducer", () => {
  const run = (actions: ChatPanelAction[], from = INITIAL_CHAT_PANEL) =>
    actions.reduce<ChatPanelState>(chatPanelReducer, from);

  it("can't open until it's available", () => {
    expect(run([{ type: "toggle" }]).open).toBe(false);
    expect(run([{ type: "open" }]).open).toBe(false);
  });
  it("toggles, opens and closes while available", () => {
    const allowed: ChatPanelAction = { type: "allowed", allowed: true };
    expect(run([allowed, { type: "toggle" }]).open).toBe(true);
    expect(run([allowed, { type: "toggle" }, { type: "toggle" }]).open).toBe(
      false,
    );
    expect(run([allowed, { type: "open" }, { type: "close" }]).open).toBe(
      false,
    );
  });
  it("starts collapsed every time it becomes available, and closes when it stops", () => {
    const opened = run([
      { type: "allowed", allowed: true },
      { type: "toggle" },
    ]);
    expect(opened.open).toBe(true);
    // Leaving fullscreen / opening the sidebar
    const left = chatPanelReducer(opened, { type: "allowed", allowed: false });
    expect(left.open).toBe(false);
    // Entering fullscreen again: collapsed, not remembered
    expect(
      chatPanelReducer(left, { type: "allowed", allowed: true }).open,
    ).toBe(false);
  });
  it("re-reporting the same availability changes nothing", () => {
    const opened = run([
      { type: "allowed", allowed: true },
      { type: "toggle" },
    ]);
    expect(chatPanelReducer(opened, { type: "allowed", allowed: true })).toBe(
      opened,
    );
  });
});

describe("chatKeyTarget (the c key)", () => {
  it("focuses the open panel's input, else quick chat, else the sidebar", () => {
    expect(chatKeyTarget({ quickChatAllowed: true, panelOpen: true })).toBe(
      "panel",
    );
    expect(chatKeyTarget({ quickChatAllowed: true, panelOpen: false })).toBe(
      "quick",
    );
    expect(chatKeyTarget({ quickChatAllowed: false, panelOpen: false })).toBe(
      "sidebar",
    );
  });
});

describe("unread counting", () => {
  it("counts messages people typed, not system lines or your own", () => {
    expect(isUnreadLine(line("bob", "t"), ME)).toBe(true);
    expect(isUnreadLine(line(ME, "t"), ME)).toBe(false);
    expect(isUnreadLine(line("bob", "t", { cmd: "pause" }), ME)).toBe(false);
    expect(isUnreadLine(line("bob", "t", { system: true }), ME)).toBe(false);
    expect(isUnreadLine(line("", "t", { cmd: "nowPlaying" }), ME)).toBe(false);
  });

  const step = (
    prev: UnreadState,
    chat: ChatMessage[],
    visible: boolean,
    initCount = 1,
  ) => updateUnread(prev, { chat, initCount, visible, clientId: ME });

  it("treats the history load as read and counts later arrivals while hidden", () => {
    const history = [line("bob", "1"), line("cat", "2")];
    let s = step(INITIAL_UNREAD, [], false, 0);
    s = step(s, history, false, 1);
    expect(s.unread).toBe(0);
    s = step(s, [...history, line("bob", "3")], false);
    expect(s.unread).toBe(1);
    s = step(
      s,
      [
        ...history,
        line("bob", "3"),
        line(ME, "4"),
        line("bob", "5", { cmd: "seek" }),
        line("cat", "6"),
      ],
      false,
    );
    expect(s.unread).toBe(2);
  });

  it("resets while the chat is visible and doesn't recount what was seen", () => {
    const chat = [line("bob", "1"), line("bob", "2")];
    let s = step(INITIAL_UNREAD, [], false);
    s = step(s, chat, false);
    expect(s.unread).toBe(2);
    s = step(s, chat, true);
    expect(s.unread).toBe(0);
    s = step(s, chat, false);
    expect(s.unread).toBe(0);
    s = step(s, [...chat, line("cat", "3")], false);
    expect(s.unread).toBe(1);
  });

  it("ignores reactions (same lines) and survives the 100-message cap", () => {
    const chat = [line("bob", "1"), line("bob", "2")];
    let s = step(INITIAL_UNREAD, chat, false);
    s = step(s, chat, true);
    const reacted = [chat[0], { ...chat[1], reactions: { "👍": ["cat"] } }];
    s = step(s, reacted, false);
    expect(s.unread).toBe(0);
    // The oldest line falls off as a new one arrives
    s = step(s, [reacted[1], line("cat", "3")], false);
    expect(s.unread).toBe(1);
  });

  it("a reconnect's history reload doesn't count (even with lines missed meanwhile)", () => {
    let s = step(INITIAL_UNREAD, [line("bob", "1")], false, 1);
    s = step(s, [line("bob", "1"), line("bob", "2")], false, 2);
    expect(s.unread).toBe(0);
  });

  it("formats the badge", () => {
    expect(formatUnread(3)).toBe("3");
    expect(formatUnread(120)).toBe("99+");
  });
});

describe("keyboardInset", () => {
  it("is how much the on-screen keyboard covers", () => {
    expect(keyboardInset(400, { height: 180, offsetTop: 0 })).toBe(220);
    expect(keyboardInset(400, { height: 180, offsetTop: 20 })).toBe(200);
  });
  it("ignores small differences and missing data", () => {
    expect(keyboardInset(800, { height: 760, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(800, null)).toBe(0);
    expect(keyboardInset(0, { height: 0, offsetTop: 0 })).toBe(0);
  });
});
