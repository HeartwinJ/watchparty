/**
 * Keyboard model for the palette: every selectable row is a role="option" element that registers its actions here.
 * Navigation follows DOM order (so it always matches what's on screen), Enter runs the active option's primary
 * action and Shift+Enter its secondary one (add to queue). The input keeps focus and points at the active option
 * with aria-activedescendant.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface OptionHandlers {
  primary: () => void;
  secondary?: () => void;
}

interface OptionsApi {
  activeId: string | null;
  setActive: (id: string) => void;
  register: (id: string, handlers: { current: OptionHandlers }) => () => void;
}

const OptionsContext = createContext<OptionsApi | null>(null);
/** True when the picker was opened to add to the queue: rows swap "play now" and "add to queue" */
const QueueModeContext = createContext(false);

export const useQueueMode = () => useContext(QueueModeContext);

export function useOptionsController(
  listRef: React.RefObject<HTMLElement | null>,
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const handlers = useRef(new Map<string, { current: OptionHandlers }>());
  const pending = useRef(false);

  const elements = useCallback(
    () =>
      Array.from(
        listRef.current?.querySelectorAll<HTMLElement>(
          '[role="option"]:not([aria-disabled="true"])',
        ) ?? [],
      ),
    [listRef],
  );

  const setActive = useCallback((id: string) => {
    if (activeRef.current !== id) {
      activeRef.current = id;
      setActiveId(id);
    }
  }, []);

  /** Keeps the active option valid as options mount/unmount: falls back to the first one */
  const sync = useCallback(() => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    queueMicrotask(() => {
      pending.current = false;
      const els = elements();
      const current = activeRef.current;
      if (current && els.some((el) => el.id === current)) {
        return;
      }
      const first = els[0]?.id ?? null;
      activeRef.current = first;
      setActiveId(first);
    });
  }, [elements]);

  const register = useCallback(
    (id: string, h: { current: OptionHandlers }) => {
      handlers.current.set(id, h);
      sync();
      return () => {
        if (handlers.current.get(id) === h) {
          handlers.current.delete(id);
        }
        sync();
      };
    },
    [sync],
  );

  const move = useCallback(
    (delta: number) => {
      const els = elements();
      if (!els.length) {
        return;
      }
      const index = els.findIndex((el) => el.id === activeRef.current);
      const next =
        index < 0
          ? delta > 0
            ? 0
            : els.length - 1
          : Math.min(Math.max(index + delta, 0), els.length - 1);
      const el = els[next];
      setActive(el.id);
      el.scrollIntoView?.({ block: "nearest" });
    },
    [elements, setActive],
  );

  const run = useCallback((secondary: boolean) => {
    const id = activeRef.current;
    const h = id ? handlers.current.get(id)?.current : undefined;
    if (!h) {
      return false;
    }
    if (secondary) {
      if (!h.secondary) {
        return false;
      }
      h.secondary();
    } else {
      h.primary();
    }
    return true;
  }, []);

  const api = useMemo<OptionsApi>(
    () => ({ activeId, setActive, register }),
    [activeId, setActive, register],
  );
  return { api, activeId, move, run, sync };
}

export function OptionsProvider({
  api,
  queueMode = false,
  children,
}: {
  api: OptionsApi;
  queueMode?: boolean;
  children: React.ReactNode;
}) {
  return (
    <QueueModeContext.Provider value={queueMode}>
      <OptionsContext.Provider value={api}>{children}</OptionsContext.Provider>
    </QueueModeContext.Provider>
  );
}

/**
 * Registers a selectable row. Spread the returned props on its element. `id` must be unique in the palette.
 * Clicking the row runs `primary`, unless the click hit a button/link inside it.
 */
export function useOption(id: string, handlers: OptionHandlers) {
  const ctx = useContext(OptionsContext);
  const ref = useRef(handlers);
  ref.current = handlers;
  useLayoutEffect(() => ctx?.register(id, ref), [ctx, id]);
  const selected = ctx?.activeId === id;
  return {
    selected,
    props: {
      id,
      role: "option" as const,
      "aria-selected": selected,
      onMouseMove: () => ctx?.setActive(id),
      onClick: (e: React.MouseEvent) => {
        const hit = (e.target as HTMLElement).closest("button, a, input");
        if (hit && hit !== e.currentTarget) {
          // A nested control (Play, Add to queue, ...) handles its own click
          return;
        }
        ref.current.primary();
      },
    },
  };
}
