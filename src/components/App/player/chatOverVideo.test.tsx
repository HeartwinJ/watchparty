// Chat over the video: quick chat keys/blur, chat bubbles (names, system lines, fading, max 4) and the chat panel
// (hover, keyboard inset from visualViewport).
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { MantineProvider } from "@mantine/core";
import { QuickChat } from "./QuickChat";
import { ChatOverlay } from "./ChatOverlay";
import { ChatPanel } from "./ChatPanel";
import { renderWithPlayerRoom } from "../../../test/playerRoom";
import { installVisualViewport } from "../../../test/browserFakes";

vi.mock("emoji-mart", () => ({
  Picker: class {
    constructor() {
      return document.createElement("div");
    }
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("QuickChat", () => {
  it("Esc closes without sending; other keys don't", () => {
    const onClose = vi.fn();
    const onSend = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <QuickChat onSend={onSend} onClose={onClose} />
      </div>,
      { wrapper: MantineProvider },
    );
    const input = screen.getByLabelText("Message everyone");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    // The Esc doesn't reach the player's handler
    expect(outer).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blur closes it only when empty", () => {
    const onClose = vi.fn();
    render(<QuickChat onSend={() => {}} onClose={onClose} />, {
      wrapper: MantineProvider,
    });
    const input = screen.getByLabelText("Message everyone");
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.blur(input);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter on whitespace just closes", () => {
    const onClose = vi.fn();
    const onSend = vi.fn();
    render(<QuickChat onSend={onSend} onClose={onClose} />, {
      wrapper: MantineProvider,
    });
    const input = screen.getByLabelText("Message everyone");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.submit(input.closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ChatOverlay", () => {
  const base = {
    nameMap: { a: "Alex" },
    clientId: "me",
    mediaName: (u?: string) => u ?? "",
    chatting: false,
  };
  const line = (n: number, over: Partial<ChatMessage> = {}) =>
    ({ id: "a", msg: `m${n}`, timestamp: `t${n}`, ...over }) as ChatMessage;

  it("doesn't replay history, then shows new lines with names", () => {
    const { rerender, container } = render(
      <ChatOverlay {...base} chat={[line(0)]} />,
    );
    expect(screen.queryByText("m0")).toBeNull();
    rerender(
      <ChatOverlay
        {...base}
        chatting
        chat={[
          line(0),
          line(1, { id: "me" }),
          line(2, { id: "zed" }),
          line(3, { cmd: "pause", msg: "60" }),
          // Unknown commands have no text and are skipped
          line(4, { cmd: "mystery" }),
        ]}
      />,
    );
    const names = [...container.querySelectorAll("b")].map(
      (b) => b.textContent,
    );
    expect(names).toEqual(["You", "Someone", "Alex"]);
    expect(screen.getByText("paused the video at 01:00")).toBeTruthy();
    expect(
      screen.getByText("paused the video at 01:00").getAttribute("data-system"),
    ).toBe("true");
    expect(container.firstElementChild!.getAttribute("data-chatting")).toBe(
      "true",
    );
  });

  it("only unknown commands: nothing to show", () => {
    const { rerender, container } = render(<ChatOverlay {...base} chat={[]} />);
    rerender(<ChatOverlay {...base} chat={[line(1, { cmd: "mystery" })]} />);
    expect(container.firstElementChild!.children).toHaveLength(0);
    // Re-rendering with the same lines adds nothing
    rerender(<ChatOverlay {...base} chat={[line(1, { cmd: "mystery" })]} />);
    expect(container.firstElementChild!.children).toHaveLength(0);
  });

  it("keeps the last 4 and fades each one out", () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<ChatOverlay {...base} chat={[]} />);
    const lines = [1, 2, 3, 4, 5].map((n) => line(n));
    rerender(<ChatOverlay {...base} chat={lines} />);
    const bubbles = () => [...container.firstElementChild!.children];
    expect(bubbles().map((b) => b.textContent)).toEqual([
      "Alexm2",
      "Alexm3",
      "Alexm4",
      "Alexm5",
    ]);
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(
      bubbles().every((b) => b.getAttribute("data-leaving") === "true"),
    ).toBe(true);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(bubbles()).toHaveLength(0);
  });

  it("clears its timers on unmount", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(window, "clearTimeout");
    const { rerender, unmount } = render(<ChatOverlay {...base} chat={[]} />);
    rerender(<ChatOverlay {...base} chat={[line(1)]} />);
    unmount();
    expect(clear).toHaveBeenCalledTimes(2);
  });
});

describe("ChatPanel", () => {
  let innerHeight: number;
  beforeEach(() => {
    innerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: innerHeight,
    });
    delete (window as any).visualViewport;
  });

  function setup(open = true) {
    const onClose = vi.fn();
    const onHoverChange = vi.fn();
    const r = renderWithPlayerRoom(
      (room) => (
        <ChatPanel
          room={room}
          open={open}
          width={320}
          container={null}
          chatRef={createRef()}
          onClose={onClose}
          onHoverChange={onHoverChange}
        />
      ),
      { state: { roomMedia: "https://example.com/a.mp4" } },
    );
    const panel = document.querySelector(
      'section[aria-label="Chat"]',
    ) as HTMLElement;
    return { ...r, onClose, onHoverChange, panel };
  }

  it("lifts above the on-screen keyboard while open", () => {
    const vv = installVisualViewport(800, 0);
    const { panel } = setup();
    expect(panel.getAttribute("data-kb")).toBeNull();
    act(() => vv.update({ height: 450 }));
    expect(panel.getAttribute("data-kb")).toBe("true");
    expect(panel.style.getPropertyValue("--wp-kb-inset")).toBe("350px");
    act(() => vv.update({ height: 790 }));
    expect(panel.getAttribute("data-kb")).toBeNull();
  });

  it("ignores the keyboard while closed", () => {
    installVisualViewport(400, 0);
    const { panel } = setup(false);
    expect(panel.getAttribute("data-kb")).toBeNull();
    expect(panel.getAttribute("aria-hidden")).toBe("true");
  });

  it("reports mouse hover, closes from its button", () => {
    const { panel, onHoverChange, onClose } = setup();
    expect(panel.style.getPropertyValue("--wp-chat-panel-w")).toBe("320px");
    fireEvent.pointerEnter(panel, { pointerType: "touch" });
    fireEvent.pointerEnter(panel, { pointerType: "mouse" });
    fireEvent.pointerLeave(panel, { pointerType: "mouse" });
    expect(onHoverChange.mock.calls).toEqual([[true], [false]]);
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(onClose).toHaveBeenCalled();
  });
});
