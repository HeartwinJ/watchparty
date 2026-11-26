// Quick chat closes by itself after 5 s empty (Esc in fullscreen belongs to the browser).
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickChat } from "./QuickChat";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const onSend = vi.fn();
  const onClose = vi.fn();
  // A re-render with a new onClose (as PlayerArea does) must not restart the countdown
  const view = render(<QuickChat onSend={onSend} onClose={onClose} />);
  const input = screen.getByLabelText("Message everyone");
  const type = (value: string) =>
    act(() => {
      fireEvent.change(input, { target: { value } });
    });
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const ring = () => screen.queryByTestId("quick-chat-countdown");
  return { onSend, onClose, input, type, wait, ring, view };
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
});
