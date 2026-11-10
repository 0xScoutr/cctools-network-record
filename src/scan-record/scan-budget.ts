/**
 * One budget for every caller of a Scan host.
 *
 * A public Scan host rate limits per client IP: api.cantonnodes.com answers
 * 429 or drops the connection from the third quick request, and other callers
 * on the same IP spend the same allowance. So the calls are classed:
 *
 *   user, cron  interactive and other scheduled callers: never wait and are
 *               never refused here on any host but a Super Validator Scan
 *               (there the one-at-a-time lease below holds for every class:
 *               cron waits for it, user is refused while it is busy and goes
 *               on to the next host). Elsewhere they only mark their calls
 *               (and a 429 they meet opens the gate), so the backfill can wait
 *               for them.
 *   record      the open record's forward collector: one start per
 *               SCAN_RECORD_SPACING_MS (default 30 s) across every worker
 *               sharing the state, shared with the backfill, refused while the
 *               shared 429 gate is open. About 2 calls per minute for both
 *               together, half of the observed per-IP ceiling, so the other
 *               callers keep the other half.
 *   backfill    only from 02:00 to 06:00 UTC, unless its caller passes its own
 *               window (BackfillWindow); it first waits until 60 s have
 *               passed since a user or cron caller's last call, and yields if
 *               that caller dials again meanwhile. Record calls do not count:
 *               they share the queue. Same spacing and gate.
 *
 * Every check a record or backfill call passed is made again after each wait
 * (the quiet period, the queue), because the gate can open, a scheduled caller
 * can start a burst, or the backfill window's end can pass while it sleeps.
 *
 * Super Validator Scans are one budget, whichever host is asked and whichever
 * class asks. A Super Validator's Scan answers only the IPs on its allowlist,
 * so a deployment reads them from the IP of a validator node it runs (through
 * a forward, scan-dial.ts), and that validator needs two thirds of those Scans
 * to keep working: a ban earned by a read here would cost the node. So, for
 * every class, user and cron included: one request at a time across every
 * worker sharing the state, a hard floor between starts (svScanSpacingMs,
 * which no setting can lower), and the first 429 from any of them closes all
 * of them for hours, longer each time (svGateBackoffMs); the caller goes on to
 * the next host in its list, a public Scan on another IP with another limit.
 * That IP's access is a privilege: what a 429 means for the next hours matters
 * more than how fresh a read is. A host that fails any other way closes alone
 * (closeSvScanHost), so an upgrading Super Validator costs one failed call a
 * minute instead of one per read. A "user" call, an interactive request, never
 * waits on any of this: busy means the next host, at once.
 *
 * State lives in the shared cache (runtime/shared-cache.ts). record and
 * backfill fail closed: when the shared cache cannot be read or written they
 * are refused, never dialled unspaced past a gate nobody could read. user and
 * cron stay fail-open: they never waited here anyway.
 */

import { sharedClaim, sharedDelete, sharedGet, sharedGetStrict, sharedIncrement, sharedReserveSlotStrict, sharedSet, sharedSetMax } from "../runtime/shared-cache";

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
  /** The least time between two starts on the Super Validators, whatever is configured. 20 calls at one a second all answered 200 (06/11), so this keeps a margin. */
  svSpacingFloorMs: 2_000,
  /** How long a Super Validator Scan stays out of the rotation after it failed in a way other than a 429. */
  svHostDownMs: 60_000,
  /**
   * How long a 429 closes every Super Validator Scan: the first in a week, the second, the third and any after. A
   * longer Retry-After wins, up to svGateMaxMs.
   */
  svGateBackoffMs: [3_600_000, 6 * 3_600_000, 24 * 3_600_000],
  svGateMaxMs: 7 * 24 * 3_600_000,
  svStrikeMemoryMs: 7 * 24 * 3_600_000,
  /**
   * An answer built on a snapshot older than this is not taken from a Super Validator while another host may have a
   * newer one. Snapshots are three hours apart and land some time later (the public host's latest was 37 minutes old
   * when read on 2026-11-06), so a healthy host stays under it; one Scan's was 27 hours old that same day.
   */
  svSnapshotMaxAgeMs: 4 * 3_600_000,
  /** Longer than the slowest Scan read on this path, so a worker that died holding it costs at most this. */
  svLeaseMs: 120_000,
  svLeasePollMs: 100,
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
/** SCAN_RECORD_SV_SPACING_MS can raise the spacing on the Super Validators, never lower it past the floor. */
export const svScanSpacingMs = () => Math.max(envMs("SCAN_RECORD_SV_SPACING_MS", SCAN_BUDGET.svSpacingFloorMs), SCAN_BUDGET.svSpacingFloorMs);

