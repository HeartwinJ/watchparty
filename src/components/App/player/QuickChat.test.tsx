// Quick chat closes by itself after 5 s empty (Esc in fullscreen belongs to the browser), and has an emoji picker.
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import { QuickChat } from "./QuickChat";

// emoji-mart's picker (a web component, loaded lazily) replaced by a search box and one emoji button
vi.mock("../../Chat/EmojiPicker", () => ({
  EmojiPicker: (props: {
    onEmojiSelect: (e: { native: string }) => void;
    onClickOutside?: (e: MouseEvent) => void;
  }) => {
    const propsRef = React.useRef(props);
    propsRef.current = props;
    // Like emoji-mart: any document click outside the picker
    React.useEffect(() => {
      const onDocClick = (e: MouseEvent) => {
        if (!(e.target as Element).closest?.("[data-fake-picker]")) {
          propsRef.current.onClickOutside?.(e);
        }
      };
      document.addEventListener("click", onDocClick);
      return () => document.removeEventListener("click", onDocClick);
    }, []);
    return (
      <div data-fake-picker="">
        <input aria-label="Search emoji" />
        <button
          type="button"
          onClick={() => props.onEmojiSelect({ native: "🎉" })}
        >
          tada
        </button>
      </div>
    );
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(container?: HTMLElement) {
  const onSend = vi.fn();
  const onClose = vi.fn();
  // A re-render with a new onClose (as PlayerArea does) must not restart the countdown
  const view = render(
    <QuickChat onSend={onSend} onClose={onClose} container={container} />,
    { wrapper: MantineProvider },
  );
  const input = screen.getByLabelText("Message everyone") as HTMLInputElement;
  const type = (value: string) =>
    act(() => {
      fireEvent.change(input, { target: { value } });
    });
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const ring = () => screen.queryByTestId("quick-chat-countdown");
  const emojiButton = () =>
    screen.getByRole("button", { name: "Insert emoji" });
  const picker = () => screen.queryByTestId("quick-chat-emoji-picker");
  const clickEmojiButton = () =>
    act(() => {
      fireEvent.click(emojiButton());
    });
  const pick = () =>
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "tada" }));
    });
  const esc = (target: Element) =>
    act(() => {
      fireEvent.keyDown(target, { key: "Escape" });
    });
  return {
    onSend,
    onClose,
    input,
    type,
    wait,
    ring,
    view,
    emojiButton,
    picker,
    clickEmojiButton,
    pick,
    esc,
  };
}

