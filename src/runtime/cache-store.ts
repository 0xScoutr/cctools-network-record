/**
 * Durable JSON entries by key: the alarm latches (runtime/feed-health.ts) and
 * the markers of alerts already delivered (scan-record/health.ts). The
 * rendered files and their manifest go to a FileCache instead
 * (open-record/publish.ts), which keeps both in its own storage.
 *
 * `error` means "could not see", never "nothing there": a writer that reads
 * an error as a miss would overwrite a good entry. The default backend is an
 * in-memory map; a deployment plugs in a database table
 * (setCacheStoreBackend).
 */

export type CacheEntry<T> =
  | { status: "hit"; value: T; updatedAt: string | null }
  | { status: "miss" }
  | { status: "error" };

export interface CacheWriteOptions {
  /** Which job wrote the entry, for an audit of the table. */
  source?: string;
  expiresAt?: Date;
}

export interface CacheStoreBackend {
  get(key: string): Promise<CacheEntry<unknown>>;
  set(key: string, value: unknown, options?: CacheWriteOptions): Promise<void>;
}

export function memoryCacheStore(): CacheStoreBackend & { entries: Map<string, { value: unknown; updatedAt: string }> } {
  const entries = new Map<string, { value: unknown; updatedAt: string }>();
  return {
    entries,
    async get(key) {
      const e = entries.get(key);
      return e ? { status: "hit", value: structuredClone(e.value), updatedAt: e.updatedAt } : { status: "miss" };
    },
    async set(key, value) {
      entries.set(key, { value: structuredClone(value), updatedAt: new Date().toISOString() });
    },
  };
}

let backend: CacheStoreBackend = memoryCacheStore();

/** Replace the backend; returns the previous one. */
export function setCacheStoreBackend(next: CacheStoreBackend): CacheStoreBackend {
  const previous = backend;
  backend = next;
  return previous;
}

export async function getCacheEntry<T>(key: string): Promise<CacheEntry<T>> {
  try {
    return (await backend.get(key)) as CacheEntry<T>;
  } catch (err) {
    console.error(`[cache-store] read failed for ${key}:`, err instanceof Error ? err.message : err);
    return { status: "error" };
  }
}

export async function setCached<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
  await backend.set(key, value, options);
}
