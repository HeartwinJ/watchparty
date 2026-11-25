import { useCallback, useEffect, useState } from "react";
import { isAbortError } from "../../../api/addons";

/** Small in-memory cache so going back through the palette (or reopening it) is instant */
const cache = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 100;

export function getCached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) {
    return undefined;
  }
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function setCached(key: string, value: unknown) {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  if (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
}

export function clearPickerCache() {
  cache.clear();
}

export interface LoadState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  retry: () => void;
}

/**
 * Loads `key` with `fn` (cancelled via AbortSignal when the key changes or the component unmounts) and caches the
 * result. A null key loads nothing.
 */
export function useLoad<T>(
  key: string | null,
  fn: (signal: AbortSignal) => Promise<T>,
): LoadState<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    data: T | undefined;
    error: unknown;
  }>(() => ({
    key,
    data: key ? getCached<T>(key) : undefined,
    error: undefined,
  }));

  useEffect(() => {
    if (!key) {
      setState({ key, data: undefined, error: undefined });
      return;
    }
    const cached = getCached<T>(key);
    if (cached !== undefined) {
      setState({ key, data: cached, error: undefined });
      return;
    }
    setState((s) =>
      s.key === key && s.data === undefined && !s.error
        ? s
        : { key, data: undefined, error: undefined },
    );
    const controller = new AbortController();
    fn(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setCached(key, data);
          setState({ key, data, error: undefined });
        }
      },
      (error) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setState({ key, data: undefined, error });
        }
      },
    );
    return () => controller.abort();
    // fn is expected to depend only on key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const retry = useCallback(() => {
    if (key) {
      cache.delete(key);
    }
    setAttempt((a) => a + 1);
  }, [key]);

  const current = state.key === key;
  const data = current ? state.data : key ? getCached<T>(key) : undefined;
  const error = current ? state.error : undefined;
  return {
    data,
    error,
    loading: Boolean(key) && data === undefined && !error,
    retry,
  };
}
