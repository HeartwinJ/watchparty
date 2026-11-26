// Chat interactions beyond sending: replies, emoji and reaction pickers (emoji-mart faked), Esc, scrolling,
// command lines, images, grouping, and who reacted.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

// emoji-mart's Picker is a web component loaded lazily; the fake renders one button per emoji
const pickers: { el: HTMLElement; opts: any }[] = [];
vi.mock("emoji-mart", () => ({
  Picker: class {
    constructor(opts: any) {
      const el = document.createElement("div");
      el.setAttribute("data-testid", "emoji-picker");
      el.dataset.perLine = String(opts.perLine ?? "");
      const btn = document.createElement("button");
      btn.textContent = "pick 🎉";
      btn.onclick = () => opts.onEmojiSelect({ native: "🎉" });
      el.append(btn);
      pickers.push({ el, opts });
      return el;
    }
  },
}));

const { Chat, isContinuation, renderImageString } = await import("./Chat");
const { getOrCreateClientId } = await import("../../utils/utils");
const me = getOrCreateClientId();

const cmd = () => ({
  sendChat: vi.fn(),
  sendChatV2: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
});

function renderChat(
  chat: ChatMessage[] = [],
  props: Partial<React.ComponentProps<typeof Chat>> = {},
) {
  const c = cmd();
  const ref = React.createRef<InstanceType<typeof Chat>>();
  const nameMap = { u1: "Alex", u2: "Bea", [me]: "Me" };
  const ui = (p: Partial<React.ComponentProps<typeof Chat>> = {}) => (
    <MantineProvider env="test">
      <Chat
        ref={ref}
        chat={chat}
        nameMap={nameMap}
        pictureMap={{}}
        cmd={c}
        scrollTimestamp={0}
        getMediaDisplayName={(s) => `name(${s ?? ""})`}
        {...props}
        {...p}
      />
    </MantineProvider>
  );
  const r = render(ui());
  return {
    ...r,
    cmd: c,
    ref,
    rerender: (p: Partial<React.ComponentProps<typeof Chat>>) =>
      r.rerender(ui(p)),
  };
}

