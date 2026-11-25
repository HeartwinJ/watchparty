import React, { createContext, useCallback, useContext, useMemo } from "react";

/**
 * Room-level UI state shared by the redesigned views (shell, player, source picker).
 * Kept separate from the room's socket/media state in useRoom so view components can
 * coordinate (e.g. the top bar opens the picker, the player shows chat bubbles when the
 * sidebar is collapsed) without importing each other.
 */
export interface RoomUi {
  /** Source picker (command palette) */
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  /** Desktop sidebar (Chat / Queue / People) */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  /** Chat bubbles over the video when the sidebar is collapsed or in fullscreen */
  chatOverlayEnabled: boolean;
  setChatOverlayEnabled: (enabled: boolean) => void;
  /** Room settings modal (opened from the top bar's overflow menu or the room name) */
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
}

const RoomUiContext = createContext<RoomUi | null>(null);

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode); the setting just won't persist
  }
}

export function RoomUiProvider({ children }: { children: React.ReactNode }) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [sidebarCollapsed, setCollapsed] = React.useState(() =>
    readBool("wp-sidebar-collapsed", false),
  );
  const [chatOverlayEnabled, setOverlay] = React.useState(() =>
    readBool("wp-chat-overlay", true),
  );

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setCollapsed(collapsed);
    writeBool("wp-sidebar-collapsed", collapsed);
  }, []);
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      writeBool("wp-sidebar-collapsed", !c);
      return !c;
    });
  }, []);
  const setChatOverlayEnabled = useCallback((enabled: boolean) => {
    setOverlay(enabled);
    writeBool("wp-chat-overlay", enabled);
  }, []);
  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const value = useMemo<RoomUi>(
    () => ({
      pickerOpen,
      openPicker,
      closePicker,
      sidebarCollapsed,
      setSidebarCollapsed,
      toggleSidebar,
      chatOverlayEnabled,
      setChatOverlayEnabled,
      settingsOpen,
      openSettings,
      closeSettings,
    }),
    [
      pickerOpen,
      openPicker,
      closePicker,
      sidebarCollapsed,
      setSidebarCollapsed,
      toggleSidebar,
      chatOverlayEnabled,
      setChatOverlayEnabled,
      settingsOpen,
      openSettings,
      closeSettings,
    ],
  );
  return (
    <RoomUiContext.Provider value={value}>{children}</RoomUiContext.Provider>
  );
}

export function useRoomUi(): RoomUi {
  const ctx = useContext(RoomUiContext);
  if (!ctx) {
    throw new Error("useRoomUi must be used inside <RoomUiProvider>");
  }
  return ctx;
}
