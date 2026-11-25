import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { useSlashShortcut } from "./shortcuts";
import { copyInviteLink, inviteLink } from "./invite";

vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
import { toast } from "../ui/toast";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("useSlashShortcut", () => {
  it("opens the picker when / is pressed outside a text field", () => {
    const onOpen = vi.fn();
    renderHook(() => useSlashShortcut(onOpen));
    const event = new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores / while typing, with modifiers, or with a modal open", () => {
    const onOpen = vi.fn();
    renderHook(() => useSlashShortcut(onOpen));
    const { getByRole, getByTestId, unmount } = render(
      <div>
        <input aria-label="chat" />
        <textarea data-testid="area" />
        <div contentEditable data-testid="editable" />
      </div>,
    );
    fireEvent.keyDown(getByRole("textbox", { name: "chat" }), { key: "/" });
    fireEvent.keyDown(getByTestId("area"), { key: "/" });
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "a" });
    expect(onOpen).not.toHaveBeenCalled();
    unmount();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onOpen).not.toHaveBeenCalled();
    dialog.remove();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("stops listening on unmount", () => {
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useSlashShortcut(onOpen));
    unmount();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("copyInviteLink", () => {
  it("builds the link without query or hash", () => {
    expect(
      inviteLink({ origin: "https://w.example", pathname: "/watch/a-b-c" }),
    ).toBe("https://w.example/watch/a-b-c");
  });

  it("copies the link and confirms with a toast", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyInviteLink("https://w.example/watch/x")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://w.example/watch/x");
    expect(toast).toHaveBeenCalledWith(
      "Link copied",
      expect.objectContaining({ tone: "success" }),
    );
  });

  it("shows the link in an error toast when copying fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    expect(await copyInviteLink("https://w.example/watch/x")).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("https://w.example/watch/x"),
      expect.objectContaining({ tone: "danger" }),
    );
  });
});
