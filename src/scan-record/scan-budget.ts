/**
 * One budget for every caller of a Scan host.
 *
 * A public Scan host rate limits per client IP: api.cantonnodes.com answers
 * 429 or drops the connection from the third quick request, and other callers
 * on the same IP spend the same allowance. So the calls are classed:
 *
 *   user, cron  interactive and other scheduled callers: never wait and are
 *               never refused here. They only mark their calls (and a 429 they
 *               meet opens the gate), so the backfill can wait for them.
 *   record      the open record's forward collector: one start per
 *               SCAN_RECORD_SPACING_MS (default 30 s) across every worker
 *               sharing the state, shared with the backfill, refused while the
 *               shared 429 gate is open. About 2 calls per minute for both
 *               together, half of the observed per-IP ceiling, so the other
 *               callers keep the other half.
 *   backfill    only from 02:00 to 06:00 UTC; it first waits until 60 s have
 *               passed since a user or cron caller's last call, and yields if
 *               that caller dials again meanwhile. Record calls do not count:
 *               they share the queue. Same spacing and gate.
 *
 * Every check a record or backfill call passed is made again after each wait
 * (the quiet period, the queue), because the gate can open, a scheduled caller
 * can start a burst, or 06:00 can pass while it sleeps.
 *
 * State lives in the shared cache (runtime/shared-cache.ts). record and
 * backfill fail closed: when the shared cache cannot be read or written they
 * are refused, never dialled unspaced past a gate nobody could read. user and
 * cron stay fail-open: they never waited here anyway.
 */

import { sharedGet, sharedGetStrict, sharedReserveSlotStrict, sharedSet, sharedSetMax } from "../runtime/shared-cache";

export type ScanCallClass = "user" | "cron" | "record" | "backfill";

export class ScanBusyError extends Error {
  constructor(
    public readonly host: string,
    public readonly reason: "gate" | "queue" | "window" | "yield",
  ) {
    super(`Scan host ${host} is busy (${reason}); not dialling`);
    this.name = "ScanBusyError";
  }
}

export const SCAN_BUDGET = {
  spacingMs: 30_000,
  /** Two callers (collector and backfill) can be queued at once: two slots plus slack. */
  maxWaitMs: 70_000,
  backfillStartHour: 2,
  backfillEndHour: 6,
  backfillYieldMs: 60_000,
  gateFallbackMs: 30_000,
  gateMinMs: 5_000,
  gateMaxMs: 3_600_000,
} as const;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const override = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(override) && override >= 0 ? override : fallback;
}
/** The queue's spacing between two starts on one host, as acquireScanSlot applies it. */
export const scanSpacingMs = () => envMs("SCAN_RECORD_SPACING_MS", SCAN_BUDGET.spacingMs);
const maxWaitMs = () => envMs("SCAN_RECORD_MAX_WAIT_MS", SCAN_BUDGET.maxWaitMs);
const backfillYieldMs = () => envMs("SCAN_BACKFILL_YIELD_MS", SCAN_BUDGET.backfillYieldMs);

/**
 * The longest acquireScanSlot can hold a call of this class before it dials:
 * the backfill's quiet period plus the queue. user and cron never wait here.
 */