/**
 * The longest acquireScanSlot can hold a call of this class before it dials:
 * the backfill's quiet period plus the queue. It counts no wait for user and
 * cron, which holds on every host but a Super Validator Scan: there a cron
 * call can also wait for the lease, up to the queue's longest wait, and this
 * does not count it yet.
 */
export function scanSlotMaxWaitMs(cls: ScanCallClass): number {
  if (cls === "user" || cls === "cron") return 0;
  return (cls === "backfill" ? backfillYieldMs() : 0) + maxWaitMs();
}

/**
 * The name a Scan call is budgeted and credited under, as stored in source_host
 * and published. Never a port.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** A Super Validator's Scan, as the network's own list names them (GET /v0/scans): scan.<node>.global.canton.network.<operator>. */
const SV_SCAN_HOST = /^scan\.[^.]+\.global\.canton\.network\.[^/:]+$/i;
export const isSvScanHost = (host: string): boolean => SV_SCAN_HOST.test(host);

/** What one budget covers: one host, or every Super Validator Scan together. */
const budgetOf = (host: string) => (isSvScanHost(host) ? "sv-egress" : host);

type CallBucket = "backfill" | "record" | "other";
const bucketOf = (cls: ScanCallClass): CallBucket => (cls === "backfill" ? "backfill" : cls === "record" ? "record" : "other");
const lastCallKey = (host: string, bucket: CallBucket) => `scan:last-call:${budgetOf(host)}:${bucket}`;
const gateKey = (host: string) => `scan:gate:${budgetOf(host)}`;
const slotKey = (host: string) => `scan:next-slot:${budgetOf(host)}`;
const hostDownKey = (host: string) => `scan:host-down:${host}`;
const SV_LEASE_KEY = "scan:sv-egress:in-flight";
const SV_STRIKES_KEY = "scan:sv-egress:strikes";

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

/** The next step of the Super Validators' backoff. A shared cache that fails answers Infinity, the longest step. */
function svGateMs(host: string, asked: number | null): number {
  const strike = sharedIncrement(SV_STRIKES_KEY, SCAN_BUDGET.svStrikeMemoryMs);
  const steps = SCAN_BUDGET.svGateBackoffMs;
  const backoff = steps[Math.min(strike, steps.length) - 1];
  const waitMs = Math.ceil(Math.min(Math.max(asked ?? 0, backoff), SCAN_BUDGET.svGateMaxMs));
  console.error(`[scan-budget] 429 from ${host}, strike ${strike}: every Super Validator closed for ${Math.round(waitMs / 60_000)} minutes`);
  return waitMs;
}

/**
 * Close the host to the record and backfill until Retry-After has passed.
 * Returns when the gate now closes: a later gate already open is kept, never
 * shortened, whichever worker writes first.
 */
export function openScanGate(host: string, retryAfter: string | null, nowMs = Date.now()): number {
  const asked = retryAfterMs(retryAfter, nowMs);
  const waitMs = isSvScanHost(host)
    ? svGateMs(host, asked)
    : asked == null
      ? SCAN_BUDGET.gateFallbackMs
      : Math.ceil(Math.min(Math.max(asked, SCAN_BUDGET.gateMinMs), SCAN_BUDGET.gateMaxMs));
  const until = nowMs + waitMs;
  return sharedSetMax(gateKey(host), until, waitMs + 1_000) ?? until;
}

/** A Super Validator Scan that failed in a way other than a 429: only it stays out, for a minute. */
export function closeSvScanHost(host: string, nowMs = Date.now()): void {
  sharedSet(hostDownKey(host), nowMs + SCAN_BUDGET.svHostDownMs, SCAN_BUDGET.svHostDownMs + 1_000);
}

/**
 * The UTC hours a backfill call may dial: from startHour (included) to endHour (excluded), across midnight when
 * startHour is the later one (22 to 10 is 22:00 to 09:59). Equal hours admit no hour at all.
 */
export interface BackfillWindow {
  startHour: number;
  endHour: number;
}

export const DEFAULT_BACKFILL_WINDOW: BackfillWindow = Object.freeze({ startHour: SCAN_BUDGET.backfillStartHour, endHour: SCAN_BUDGET.backfillEndHour });

export function inBackfillWindow(nowMs: number, window: BackfillWindow = DEFAULT_BACKFILL_WINDOW): boolean {
  const hour = new Date(nowMs).getUTCHours();
  const { startHour, endHour } = window;
  return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
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
  if (!isSvScanHost(host)) return;
  const down = sharedGetStrict<number>(hostDownKey(host));
  if (!down.ok) refuseUnreadable(host, cls, "gate");
  if (typeof down.value === "number" && down.value > nowMs) throw new ScanBusyError(host, "gate");
}

