import { useMemo, useReducer, useRef } from "react";

export type Store<S> = {
  /** The latest state, including updates made earlier in the same event handler */
  get: () => S;
  /** Shallow-merges a patch into the state (synchronously) and re-renders */
  set: (patch: Partial<S> | ((state: S) => Partial<S>)) => void;
};

/**
 * State that socket handlers, timers and player callbacks can read synchronously via get(), like a class component's
 * this.state after setState. Rendering uses the returned snapshot as usual.
 */
export function useStore<S extends object>(init: () => S): [S, Store<S>] {
  const ref = useRef<S | null>(null);
  if (ref.current === null) {
    ref.current = init();
  }
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const store = useMemo<Store<S>>(
    () => ({
      get: () => ref.current!,
      set: (patch) => {
        const current = ref.current!;
        const changes = typeof patch === "function" ? patch(current) : patch;
        ref.current = { ...current, ...changes };
        forceRender();
      },
    }),
    [],
  );
  return [ref.current, store];
}