export function scanSlotMaxWaitMs(cls: ScanCallClass): number {
  if (cls === "user" || cls === "cron") return 0;
  return (cls === "backfill" ? backfillYieldMs() : 0) + maxWaitMs();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type CallBucket = "backfill" | "record" | "other";
const bucketOf = (cls: ScanCallClass): CallBucket => (cls === "backfill" ? "backfill" : cls === "record" ? "record" : "other");
const lastCallKey = (host: string, bucket: CallBucket) => `scan:last-call:${host}:${bucket}`;
const gateKey = (host: string) => `scan:gate:${host}`;
const slotKey = (host: string) => `scan:next-slot:${host}`;

export function markScanCall(host: string, cls: ScanCallClass, nowMs = Date.now()): void {
  sharedSet(lastCallKey(host, bucketOf(cls)), nowMs, 10 * 60_000);
}

export function scanGateUntil(host: string, nowMs = Date.now()): number | null {
  const until = sharedGet<number>(gateKey(host));
  return typeof until === "number" && until > nowMs ? until : null;
}

/** Retry-After in delay-seconds or as an HTTP-date (RFC 9110 10.2.3); null when absent, past or unreadable. */
function retryAfterMs(retryAfter: string | null, nowMs: number): number | null {
  if (retryAfter == null) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const at = Date.parse(retryAfter);
  return Number.isFinite(at) && at > nowMs ? at - nowMs : null;
}

/**
 * Close the host to the record and backfill until Retry-After has passed.
 * Returns when the gate now closes: a later gate already open is kept, never
 * shortened, whichever worker writes first.
 */
export function openScanGate(host: string, retryAfter: string | null, nowMs = Date.now()): number {
  const asked = retryAfterMs(retryAfter, nowMs);
  const waitMs =
    asked == null
      ? SCAN_BUDGET.gateFallbackMs
      : Math.ceil(Math.min(Math.max(asked, SCAN_BUDGET.gateMinMs), SCAN_BUDGET.gateMaxMs));
  const until = nowMs + waitMs;
  return sharedSetMax(gateKey(host), until, waitMs + 1_000) ?? until;
}

export function inBackfillWindow(nowMs: number): boolean {
  const hour = new Date(nowMs).getUTCHours();
  return hour >= SCAN_BUDGET.backfillStartHour && hour < SCAN_BUDGET.backfillEndHour;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refuseUnreadable(host: string, cls: ScanCallClass, reason: ScanBusyError["reason"]): never {
  console.warn(`[scan-budget] shared cache unavailable; refusing the ${cls} call to ${host} (${reason})`);
  throw new ScanBusyError(host, reason);
}

/** Fail closed: a gate the shared cache cannot answer for counts as open. */
function refuseIfGateOpen(host: string, cls: ScanCallClass, nowMs: number): void {
  const gate = sharedGetStrict<number>(gateKey(host));
  if (!gate.ok) refuseUnreadable(host, cls, "gate");
  if (typeof gate.value === "number" && gate.value > nowMs) throw new ScanBusyError(host, "gate");
}

/** The last user or cron call on the host, or null when there was none lately. */
function lastOtherCall(host: string, cls: ScanCallClass): number | null {
  const last = sharedGetStrict<number>(lastCallKey(host, "other"));
  if (!last.ok) refuseUnreadable(host, cls, "yield");
  return typeof last.value === "number" ? last.value : null;
}

/** The checks made again after every wait. `otherSeen` is the backfill's first reading of lastOtherCall. */
function refuseIfBusy(host: string, cls: ScanCallClass, nowMs: number, otherSeen: number | null): void {
  refuseIfGateOpen(host, cls, nowMs);
  if (cls !== "backfill") return;
  if (!inBackfillWindow(nowMs)) throw new ScanBusyError(host, "window");
  const other = lastOtherCall(host, cls);
  // A user or scheduled caller dialled while we waited: it is mid-burst.
  if (other != null && (otherSeen == null || other > otherSeen)) throw new ScanBusyError(host, "yield");
}

export async function acquireScanSlot(host: string, cls: ScanCallClass, nowMs = Date.now()): Promise<void> {
  if (cls === "user" || cls === "cron") {
    markScanCall(host, cls, nowMs);
    return;
  }
  // `nowMs` moves on with real time across the waits below.
  const startedAt = Date.now();
  const clock = () => nowMs + (Date.now() - startedAt);

  refuseIfGateOpen(host, cls, clock());
  let otherSeen: number | null = null;
  if (cls === "backfill") {
    if (!inBackfillWindow(clock())) throw new ScanBusyError(host, "window");
    // Wait out the quiet period after a user or scheduled caller (not the
    // record: it shares the queue below). If that caller dials again while we
    // wait, it is mid-burst: yield and let the next run try.
    otherSeen = lastOtherCall(host, cls);
    if (otherSeen != null) {
      const waitMs = backfillYieldMs() - (clock() - otherSeen);
      if (waitMs > 0) {
        await sleep(waitMs);
        refuseIfBusy(host, cls, clock(), otherSeen);
      }
    }
  }

  const spacing = scanSpacingMs();
  if (spacing > 0) {
    const slot = sharedReserveSlotStrict(slotKey(host), spacing, maxWaitMs());
    if (!slot.ok) {
      if (slot.reason === "error") refuseUnreadable(host, cls, "queue");
      throw new ScanBusyError(host, "queue");
    }
    if (slot.waitMs > 0) {
      await sleep(slot.waitMs);
      // The slot stays spent if we refuse now: the queue only ever moves later.
      refuseIfBusy(host, cls, clock(), otherSeen);
    }
  }
  markScanCall(host, cls, clock());
}
