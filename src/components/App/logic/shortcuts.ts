// Room keyboard shortcuts.

export type ShortcutAction =
  | { type: "togglePlay" }
  | { type: "seekBy"; seconds: number }
  | { type: "volumeBy"; delta: number }
  | { type: "toggleMute" }
  | { type: "toggleCamera" }
  | { type: "toggleFullscreen" }
  | { type: "chat" }
  | { type: "subtitleOffsetBy"; delta: number }
  | { type: "showShortcuts" }
  | { type: "escape" };

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
  defaultPrevented?: boolean;
}

/** Whether an element takes text input (shortcuts must not fire while typing) */
export function isTypingTarget(target: EventTarget | null | undefined) {
  if (!target || typeof (target as Element).closest !== "function") {
    return false;
  }
  const el = target as HTMLElement;
  if (el.isContentEditable) {
    return true;
  }
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    // Sliders, checkboxes and buttons don't take text; arrows on a focused slider are handled by the slider itself
    return ![
      "button",
      "checkbox",
      "radio",
      "range",
      "submit",
      "reset",
      "file",
      "color",
      "image",
    ].includes(type);
  }
  return Boolean(el.closest('[contenteditable="true"], [role="textbox"]'));
}

/** Whether the event happened inside a modal dialog (shortcuts are off while one is open) */
export function isInModal(target: EventTarget | null | undefined) {
  if (!target || typeof (target as Element).closest !== "function") {
    return false;
  }
  return Boolean((target as Element).closest('[aria-modal="true"]'));
}

/** Maps a key press to a player action, or null (typing, modifier chords, unknown keys). */
export function resolveShortcut(e: KeyLike): ShortcutAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) {
    return null;
  }
  if (e.key === "Escape") {
    return { type: "escape" };
  }
  if (isTypingTarget(e.target) || isInModal(e.target)) {
    return null;
  }
  const isSlider =
    (e.target as HTMLInputElement | null)?.tagName === "INPUT" &&
    (e.target as HTMLInputElement).type === "range";
  switch (e.key) {
    case " ":
    case "k":
    case "K":
      return { type: "togglePlay" };
    case "ArrowLeft":
      return isSlider ? null : { type: "seekBy", seconds: -10 };
    case "ArrowRight":
      return isSlider ? null : { type: "seekBy", seconds: 10 };
    case "ArrowUp":
      return isSlider ? null : { type: "volumeBy", delta: 0.05 };
    case "ArrowDown":
      return isSlider ? null : { type: "volumeBy", delta: -0.05 };
    case "m":
    case "M":
      return { type: "toggleMute" };
    case "v":
    case "V":
      // Only does something in a voice call (PlayerArea)
      return { type: "toggleCamera" };
    case "f":
    case "F":
      return { type: "toggleFullscreen" };
    case "c":
    case "C":
      return { type: "chat" };
    case "[":
      return { type: "subtitleOffsetBy", delta: -0.1 };
    case "]":
      return { type: "subtitleOffsetBy", delta: 0.1 };
    case "?":
      return { type: "showShortcuts" };
    default:
      return null;
  }
}

/** Rows for the shortcuts overlay */
export const SHORTCUT_GROUPS: { title: string; rows: [string, string[]][] }[] =
  [
    {
      title: "Playback",
      rows: [
        ["Play / pause", ["Space", "k"]],
        ["Back / forward 10 s", ["←", "→"]],
        ["Volume up / down", ["↑", "↓"]],
        ["Mute", ["m"]],
        ["Fullscreen", ["f"]],
        ["Subtitle offset −/+ 0.1 s", ["[", "]"]],
      ],
    },
    {
      title: "Room",
      rows: [
        ["Change video (picker)", ["/"]],
        ["Chat (quick input in fullscreen)", ["c"]],
        ["Close menu / exit fullscreen", ["Esc"]],
        ["This overlay", ["?"]],
      ],
    },
    {
      title: "Voice call",
      rows: [
        ["Mute / unmute your mic (instead of the video)", ["m"]],
        ["Camera on / off", ["v"]],
        ["Push to talk (when on in the call panel)", ["hold t"]],
      ],
    },
    {
      title: "Mouse & touch",
      rows: [
        ["Click video", ["play / pause"]],
        ["Double-click video", ["fullscreen"]],
        ["Tap (phone)", ["show / hide controls"]],
        ["Double-tap left / right", ["−10 s / +10 s"]],
      ],
    },
  ];
