import { describe, expect, it } from "vitest";
import { isTypingTarget, resolveShortcut } from "./shortcuts";

const el = (html: string) => {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  document.body.append(wrap);
  return wrap.querySelector("[data-t]") as HTMLElement;
};

describe("resolveShortcut", () => {
  it("maps the documented keys", () => {
    const body = document.body;
    const k = (key: string) => resolveShortcut({ key, target: body });
    expect(k(" ")).toEqual({ type: "togglePlay" });
    expect(k("k")).toEqual({ type: "togglePlay" });
    expect(k("ArrowLeft")).toEqual({ type: "seekBy", seconds: -10 });
    expect(k("ArrowRight")).toEqual({ type: "seekBy", seconds: 10 });
    expect(k("ArrowUp")).toEqual({ type: "volumeBy", delta: 0.05 });
    expect(k("ArrowDown")).toEqual({ type: "volumeBy", delta: -0.05 });
    expect(k("m")).toEqual({ type: "toggleMute" });
    expect(k("v")).toEqual({ type: "toggleCamera" });
    expect(k("V")).toEqual({ type: "toggleCamera" });
    expect(k("f")).toEqual({ type: "toggleFullscreen" });
    expect(k("c")).toEqual({ type: "chat" });
    expect(k("[")).toEqual({ type: "subtitleOffsetBy", delta: -0.1 });
    expect(k("]")).toEqual({ type: "subtitleOffsetBy", delta: 0.1 });
    expect(k("?")).toEqual({ type: "showShortcuts" });
    expect(k("Escape")).toEqual({ type: "escape" });
    expect(k("x")).toBeNull();
  });

  it("Shift+C toggles the chat panel; c (or C with caps lock) is quick chat", () => {
    const body = document.body;
    expect(resolveShortcut({ key: "C", shiftKey: true, target: body })).toEqual(
      { type: "chatPanel" },
    );
    expect(resolveShortcut({ key: "C", target: body })).toEqual({
      type: "chat",
    });
    expect(resolveShortcut({ key: "c", target: body })).toEqual({
      type: "chat",
    });
    // Typing a capital C in a chat input is just typing
    expect(
      resolveShortcut({
        key: "C",
        shiftKey: true,
        target: el("<input data-t>"),
      }),
    ).toBeNull();
  });

  it("keys inside the chat panel (data-no-shortcuts) stay there, except Esc", () => {
    const button = el(
      '<section data-no-shortcuts=""><button data-t>👍</button></section>',
    );
    for (const key of [" ", "k", "f", "m", "ArrowLeft"]) {
      expect(resolveShortcut({ key, target: button })).toBeNull();
    }
    expect(resolveShortcut({ key: "C", shiftKey: true, target: button })).toBe(
      null,
    );
    expect(resolveShortcut({ key: "Escape", target: button })).toEqual({
      type: "escape",
    });
  });

  it("ignores keys while typing (offset keys included)", () => {
    for (const html of [
      '<input data-t type="text">',
      "<input data-t>",
      '<input data-t type="search">',
      "<textarea data-t></textarea>",
      '<div data-t contenteditable="true"></div>',
      '<div role="textbox"><span data-t></span></div>',
    ]) {
      const target = el(html);
      expect(isTypingTarget(target)).toBe(true);
      for (const key of ["[", "]", " ", "f", "c", "?", "ArrowLeft"]) {
        expect(resolveShortcut({ key, target })).toBeNull();
      }
    }
  });

  it("still works on buttons, checkboxes and the body", () => {
    expect(
      resolveShortcut({ key: "]", target: el("<button data-t></button>") }),
    ).toEqual({ type: "subtitleOffsetBy", delta: 0.1 });
    expect(
      resolveShortcut({
        key: "[",
        target: el('<input data-t type="checkbox">'),
      }),
    ).toEqual({ type: "subtitleOffsetBy", delta: -0.1 });
    expect(resolveShortcut({ key: "]", target: null })).toEqual({
      type: "subtitleOffsetBy",
      delta: 0.1,
    });
  });

  it("leaves arrows to a focused slider", () => {
    const slider = el('<input data-t type="range">');
    expect(resolveShortcut({ key: "ArrowLeft", target: slider })).toBeNull();
    expect(resolveShortcut({ key: "ArrowUp", target: slider })).toBeNull();
    expect(resolveShortcut({ key: "]", target: slider })).not.toBeNull();
  });

  it("ignores modifier chords, handled events and modals", () => {
    const body = document.body;
    expect(
      resolveShortcut({ key: "f", ctrlKey: true, target: body }),
    ).toBeNull();
    expect(
      resolveShortcut({ key: "k", metaKey: true, target: body }),
    ).toBeNull();
    expect(
      resolveShortcut({ key: "]", altKey: true, target: body }),
    ).toBeNull();
    expect(
      resolveShortcut({ key: " ", defaultPrevented: true, target: body }),
    ).toBeNull();
    const inModal = el('<div aria-modal="true"><button data-t></button></div>');
    expect(resolveShortcut({ key: "f", target: inModal })).toBeNull();
    // Escape still closes things
    expect(resolveShortcut({ key: "Escape", target: inModal })).toEqual({
      type: "escape",
    });
  });
});
