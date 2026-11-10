/**
 * Small key-value state shared by every caller of one Scan host: the 429
 * gate, the call queue, the Super Validators' one place in flight and their
 * 429 count, a host marked down, the host that served the last read, the
 * cached migration id, the ACS endpoint a host was switched to and the job
 * locks.
 *
 * The functions keep one contract whatever backend holds the state. A read
 * that fails answers "nothing stored" (sharedGet) or `ok: false`
 * (sharedGetStrict, sharedReserveSlotStrict), so a caller that rations an
 * upstream can fail closed. A claim that fails answers false.
 *
 * The default backend is an in-memory map, which is right for one process
 * (the verify CLI, the tests, a single worker). A deployment with several
 * worker processes plugs in a backend they all share (setSharedCacheBackend),
 * whose `transaction` runs its function atomically across them.
 */

export interface SharedCacheRow {
  /** JSON text. */
  value: string;
  /** Epoch ms after which the row reads as absent. */
  expiresAt: number;
}

export interface SharedCacheBackend {
  get(key: string): SharedCacheRow | undefined;
  set(key: string, row: SharedCacheRow): void;
  delete(key: string): void;
  /** Runs `fn` so that no other caller reads or writes the backend in between. */
  transaction<T>(fn: () => T): T;
}

export function memorySharedCache(): SharedCacheBackend {
  const rows = new Map<string, SharedCacheRow>();
  return {
    get: (key) => rows.get(key),
    set: (key, row) => void rows.set(key, row),
    delete: (key) => void rows.delete(key),
    transaction: (fn) => fn(),
  };
}

let backend: SharedCacheBackend = memorySharedCache();

/** Replace the backend; returns the previous one. */
export function setSharedCacheBackend(next: SharedCacheBackend): SharedCacheBackend {
  const previous = backend;
  backend = next;
  return previous;
}

function warn(what: string, err: unknown): void {
  console.warn(`[shared-cache] ${what} failed:`, err instanceof Error ? err.message : err);
}

export function sharedGet<T>(key: string): T | null {
  try {
    const row = backend.get(key);
    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      try {
        backend.delete(key);
      } catch {
        /* best effort */
      }
      return null;
    }
    return JSON.parse(row.value) as T;
  } catch (err) {
    warn("get", err);
    return null;
  }
}

export type StrictRead<T> = { ok: true; value: T | null } | { ok: false };

/** sharedGet for a caller that rations an upstream: a failed read is `ok: false`, never "no entry". */
export function sharedGetStrict<T>(key: string): StrictRead<T> {
  try {
    const row = backend.get(key);
    if (!row || row.expiresAt < Date.now()) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(row.value) as T };
  } catch (err) {
    warn("strict get", err);
    return { ok: false };
  }
}

export function sharedSet<T>(key: string, value: T, ttlMs: number): void {
  try {
    backend.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlMs });
  } catch (err) {
    warn("set", err);
  }
}

function reserveSlot(key: string, spacingMs: number, maxWaitMs: number): number | null {
  return backend.transaction(() => {
    const now = Date.now();
    const row = backend.get(key);
    const stored = row ? Number(JSON.parse(row.value)) : 0;
    const start = Math.max(Number.isFinite(stored) ? stored : 0, now);
    if (start - now > maxWaitMs) return null;
    const next = start + spacingMs;
    backend.set(key, { value: JSON.stringify(next), expiresAt: next + 60_000 });
    return start - now;
  });
}

export type SlotReservation = { ok: true; waitMs: number } | { ok: false; reason: "full" | "error" };

/**
 * Reserve the next start on a queue whose starts are `spacingMs` apart. `full`
 * when the queue already runs longer than `maxWaitMs`, `error` when the state
 * cannot be read or written; nothing is reserved in either case.
 */
export function sharedReserveSlotStrict(key: string, spacingMs: number, maxWaitMs: number): SlotReservation {
  try {
    const waitMs = reserveSlot(key, spacingMs, maxWaitMs);
    return waitMs === null ? { ok: false, reason: "full" } : { ok: true, waitMs };
  } catch (err) {
    warn("strict reserve", err);
    return { ok: false, reason: "error" };
  }
}

/**
 * Store the number `value` under `key` unless a live entry already holds a
 * larger one, atomically: the later deadline always wins. Returns the number
 * held afterwards, or null when the state could not be written.
 */
export function sharedSetMax(key: string, value: number, ttlMs: number): number | null {
  try {
    return backend.transaction(() => {
      const now = Date.now();
      const row = backend.get(key);
      const held = row && row.expiresAt >= now ? Number(JSON.parse(row.value)) : NaN;
      if (Number.isFinite(held) && held >= value) return held;
      backend.set(key, { value: JSON.stringify(value), expiresAt: now + ttlMs });
      return value;
    });
  } catch (err) {
    warn("set max", err);
    return null;
  }
}

/** Take `key` for `ttlMs` if nobody holds it. False when it is held, and false when the state fails. */
export function sharedClaim(key: string, ttlMs: number): boolean {
  try {
    return backend.transaction(() => {
      const now = Date.now();
      const row = backend.get(key);
      if (row && row.expiresAt >= now) return false;
      backend.set(key, { value: "1", expiresAt: now + ttlMs });
      return true;
    });
  } catch (err) {
    warn("claim", err);
    return false;
  }
}

/**
 * Add 1 to the counter under `key` and return the new count, atomically. A
 * missing or expired counter starts again at 1 and lives `ttlMs`; a live one
 * keeps its expiry. Infinity when the state fails, so a caller that backs off
 * by the count takes its longest step.
 */
export function sharedIncrement(key: string, ttlMs: number): number {
  try {
    return backend.transaction(() => {
      const now = Date.now();
      const row = backend.get(key);
      const held = row && row.expiresAt >= now ? Number(JSON.parse(row.value)) : NaN;
      const next = Number.isFinite(held) ? held + 1 : 1;
      backend.set(key, { value: JSON.stringify(next), expiresAt: Number.isFinite(held) && row ? row.expiresAt : now + ttlMs });
      return next;
    });
  } catch (err) {
    warn("increment", err);
    return Infinity;
  }
}

export function sharedDelete(key: string): void {
  try {
    backend.delete(key);
  } catch {
    /* best effort */
  }
}
