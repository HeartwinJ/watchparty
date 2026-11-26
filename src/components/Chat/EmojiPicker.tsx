import { useEffect, useRef } from "react";

type EmojiPickerProps = {
  theme?: "auto" | "light" | "dark";
  previewPosition?: "top" | "bottom" | "none";
  maxFrequentRows?: number;
  perLine?: number;
  onEmojiSelect: (emoji: { native: string }) => void;
  /** Any click outside the picker (the document's click event, retargeted to the picker's host if inside it) */
  onClickOutside?: (e: MouseEvent) => void;
};

/**
 * emoji-mart's picker (a web component), loaded on first use so it stays out of the main bundle. Replaces
 * @emoji-mart/react, which doesn't support React 19. Like before, the emoji data is fetched from emoji-mart's CDN.
 */
export const EmojiPicker = (props: EmojiPickerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // The picker is created once; route callbacks through a ref so they stay current
  const propsRef = useRef(props);
  propsRef.current = props;
  const { theme, previewPosition, maxFrequentRows, perLine } = props;

  useEffect(() => {
    let cancelled = false;
    let picker: HTMLElement | undefined;
    import("emoji-mart").then(({ Picker }) => {
      if (cancelled || !containerRef.current) {
        return;
      }
      picker = new Picker({
        theme,
        previewPosition,
        maxFrequentRows,
        perLine,
        onEmojiSelect: (emoji: { native: string }) =>
          propsRef.current.onEmojiSelect(emoji),
        onClickOutside: (e: MouseEvent) => propsRef.current.onClickOutside?.(e),
      }) as unknown as HTMLElement;
      containerRef.current.append(picker);
    });
    return () => {
      cancelled = true;
      picker?.remove();
    };
  }, [theme, previewPosition, maxFrequentRows, perLine]);

  return <div ref={containerRef} />;
};