/** The last user or cron call on the host, or null when there was none lately. */
function lastOtherCall(host: string, cls: ScanCallClass): number | null {
  const last = sharedGetStrict<number>(lastCallKey(host, "other"));
  if (!last.ok) refuseUnreadable(host, cls, "yield");
  return typeof last.value === "number" ? last.value : null;
}

/** The checks made again after every wait. `otherSeen` is the backfill's first reading of lastOtherCall. */
function refuseIfBusy(host: string, cls: ScanCallClass, nowMs: number, otherSeen: number | null, window: BackfillWindow): void {
  refuseIfGateOpen(host, cls, nowMs);
  if (cls !== "backfill") return;
  if (!inBackfillWindow(nowMs, window)) throw new ScanBusyError(host, "window");
  const other = lastOtherCall(host, cls);
  // A user or scheduled caller dialled while we waited: it is mid-burst.
  if (other != null && (otherSeen == null || other > otherSeen)) throw new ScanBusyError(host, "yield");
}

/**
 * One request at a time to the Super Validators, across every worker sharing
 * the state. The caller holds it until releaseScanSlot. The wait leaves room for the spacing that
 * follows, so scanSlotMaxWaitMs still bounds the whole of acquireScanSlot.
 */
async function takeSvLease(
  host: string,
  cls: ScanCallClass,
  clock: () => number,
  otherSeen: number | null,
  patienceMs: number,
  window: BackfillWindow,
): Promise<void> {
  const giveUpAt = Date.now() + Math.max(patienceMs - svScanSpacingMs(), 0);
  for (;;) {
    // false for a held place and for a shared cache that fails: both refuse.
    if (sharedClaim(SV_LEASE_KEY, SCAN_BUDGET.svLeaseMs)) return;
    const left = giveUpAt - Date.now();
    if (left <= 0) throw new ScanBusyError(host, "queue");
    await sleep(Math.min(left, SCAN_BUDGET.svLeasePollMs));
    refuseIfBusy(host, cls, clock(), otherSeen, window);
  }
}

/**
 * Ends a call acquireScanSlot admitted: frees the one in-flight place of the
 * Super Validators' budget. No effect on any other host.
 */
export function releaseScanSlot(host: string): void {
  if (isSvScanHost(host)) sharedDelete(SV_LEASE_KEY);
}

/**
 * Admits one call. A Super Validator Scan's caller must call releaseScanSlot
 * when the answer has been read, and only after this resolved. `window` is the
 * backfill's hours (any other class ignores it); every other rule is the same
 * for every caller.
 */
export async function acquireScanSlot(
  host: string,
  cls: ScanCallClass,
  nowMs = Date.now(),
  window: BackfillWindow = DEFAULT_BACKFILL_WINDOW,
): Promise<void> {
  const sv = isSvScanHost(host);
  if (!sv && (cls === "user" || cls === "cron")) {
    markScanCall(host, cls, nowMs);
    return;
  }
  // `nowMs` moves on with real time across the waits below.
  const startedAt = Date.now();
  const clock = () => nowMs + (Date.now() - startedAt);

  refuseIfGateOpen(host, cls, clock());
  let otherSeen: number | null = null;
  if (cls === "backfill") {
    if (!inBackfillWindow(clock(), window)) throw new ScanBusyError(host, "window");
    // Wait out the quiet period after a user or scheduled caller (not the
    // record: it shares the queue below). If that caller dials again while we
    // wait, it is mid-burst: yield and let the next run try.
    otherSeen = lastOtherCall(host, cls);
    if (otherSeen != null) {
      const waitMs = backfillYieldMs() - (clock() - otherSeen);
      if (waitMs > 0) {
        await sleep(waitMs);
        refuseIfBusy(host, cls, clock(), otherSeen, window);
      }
    }
  }

  // An interactive call waits for nothing here: busy sends it on to the next host at once.
  const patienceMs = cls === "user" ? 0 : maxWaitMs();
  if (sv) await takeSvLease(host, cls, clock, otherSeen, patienceMs, window);
  try {
    const spacing = sv ? svScanSpacingMs() : scanSpacingMs();
    if (spacing > 0) {
      const slot = sharedReserveSlotStrict(slotKey(host), spacing, patienceMs);
      if (!slot.ok) {
        if (slot.reason === "error") refuseUnreadable(host, cls, "queue");
        throw new ScanBusyError(host, "queue");
      }
      if (slot.waitMs > 0) {
        await sleep(slot.waitMs);
        // The slot stays spent if we refuse now: the queue only ever moves later.
        refuseIfBusy(host, cls, clock(), otherSeen, window);
      }
    }
    markScanCall(host, cls, clock());
  } catch (err) {
    releaseScanSlot(host);
    throw err;
  }
}