beforeEach(() => {
  pickers.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const input = () => screen.getByLabelText("Message") as HTMLInputElement;

describe("composer", () => {
  it("replies to a message with sendChatV2 and can cancel the reply", () => {
    const { cmd } = renderChat([
      { id: "u1", timestamp: "2024-01-01T10:00:00Z", msg: "first" },
    ]);
    fireEvent.click(screen.getByLabelText("Reply to Alex"));
    expect(screen.getByText(/Replying to/).textContent).toContain("Alex");
    fireEvent.click(screen.getByLabelText("Cancel reply"));
    expect(screen.queryByText(/Replying to/)).toBeNull();

    fireEvent.click(screen.getByLabelText("Reply to Alex"));
    fireEvent.change(input(), { target: { value: "yes" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(cmd.sendChatV2).toHaveBeenCalledWith({
      msg: "yes",
      replyToId: "u1",
      replyToTimestamp: "2024-01-01T10:00:00Z",
    });
    expect(cmd.sendChat).not.toHaveBeenCalled();
    expect(screen.queryByText(/Replying to/)).toBeNull();
  });

  it("won't send a message over 10 000 characters", () => {
    const { cmd } = renderChat();
    fireEvent.change(input(), { target: { value: "x".repeat(10001) } });
    expect(screen.getByText("That message is too long.")).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(cmd.sendChat).not.toHaveBeenCalled();
  });

  it("uses a custom placeholder and can be focused from outside", () => {
    const { ref } = renderChat([], { placeholder: "Say something" });
    expect(input().placeholder).toBe("Say something");
    act(() => ref.current!.focusInput());
    expect(document.activeElement).toBe(input());
  });

  it("the emoji picker inserts emoji; Esc closes it first", async () => {
    vi.useFakeTimers();
    const { ref } = renderChat([], { compact: true });
    fireEvent.click(screen.getByLabelText("Insert emoji"));
    act(() => vi.advanceTimersByTime(100));
    vi.useRealTimers();
    const picker = await screen.findByTestId("emoji-picker");
    expect(picker.dataset.perLine).toBe("7");
    fireEvent.click(screen.getByText("pick 🎉"));
    expect(input().value).toBe("🎉");

    const esc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input().dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("emoji-picker")).toBeNull();
    // Nothing open: Esc passes through, closePickers reports false
    const esc2 = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input().dispatchEvent(esc2);
    });
    expect(esc2.defaultPrevented).toBe(false);
    expect(ref.current!.closePickers()).toBe(false);
  });

  it("closes the emoji picker on a click outside it", async () => {
    vi.useFakeTimers();
    renderChat();
    fireEvent.click(screen.getByLabelText("Insert emoji"));
    act(() => vi.advanceTimersByTime(100));
    vi.useRealTimers();
    await screen.findByTestId("emoji-picker");
    act(() => pickers[0].opts.onClickOutside());
    expect(screen.queryByTestId("emoji-picker")).toBeNull();
  });
});

describe("reactions", () => {
  it("the reaction picker adds a reaction to that message, then closes", async () => {
    vi.useFakeTimers();
    const { cmd } = renderChat([{ id: "u1", timestamp: "t1", msg: "hello" }]);
    fireEvent.click(screen.getByLabelText("Add reaction"));
    act(() => vi.advanceTimersByTime(100));
    vi.useRealTimers();
    await waitFor(() => expect(pickers).toHaveLength(1));
    expect(document.querySelector("[class*=selected]")).not.toBeNull();
    act(() => pickers[0].opts.onEmojiSelect({ native: "🎉" }));
    expect(cmd.addReaction).toHaveBeenCalledWith({
      value: "🎉",
      msgId: "u1",
      msgTimestamp: "t1",
    });
  });

  it("the reaction picker closes on a click outside", async () => {
    vi.useFakeTimers();
    renderChat([{ id: "u1", timestamp: "t1", msg: "hello" }]);
    fireEvent.click(screen.getByLabelText("Add reaction"));
    act(() => vi.advanceTimersByTime(100));
    vi.useRealTimers();
    await waitFor(() => expect(pickers).toHaveLength(1));
    act(() => pickers[0].opts.onClickOutside());
    expect(document.querySelector("[class*=selected]")).toBeNull();
  });

  it("clicking someone else's reaction adds ours; the hover card lists who reacted", async () => {
    const users = ["u1", "u2", "a", "b", "c", "d", "e"];
    const { cmd } = renderChat(
      [
        {
          id: "u1",
          timestamp: "t1",
          msg: "hello",
          reactions: { "👍": users, "😂": [] },
        },
      ],
      { portalTarget: document.body },
    );
    const chip = screen.getByRole("button", { name: /👍/ });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.textContent).toContain("7");
    fireEvent.click(chip);
    expect(cmd.addReaction).toHaveBeenCalledWith({
      value: "👍",
      msgId: "u1",
      msgTimestamp: "t1",
    });
    fireEvent.mouseEnter(chip);
    expect(
      await screen.findByText(
        "Alex, Bea, Unknown, Unknown, Unknown and 2 more reacted.",
      ),
    ).toBeTruthy();
  });
});

describe("messages", () => {
  it("describes the classic commands", () => {
    renderChat([
      {
        id: "u1",
        timestamp: "1",
        cmd: "host",
        msg: "https://v.example.com/a.mp4",
      },
      {
        id: "u1",
        timestamp: "2",
        cmd: "playlistAdd",
        msg: "https://v.example.com/b.mp4",
      },
      { id: "u1", timestamp: "3", cmd: "seek", msg: "65" as any },
      { id: "u1", timestamp: "4", cmd: "play", msg: "5" as any },
      { id: "u1", timestamp: "5", cmd: "pause", msg: "5" as any },
      { id: "u1", timestamp: "6", cmd: "playbackRate", msg: "0" },
      { id: "u1", timestamp: "7", cmd: "playbackRate", msg: "1.5" },
      { id: "u1", timestamp: "8", cmd: "someFutureCommand" },
    ]);
    const text = screen.getByRole("log").textContent!;
    expect(text).toContain(
      "changed the video to name(https://v.example.com/a.mp4)",
    );
    expect(text).toContain(
      "added to the queue: name(https://v.example.com/b.mp4)",
    );
    expect(text).toContain("jumped to 01:05");
    expect(text).toContain("started the video at 00:05");
    expect(text).toContain("paused the video at 00:05");
    expect(text).toContain("set the playback rate to auto");
    expect(text).toContain("set the playback rate to 1.5x");
    expect(text).toContain("someFutureCommand");
    // No reply button on command lines
    expect(screen.queryByLabelText("Reply to Alex")).toBeNull();
  });

  it("shows the empty state, System lines, images, video time and replies to me", () => {
    const { container, unmount } = renderChat();
    expect(screen.getByText("No messages yet. Say hi!")).toBeTruthy();
    unmount();
    renderChat([
      { id: "u1", timestamp: "2024-01-01T10:00:00Z", msg: "hi", system: true },
      {
        id: "u2",
        timestamp: "2024-01-01T10:01:00Z",
        msg: "https://img.example.com/cat.png",
        videoTS: 90,
      },
      {
        id: "u1",
        timestamp: "2024-01-01T10:02:00Z",
        msg: "a reply",
        replyToUserId: me,
        replyToMsg: "a very long message that goes on and on and on",
      },
    ]);
    expect(container).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
    expect(
      document.querySelector("img[src='https://img.example.com/cat.png']"),
    ).not.toBeNull();
    expect(screen.getByText(/@ 01:30/)).toBeTruthy();
    expect(
      screen.getByText(/↪ @Me: a very long message that goes.../),
    ).toBeTruthy();
    // Our own messages can't be replied to
    expect(screen.queryByLabelText("Reply to Me")).toBeNull();
  });

  it("shows Jump to latest when scrolled up, and follows new messages only near the bottom", () => {
    const { ref, rerender } = renderChat(
      [{ id: "u1", timestamp: "t1", msg: "a" }],
      {
        scrollTimestamp: 1,
      },
    );
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(log, "offsetHeight", {
      configurable: true,
      value: 200,
    });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    const jump = screen.getByRole("button", { name: "Jump to latest" });
    rerender({ scrollTimestamp: 2 });
    expect(log.scrollTop).toBe(100);
    fireEvent.click(jump);
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 790;
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    log.scrollTop = 500;
    rerender({ scrollTimestamp: 3 });
    expect(log.scrollTop).toBe(1000);
    // Showing the chat again scrolls down
    log.scrollTop = 0;
    rerender({ scrollTimestamp: 3, hide: true });
    expect(log.scrollTop).toBe(1000);
    expect(ref.current).not.toBeNull();
  });
});

describe("helpers", () => {
  const m = (over: Partial<ChatMessage>): ChatMessage => ({
    id: "u1",
    timestamp: "2024-01-01T10:00:00Z",
    msg: "x",
    ...over,
  });
  it("groups messages from the same person within 5 minutes", () => {
    expect(isContinuation(undefined, m({}))).toBe(false);
    expect(
      isContinuation(m({}), m({ timestamp: "2024-01-01T10:04:00Z" })),
    ).toBe(true);
    expect(
      isContinuation(m({}), m({ timestamp: "2024-01-01T10:06:00Z" })),
    ).toBe(false);
    expect(isContinuation(m({}), m({ id: "u2" }))).toBe(false);
    expect(isContinuation(m({ cmd: "play" }), m({}))).toBe(false);
    expect(isContinuation(m({ system: true }), m({}))).toBe(false);
    expect(isContinuation(m({}), m({ replyToUserId: "u2" }))).toBe(false);
    expect(isContinuation(m({}), m({ timestamp: "bad" }))).toBe(false);
  });

  it("renders image links as images only", () => {
    expect(renderImageString("https://x.example.com/a.jpg?w=1")).not.toBeNull();
    expect(renderImageString("https://x.example.com/a.txt")).toBeNull();
    expect(renderImageString(undefined)).toBeNull();
  });
});
