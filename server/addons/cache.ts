/**
 * Small in-memory TTL + LRU cache with de-duplication of concurrent loads.
 * Failed loads are not cached.
 */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();
  private inflight = new Map<string, Promise<V>>();
  private maxEntries: number;
  private now: () => number;

  constructor(opts: { maxEntries: number; now?: () => number }) {
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? Date.now;
  }

  get size() {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so Map iteration order tracks recency (oldest first)
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
    }
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
  }

  /**
   * Returns the cached value, or runs `load` once even if several callers ask
   * for the same key at the same time.
   */
  async wrap(key: string, ttlMs: number, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const promise = (async () => {
      try {
        const value = await load();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }
}