describe("QuickChat", () => {
  it("closes after 5 s with nothing typed, showing the countdown", () => {
    const { onClose, wait, ring, view } = setup();
    expect(ring()).toBeTruthy();
    wait(3_000);
    view.rerender(
      <QuickChat onSend={() => {}} onClose={() => onClose("rerendered")} />,
    );
    wait(1_900);
    expect(onClose).not.toHaveBeenCalled();
    wait(200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("typing cancels the countdown and hides the ring", () => {
    const { onClose, type, wait, ring } = setup();
    wait(4_000);
    type("hello");
    expect(ring()).toBeNull();
    wait(20_000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clearing the input restarts the countdown from 5 s", () => {
    const { onClose, type, wait, ring } = setup();
    wait(4_000);
    type("hi");
    wait(3_000);
    type("");
    expect(ring()).toBeTruthy();
    wait(4_900);
    expect(onClose).not.toHaveBeenCalled();
    wait(200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sending closes it", () => {
    const { onSend, onClose, input, type } = setup();
    type("see you");
    act(() => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(onSend).toHaveBeenCalledWith("see you");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an Enter hint but no Esc hint", () => {
    const { input } = setup();
    const form = input.closest("form")!;
    expect(form.textContent).toContain("Enter");
    expect(form.textContent).not.toContain("Esc");
  });

  describe("Backspace", () => {
    const backspace = (target: Element, repeat = false) =>
      act(() => {
        fireEvent.keyDown(target, { key: "Backspace", repeat });
      });

    it("closes it when the input is already empty", () => {
      const { onClose, input } = setup();
      backspace(input);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("deleting the last character doesn't close it; the next Backspace does", () => {
      const { onClose, input, type } = setup();
      type("a");
      // The keydown comes before the character is removed
      backspace(input);
      type("");
      expect(onClose).not.toHaveBeenCalled();
      backspace(input);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("a held-down (repeating) Backspace doesn't close it", () => {
      const { onClose, input } = setup();
      backspace(input, true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("doesn't close it while the emoji picker is open", () => {
      const { onClose, input, clickEmojiButton } = setup();
      clickEmojiButton();
      backspace(input);
      backspace(screen.getByLabelText("Search emoji"));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("emoji picker", () => {
    it("opens from the emoji button", () => {
      const { emojiButton, picker, clickEmojiButton } = setup();
      expect(emojiButton().getAttribute("aria-expanded")).toBe("false");
      expect(picker()).toBeNull();
      clickEmojiButton();
      expect(picker()).toBeTruthy();
      expect(emojiButton().getAttribute("aria-expanded")).toBe("true");
      // Keys in the picker (its search box) are kept from the player shortcuts
      expect(picker()!.hasAttribute("data-no-shortcuts")).toBe(true);
    });

    it("inserts at the caret, keeps focus in the input and stays open for more picks", () => {
      const { input, type, clickEmojiButton, pick, picker } = setup();
      type("hello world");
      input.setSelectionRange(5, 5);
      clickEmojiButton();
      pick();
      expect(input.value).toBe("hello🎉 world");
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(7);
      pick();
      expect(input.value).toBe("hello🎉🎉 world");
      expect(input.selectionStart).toBe(9);
      expect(picker()).toBeTruthy();
    });

    it("replaces the selection", () => {
      const { input, type, clickEmojiButton, pick } = setup();
      type("hello world");
      input.setSelectionRange(6, 11);
      clickEmojiButton();
      pick();
      expect(input.value).toBe("hello 🎉");
    });

    it("pauses the countdown while open and restarts it after closing empty", () => {
      const { onClose, wait, ring, clickEmojiButton, input } = setup();
      wait(4_000);
      clickEmojiButton();
      expect(ring()).toBeNull();
      // Focus moving into the picker doesn't close the empty quick chat either
      act(() => {
        fireEvent.blur(input);
      });
      wait(30_000);
      expect(onClose).not.toHaveBeenCalled();
      clickEmojiButton();
      expect(ring()).toBeTruthy();
      wait(4_900);
      expect(onClose).not.toHaveBeenCalled();
      wait(200);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closing it with text keeps the countdown off", () => {
      const { onClose, wait, ring, clickEmojiButton, pick } = setup();
      clickEmojiButton();
      pick();
      clickEmojiButton();
      expect(ring()).toBeNull();
      wait(20_000);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Esc closes only the picker first, then the quick chat", () => {
      const { onClose, input, picker, clickEmojiButton, esc } = setup();
      clickEmojiButton();
      // From the picker's search box
      esc(screen.getByLabelText("Search emoji"));
      expect(picker()).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      // From the input
      clickEmojiButton();
      esc(input);
      expect(picker()).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      esc(input);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Esc in the picker reaches the player's key handler already handled", () => {
      const { clickEmojiButton, esc } = setup();
      clickEmojiButton();
      const seen = vi.fn();
      const onKey = (e: KeyboardEvent) => seen(e.defaultPrevented);
      window.addEventListener("keydown", onKey);
      try {
        esc(screen.getByLabelText("Search emoji"));
      } finally {
        window.removeEventListener("keydown", onKey);
      }
      expect(seen).not.toHaveBeenCalledWith(false);
    });

    it("a click outside closes it; clicks on the bar don't", () => {
      const { input, picker, clickEmojiButton } = setup();
      clickEmojiButton();
      act(() => {
        fireEvent.click(input);
      });
      expect(picker()).toBeTruthy();
      act(() => {
        fireEvent.click(document.body);
      });
      expect(picker()).toBeNull();
    });

    it("renders into the player container", () => {
      const container = document.createElement("div");
      document.body.append(container);
      try {
        const { clickEmojiButton, picker } = setup(container);
        clickEmojiButton();
        expect(picker()!.parentElement).toBe(container);
      } finally {
        container.remove();
      }
    });
  });
});
