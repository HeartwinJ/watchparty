import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "./Player.module.css";

/**
 * A dark-glass player menu. Portalled into the player container (so it works in element fullscreen), or into the body
 * as a bottom sheet on a phone outside fullscreen (the inline player is too small there). Closes on Escape and on a
 * pointer down outside it (except on its own trigger, which toggles it).
 */
export function PlayerMenu(props: {
  open: boolean;
  onClose: () => void;
  /** Where to portal (the player container); null renders a bottom sheet in the body */
  target: HTMLElement | null;
  sheet: boolean;
  label: string;
  id: string;
  size?: "small";
  trigger?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const { open, onClose, trigger } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || trigger?.current?.contains(t)) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        trigger?.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    // Move focus into the menu so keyboard users land on the options
    const first = ref.current?.querySelector<HTMLElement>(
      '[aria-checked="true"], button, input',
    );
    first?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, trigger]);

  if (!open) {
    return null;
  }
  const sheet = props.sheet;
  const menu = (
    <>
      {sheet && <div className={styles.sheetScrim} aria-hidden="true" />}
      <div
        ref={ref}
        id={props.id}
        className={styles.menu}
        data-sheet={sheet}
        data-size={props.size}
        role="dialog"
        aria-label={props.label}
        // Clicks inside a menu must not reach the video's click-to-pause layer
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {props.children}
      </div>
    </>
  );
  const target = sheet ? document.body : props.target;
  return target ? createPortal(menu, target) : menu;
}
