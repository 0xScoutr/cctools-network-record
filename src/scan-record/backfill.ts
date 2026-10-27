/**
 * The snapshot backfill: one ACS snapshot read per missing day at D+1 00:00Z
 * for DsoRules, OpenMiningRound, IssuingMiningRound and FeaturedAppRight,
 * oldest first, then finalize for every day those snapshots bound. It also
 * repairs any day whose snapshot the forward collector missed, so it stays
 * scheduled after the first release. The day reads do not read
 * ValidatorLicense history (its backfill is planned). A completion pass run
 * after the day reads (licensePass) reads the ValidatorLicense count of stored
 * rows that lack it, oldest first, at the row's own record time, host and
 * migration, and owes the day a finalize; three failed reads that are not outages give a day up
 * (detail.license_attempts), and each such failure holds the day back for
 * BACKFILL_RETRY_MS (detail.license_failed_at), as the day reads are spaced,
 * so a bad half hour cannot spend a day's three attempts.
 *
 * Runs as budget class 3: 02:00 to 06:00 UTC, sharing the record's queue and
 * waiting for the scheduled heavy callers (scan-budget.ts). A yield is not a
 * failure, and spends no attempt. Any other failed read holds the day back
 * for BACKFILL_RETRY_MS, as the forward stage spaces its own (SNAPSHOT_RETRY),
 * since runs come every five minutes. A Scan outage (a 5xx, a 408 or a
 * timeout) says nothing about the day: it spends no attempt (it is counted in
 * detail.outage_failures, for the record) and ends the run's reads, since the
 * next day would meet the same Scan. The ACS read can time out for hours
 * while the other endpoints answer (/v0/state/acs did, before the record read
 * /v2/state/acs first, scan-client.ts), and a day given up for that would
 * need a manual cursor write to be read again. Any other failure (a 404, a shape
 * error, an unusable snapshot) spends one of the day's BACKFILL_MAX_ATTEMPTS.
 * The license pass spaces only that kind of failure: an outage ends its reads
 * anyway and the next run meets the same Scan with one call, so holding the
 * day back would gain nothing.
 * A day that spends them all is skipped from then on (it keeps the gap reason
 * finalize gives it) and alarmed, so one day Scan cannot serve never blocks
 * the newer ones. An outage that lasts is paged by the latch instead.
 *
 * It never writes over a stored row (store.insertSnapshot): the forward stage
 * reads yesterday from 00:15 and can store a day between this run's listing
 * and its read. That row keeps its own host and license count, and the day
 * is done (`kept`).
 *
 * Finalize runs under FINALIZE_LOCK, claimed once the Scan part is over and
 * held only around the finalizeDate calls (finalize.ts: held through the Scan
 * part, it would starve the hourly finalize from 02:00 to 06:00). It stays out
 * of the hourly finalize job's slot (FINALIZE_JOB_SLOT): that job runs at :35,
 * skips a run that finds the lock held, and its 02:35 run is the only one
 * that settles yesterday before the 02:40 render and the D+1 03:00 UTC
 * promise. So no finalizeDate starts from :28 to :45, nor after the grace
 * past the run's Scan deadline (BACKFILL_FINALIZE_GRACE_MS). A day that a
 * snapshot bounds is owed on CURSOR_BACKFILL (detail.finalize_owed) from just
 * before the insert that stores it until its finalizeDate returns, so a held
 * lock, the job's slot, a finalize that throws, an insert that commits and
 * then answers an error, or a restart mid-run leaves it to a later run: a day
 * older than the finalize window has no other writer. An owed day is finalized only once both snapshots that bound it
 * are stored (or given up): finalized earlier, past its deadline it would
 * publish final nulls that the missing boundary's arrival then revises. Each
 * run also owes every bounded day older than the finalize window that has no
 * value row, read from the store, so a day the cursor lost is still settled.
 * That scan reads one row per day (store.listValueDates) and runs once per
 * UTC day, on the night's first run that reaches it (detail.value_scan_date),
 * so its cost does not grow with every run.
 *
 * Older than the finalize window, this run is the only one that finalizes a
 * day, so it also carries what finalizeDate says of it: a day past its settle
 * deadline with a series in ALARM_STATES (a gate held, a conflict, a null
 * with no reason) is a finalize alarm. It stays owed (detail.finalize_owed,
 * and detail.finalize_alarmed) and is evaluated again on later runs, so the
 * alarm persists until the day settles. A day that a release_holds or
 * keep_final entry names is evaluated first, so a human's fix is applied on
 * the next run; the other alarmed days take turns, least recently evaluated
 * first (finalizeQueue), so any number of them is re-evaluated within a
 * bounded number of runs. The run is not ok while any day is alarmed; the
 * caller pages at once when a day is first alarmed.
 *
 * CURSOR_BACKFILL: last_date is the last day stored, detail.attempts the
 * failed reads per day that were not outages, detail.outage_failures those
 * that were, and detail.failed_at the time of each day's latest failed read
 * (all three cleared once the day is stored or kept),
 * detail.finalize_owed the days owed, detail.finalize_alarmed the owed days
 * whose latest finalize raised an alarm, detail.alarm_evaluated_at when each
 * of those was last evaluated (dropped once it settles),
 * detail.value_scan_date the UTC day
 * of the latest old-day scan, and detail.pending and detail.given_up the
 * counts as of the latest write. The license pass keeps detail.license_attempts
 * (failed reads per day that were not outages) and detail.license_failed_at
 * (the time of each day's latest such failure), both cleared once the day's
 * count is stored.
 */

import { sharedClaim, sharedDelete } from "../runtime/shared-cache";
import {
  CURSOR_BACKFILL,
  RECORD_FIRST_DATE,
  SERIES_NAMES,
  addDays,
  isValidDate,
  utcDate,
  type SeriesName,
} from "../open-record/contract";
import type { RoundTotalsVerification } from "./config";
import {
  ALARM_STATES,
  FINALIZE_LOCK,
  FINALIZE_WINDOW_DAYS,
  finalizeDate,
  loadFinalizeContext,
  type FinalizeContext,
  type SeriesStateName,
} from "./finalize";
import { ScanBusyError } from "./scan-budget";
import { ScanHttpError, ScanTimeoutError, type ScanApi } from "./scan-client";
import { licenseReadHeadroomMs, readLicenseCount, readSnapshot, snapshotCoreHeadroomMs, snapshotStageDate } from "./snapshot";
import type { RecordStore, SnapshotRow } from "./store";

export const BACKFILL_MAX_ATTEMPTS = 3;

/**
 * After a failed read the day is not read again for this long, outage or not,
 * so a day's retries stay a few calls a night. The other days are read
 * meanwhile.
 */
export const BACKFILL_RETRY_MS = 90 * 60_000;

/**
 * The hourly finalize job's slot, in UTC minutes [from, to): it runs at :35
 * and skips a run that finds FINALIZE_LOCK held. The backfill starts no
 * finalizeDate inside it, nor from its start on, so a day started before :28
 * has seven minutes to end before the job claims the lock (a day takes a few
 * seconds), and a job run that holds the lock past :35 has ten.
 */
export const FINALIZE_JOB_SLOT = { fromMinute: 28, toMinute: 45 } as const;

/**
 * No finalizeDate starts later than this after the run's Scan deadline
 * (budgetMs): the caller's lock is the budget plus 60 s and the scheduler
 * gives up on a run at 600 s, so the day in flight has room to end inside both.
 */
export const BACKFILL_FINALIZE_GRACE_MS = 45_000;

/** Why owed days were left this run: another caller held the lock, the finalize job's slot, or the run's time. */
export type FinalizeWait = "lock" | "finalize_slot" | "time";

/**
 * finalizeDate calls per run, in finalizeQueue's order. A run stores at most
 * maxDays days and each bounds itself and the next, so it owes at most twice
 * that (8 for the caller's 4), plus any old day the store shows unfinalized.
 * The count is not what bounds the time: no day
 * starts past BACKFILL_FINALIZE_GRACE_MS after the Scan deadline, nor inside
 * the finalize job's slot. A longer backlog (the lock held over several
 * runs, a day whose finalize keeps failing, a run out of time) drains over
 * the next runs.
 */
export const BACKFILL_FINALIZE_MAX_DAYS = 10;

/** License reads per run at most; the run's deadline bounds it first (licenseReadHeadroomMs). */
export const BACKFILL_LICENSE_MAX_DAYS = 8;

export interface BackfillResult {
  ok: boolean;
  dry_run: boolean;
  pending: number;
  /** Days skipped after BACKFILL_MAX_ATTEMPTS failures (alarmed; cleared by hand). */
  given_up: string[];
  processed: string[];
  /** Days another writer (the forward stage) stored after this run listed them: left as stored, and done. */
  kept: string[];
  planned: SnapshotRow[];
  finalized: string[];
  /**
   * Days still owed a finalize after this run: a snapshot that bounds them is
   * still to come, the lock was held, their finalize threw, or the run
   * reached BACKFILL_FINALIZE_MAX_DAYS.
   */
  finalize_owed: string[];
  /** Days whose finalizeDate threw this run ("run" when the finalize context could not be read); they stay owed. */
  finalize_errors: Array<{ date: string; error: string }>;
  /**
   * What this run's finalizeDate calls left needing a human: a series in
   * ALARM_STATES on a day past its settle deadline. Each such day stays owed.
   */
  finalize_alarms: Array<{ date: string; series: SeriesName; state: SeriesStateName; reason?: string }>;
  /** Every owed day still alarmed: this run's, and those carried from earlier runs that it did not evaluate again. */
  finalize_alarmed: string[];
  /** The days of finalize_alarms that no earlier run had alarmed: the caller pages at once for them. */
  finalize_alarms_new: string[];
  /** The finalize part did not start (FINALIZE_LOCK held, the finalize job's slot, or out of time), so every day ready for it waits for a later run. */
  finalize_deferred: boolean;
  /** Why owed days were left for a later run, before the claim or between days; null when no wait left any. */
  finalize_wait: FinalizeWait | null;
  /**
   * Failed reads by day ("run" when the run itself failed: the migration id,
   * or a store write). `outage` marks a Scan 5xx, 408 or timeout, which the
   * caller leaves to the latch instead of failing the run.
   */
  failures: Array<{ date: string; error: string; outage?: boolean }>;
  /** Days whose ValidatorLicense count the completion pass stored this run. */
  licenses_added: string[];
  /** Failed license reads this run; `outage` marks a Scan 5xx, 408 or timeout, which spends no attempt. */
  license_failures: Array<{ date: string; error: string; outage?: boolean }>;
  /**
   * Days whose license read failed BACKFILL_MAX_ATTEMPTS times, this run and
   * earlier ones: skipped from then on and listed on every run of the pass,
   * the early return of a settled store included, until cleared by hand (like
   * given_up). Like given_up it does not turn `ok` false: the run that gives
   * the day up fails on the read itself, and the later runs are the latch's to
   * fail, through backfillOutcomes. A dry run and a
   * run without the pass list none.
   */
  licenses_given_up: string[];
  /** Pending days held back after a failed read until BACKFILL_RETRY_MS has passed. */
  waiting: string[];
  yielded: string | null;
  done: boolean;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A failures entry, marked as a Scan outage when it is one. */
const failure = (date: string, err: unknown): BackfillResult["failures"][number] =>
  isScanOutage(err) ? { date, error: message(err), outage: true } : { date, error: message(err) };

/**
 * A failure that says Scan is down or slow rather than anything about the
 * day: the next day would meet the same, so the run's reads end there.
 */
function isScanOutage(err: unknown): boolean {
  return err instanceof ScanTimeoutError || (err instanceof ScanHttpError && (err.status >= 500 || err.status === 408));
}

/**
 * The first time from `ms` on when no finalizeDate may start for the finalize
 * job's slot: `ms` itself inside the slot, else the slot's next start.
 */
export function finalizeSlotStart(ms: number): number {
  const hour = ms - (ms % 3_600_000);
  const from = hour + FINALIZE_JOB_SLOT.fromMinute * 60_000;
  const to = hour + FINALIZE_JOB_SLOT.toMinute * 60_000;
  if (ms < from) return from;
  if (ms < to) return ms;
  return from + 3_600_000;
}

/**
 * FINALIZE_LOCK through the shared cache, as the finalize job claims it: a
 * release function, or null when another caller holds it (or the shared cache
 * fails: sharedClaim answers false on an error).
 */
export function claimFinalizeLock(): (() => void) | null {
  if (!sharedClaim(FINALIZE_LOCK.key, FINALIZE_LOCK.holdMs)) return null;
  const claimedAt = Date.now();
  return () => {
    // No owner token: after the hold expired another caller may own the lock.
    if (Date.now() - claimedAt < FINALIZE_LOCK.holdMs) sharedDelete(FINALIZE_LOCK.key);
  };
}

/**
 * The order of a run's finalizeDate calls over the owed days that can be
 * finalized (at most BACKFILL_FINALIZE_MAX_DAYS are taken from its front):
 *   1. alarmed days that a release_holds or keep_final entry names, so a
 *      human's fix is applied on the next run, whatever the backlog;
 *   2. days owed their first finalize, oldest first, so each one's gates read
 *      the day before as this run left it, and a backlog of days waiting for
 *      a human never holds them back;
 *   3. the other alarmed days, least recently evaluated first (never
 *      evaluated counts as oldest; ties by date), so with any number alarmed
 *      each is evaluated again within a bounded number of runs.
 * A day that stays held keeps its alarm either way; the rotation only keeps
 * every alarmed day's state current.
 */
export function finalizeQueue(
  bounded: readonly string[],
  alarmed: ReadonlySet<string>,
  evaluatedAt: Readonly<Record<string, string>>,
  context: Pick<FinalizeContext, "releasedHolds" | "keptFinals">,
): string[] {
  const named = new Set([...context.releasedHolds.keys(), ...context.keptFinals].map((key) => key.split("|")[0]));
  const byDate = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const byTurn = (a: string, b: string) => byDate(evaluatedAt[a] ?? "", evaluatedAt[b] ?? "") || byDate(a, b);
  const days = [...bounded];
  return [
    ...days.filter((d) => alarmed.has(d) && named.has(d)).sort(byTurn),
    ...days.filter((d) => !alarmed.has(d)).sort(byDate),
    ...days.filter((d) => alarmed.has(d) && !named.has(d)).sort(byTurn),
  ];
}

export async function runBackfill(deps: {
  store: RecordStore;
  scan: ScanApi;
  now: Date;
  dryRun: boolean;
  maxDays: number;
  budgetMs: number;
  roundTotalsVerified: RoundTotalsVerification;
  clock?: () => number;
  /** Claims FINALIZE_LOCK for the finalize part: a release function, or null while another caller holds it. */
  finalizeLock?: () => (() => void) | null;
  /** Complete stored rows that lack their license count (the scheduled caller turns it on; tests opt in). */
  licensePass?: boolean;
}): Promise<BackfillResult> {
  const { store, scan, now } = deps;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  /** UTC now: the run's start plus what its clock has spent since. */
  const wallMs = () => now.getTime() + (clock() - started);
  /**
   * The invocation's end. Every Scan call of the run ends by it (readSnapshot
   * holds each call to it), and a day starts only while its whole core read
   * fits before it: snapshotCoreHeadroomMs in the ScanApi's class (380 s for
   * the backfill, 260 s for a dry run paced as record traffic). So the last
   * day started is never refused halfway for time, and budgetMs must be at
   * least that headroom for any day to start.
   */
  const deadline = started + deps.budgetMs;
  const headroomMs = snapshotCoreHeadroomMs(scan.cls);
  const yesterday = addDays(utcDate(now.getTime()), -1);
  // The day before the first published day: its end is the first day's start boundary.
  const from = addDays(RECORD_FIRST_DATE, -1);
  const inRecord = (d: string) => d >= RECORD_FIRST_DATE && d <= yesterday;
  const have = new Set(await store.listSnapshotDates(from, yesterday));
  const cursor = await store.getCursor(CURSOR_BACKFILL);
  const attempts: Record<string, number> = { ...((cursor?.detail?.attempts as Record<string, number> | undefined) ?? {}) };
  const owedRaw = cursor?.detail?.finalize_owed;
  const owed = new Set(
    (Array.isArray(owedRaw) ? owedRaw : []).filter((d): d is string => typeof d === "string" && isValidDate(d) && inRecord(d)),
  );
  const failedAt: Record<string, string> = { ...((cursor?.detail?.failed_at as Record<string, string> | undefined) ?? {}) };
  const outageFailures: Record<string, number> = {
    ...((cursor?.detail?.outage_failures as Record<string, number> | undefined) ?? {}),
  };
  // Owed days whose latest finalize raised an alarm; an alarmed day is always owed too.
  const alarmedRaw = cursor?.detail?.finalize_alarmed;
  const alarmedBefore = new Set(
    (Array.isArray(alarmedRaw) ? alarmedRaw : []).filter((d): d is string => typeof d === "string" && owed.has(d)),
  );
  const alarmed = new Set(alarmedBefore);
  // When each alarmed day was last evaluated: the rotation among them (finalizeQueue).
  const evaluatedRaw = (cursor?.detail?.alarm_evaluated_at as Record<string, unknown> | undefined) ?? {};
  const evaluatedAt: Record<string, string> = {};
  for (const d of alarmed) if (typeof evaluatedRaw[d] === "string") evaluatedAt[d] = evaluatedRaw[d] as string;
  // License completion pass: stored rows without a count, oldest first, up to
  // the day before the forward stage's day (only the stage reads that one).
  const licenseAttempts: Record<string, number> = {
    ...((cursor?.detail?.license_attempts as Record<string, number> | undefined) ?? {}),
  };
  const licenseFailedAt: Record<string, string> = {
    ...((cursor?.detail?.license_failed_at as Record<string, string> | undefined) ?? {}),
  };
  const licenseTo = addDays(snapshotStageDate(now.getTime()), -1);
  const missing =
    deps.licensePass && !deps.dryRun && licenseTo >= RECORD_FIRST_DATE
      ? await store.listSnapshotsMissingLicenses(RECORD_FIRST_DATE, licenseTo)
      : [];
  const listedAt = wallMs();
  /** A failed read holds the day back BACKFILL_RETRY_MS, as the day reads are held (runs come every five minutes). */
  const licenseHeld = (date: string) => {
    const failed = Date.parse(licenseFailedAt[date] ?? "");
    return Number.isFinite(failed) && listedAt - failed < BACKFILL_RETRY_MS;
  };
  const lacking = missing.filter((row) => (licenseAttempts[row.date] ?? 0) < BACKFILL_MAX_ATTEMPTS && !licenseHeld(row.date));
  /** The rows that spent their attempts, as of now: read again after the pass, which can give one up. */
  const licensesGivenUp = () =>
    missing.filter((row) => (licenseAttempts[row.date] ?? 0) >= BACKFILL_MAX_ATTEMPTS).map((row) => row.date);
  const pending: string[] = [];
  const givenUp: string[] = [];
  const waiting: string[] = [];
  for (let d = from; d <= yesterday; d = addDays(d, 1)) {
    if (have.has(d)) continue;
    if ((attempts[d] ?? 0) >= BACKFILL_MAX_ATTEMPTS) {
      givenUp.push(d);
      continue;
    }
    pending.push(d);
    const failed = Date.parse(failedAt[d] ?? "");
    if (Number.isFinite(failed) && listedAt - failed < BACKFILL_RETRY_MS) waiting.push(d);
  }
  const ready = pending.filter((d) => !waiting.includes(d));
  /**
   * A day can be finalized once both snapshots that bound it are stored: the
   * end of the day before and its own end. `have` gains every day this run
   * stores or finds stored. A boundary given up counts too, so the day still
   * gets its explained final null. Finalizing a day with a boundary still to
   * come would publish final nulls ("not read yet") that the boundary's
   * arrival then turns into logged backfill revisions: processing order, not
   * late source data.
   */
  const isBounded = (x: string) => inRecord(x) && [addDays(x, -1), x].every((b) => have.has(b) || givenUp.includes(b));
  // Older than the finalize job's window, nothing but this run finalizes a
  // day. Every bounded day there without a value row is owed, whatever the
  // cursor says: an insert that committed but answered an error, or a
  // forward-era day whose finalize outage outlasted the window.
  // Once per UTC day: a day this scan owes is on the cursor from then on, so
  // the night's later runs would find nothing the cursor does not carry.
  const oldest = addDays(yesterday, -FINALIZE_WINDOW_DAYS);
  const today = utcDate(now.getTime());
  const lastScan = typeof cursor?.detail?.value_scan_date === "string" ? cursor.detail.value_scan_date : null;
  const scanNow = !deps.dryRun && oldest >= RECORD_FIRST_DATE && lastScan !== today;
  if (scanNow) {
    const valued = new Set(await store.listValueDates(RECORD_FIRST_DATE, oldest));
    for (let d = RECORD_FIRST_DATE; d <= oldest; d = addDays(d, 1)) if (!valued.has(d) && isBounded(d)) owed.add(d);
  }
  const valueScanDate = scanNow ? today : lastScan;

  const result: BackfillResult = {
    ok: true, dry_run: deps.dryRun, pending: pending.length, given_up: givenUp, processed: [], kept: [], planned: [],
    finalized: [], finalize_owed: [...owed].sort(), finalize_errors: [], finalize_alarms: [],
    finalize_alarmed: [...alarmed].sort(), finalize_alarms_new: [], finalize_deferred: false, finalize_wait: null,
    failures: [], licenses_added: [], license_failures: [], licenses_given_up: licensesGivenUp(),
    waiting, yielded: null, done: pending.length === 0,
  };

  const saveCursor = () =>
    store.setCursor({
      id: CURSOR_BACKFILL,
      last_round: null,
      last_date: result.processed[result.processed.length - 1] ?? cursor?.last_date ?? null,
      last_poll_at: now.toISOString(),
      detail: {
        attempts, failed_at: failedAt, outage_failures: outageFailures, license_attempts: licenseAttempts,
        license_failed_at: licenseFailedAt,
        pending: result.pending, given_up: result.given_up,
        finalize_owed: [...owed].sort(), finalize_alarmed: [...alarmed].sort(),
        alarm_evaluated_at: Object.fromEntries(Object.entries(evaluatedAt).filter(([d]) => alarmed.has(d)).sort()),
        value_scan_date: valueScanDate,
      },
    });

  if (pending.length === 0 && lacking.length === 0 && (deps.dryRun || owed.size === 0)) {
    // An old-day scan that found nothing is recorded too, so the night's later runs skip it.
    if (scanNow) await saveCursor();
    return result;
  }

  if (ready.length > 0) {
    try {
      const migrationId = await scan.migrationId(deadline);
      for (const date of ready.slice(0, deps.maxDays)) {
        if (clock() + headroomMs > deadline) break;
        let row: SnapshotRow;
        try {
          row = await readSnapshot(scan, migrationId, date, { withLicenses: false, deadline });
        } catch (err) {
          if (err instanceof ScanBusyError) throw err;
          result.failures.push(failure(date, err));
          const outage = isScanOutage(err);
          // A dry run writes nothing, so it counts no attempt either.
          if (!deps.dryRun) {
            // Spaced either way; only a failure that is the day's spends an attempt.
            failedAt[date] = new Date(wallMs()).toISOString();
            if (outage) outageFailures[date] = (outageFailures[date] ?? 0) + 1;
            else attempts[date] = (attempts[date] ?? 0) + 1;
            if ((attempts[date] ?? 0) >= BACKFILL_MAX_ATTEMPTS) result.given_up.push(date);
            else result.waiting.push(date);
          }
          if (outage) break;
          continue;
        }
        if (deps.dryRun) {
          result.planned.push(row);
          continue;
        }
        // The days this snapshot bounds are owed on the cursor before the
        // insert, so an insert that commits and then answers an error, or a
        // restart right after it, loses none of their finalize. A day owed
        // before its other boundary is stored waits for it (isBounded).
        const added = [date, addDays(date, 1)].filter((d) => inRecord(d) && !owed.has(d));
        for (const d of added) owed.add(d);
        if (added.length > 0) await saveCursor();
        // Outside the read's catch: a store failure is not the day's, so it
        // ends the run below instead of spending one of the day's attempts.
        if (await store.insertSnapshot(row)) {
          result.processed.push(date);
        } else {
          result.kept.push(date);
          // Another writer stored it (the forward stage, yesterday's row),
          // and the finalize job settles the days of its window.
          for (const d of added) owed.delete(d);
        }
        have.add(date);
        delete attempts[date];
        delete failedAt[date];
        delete outageFailures[date];
        // The day is owed on the cursor before the next read, so a restart
        // mid-run loses none of its finalize.
        await saveCursor();
      }
    } catch (err) {
      if (err instanceof ScanBusyError) result.yielded = err.reason;
      else result.failures.push(failure("run", err));
    }
  }

  if (lacking.length > 0 && result.yielded == null && !result.failures.some((f) => f.outage)) {
    try {
      for (const row of lacking.slice(0, BACKFILL_LICENSE_MAX_DAYS)) {
        if (clock() + licenseReadHeadroomMs(scan.cls) > deadline) break;
        let count: number;
        try {
          count = await readLicenseCount(scan, row, deadline);
        } catch (err) {
          if (err instanceof ScanBusyError) throw err;
          result.license_failures.push(failure(row.date, err));
          if (isScanOutage(err)) break;
          licenseAttempts[row.date] = (licenseAttempts[row.date] ?? 0) + 1;
          licenseFailedAt[row.date] = new Date(wallMs()).toISOString();
          continue;
        }
        // Outside the read's catch, as the day reads keep their insert: a store
        // failure is not the day's, so it ends the pass below instead of
        // spending one of the day's attempts. The day is owed on the cursor
        // before the write, so a restart right after it loses no finalize.
        owed.add(row.date);
        await saveCursor();
        // As the forward stage completes a row: the core as stored, the count from the same host.
        await store.upsertSnapshot({ ...row, validator_licenses: count });
        result.licenses_added.push(row.date);
        delete licenseAttempts[row.date];
        delete licenseFailedAt[row.date];
        await saveCursor();
      }
    } catch (err) {
      if (err instanceof ScanBusyError) result.yielded = err.reason;
      else result.license_failures.push(failure("run", err));
    }
  }

  const bounded = [...owed].filter(isBounded).sort();
  if (!deps.dryRun && bounded.length > 0) {
    // No finalizeDate starts from the finalize job's slot on, nor after the
    // grace past the Scan deadline, whichever comes first.
    const slotAt = finalizeSlotStart(wallMs());
    const timeAt = now.getTime() + deps.budgetMs + BACKFILL_FINALIZE_GRACE_MS;
    const stopAt = Math.min(slotAt, timeAt);
    const stopReason: FinalizeWait = slotAt <= timeAt ? "finalize_slot" : "time";
    const tooLate = wallMs() >= stopAt;
    const release = tooLate ? null : (deps.finalizeLock ?? claimFinalizeLock)();
    if (release == null) {
      result.finalize_deferred = true;
      result.finalize_wait = tooLate ? stopReason : "lock";
    } else {
      try {
        const context = await loadFinalizeContext(store);
        const due = finalizeQueue(bounded, alarmed, evaluatedAt, context);
        for (const d of due.slice(0, BACKFILL_FINALIZE_MAX_DAYS)) {
          if (wallMs() >= stopAt) {
            result.finalize_wait = stopReason;
            break;
          }
          try {
            const day = await finalizeDate(d, {
              store, now, roundTotalsVerified: deps.roundTotalsVerified,
              collectorStartDate: context.collectorStartDate,
              releasedHolds: context.releasedHolds, keptFinals: context.keptFinals,
            });
            result.finalized.push(d);
            const evaluated = new Date(wallMs()).toISOString();
            const alarms = day.past_deadline ? SERIES_NAMES.filter((name) => ALARM_STATES.has(day.series[name].state)) : [];
            if (alarms.length === 0) {
              owed.delete(d);
              alarmed.delete(d);
              delete evaluatedAt[d];
            } else {
              // Past its deadline and needing a human: it stays owed, so the
              // alarm persists and a release_holds or keep_final entry added
              // for it is applied on a later run.
              for (const name of alarms) {
                const { state, reason } = day.series[name];
                result.finalize_alarms.push({ date: d, series: name, state, ...(reason ? { reason } : {}) });
              }
              alarmed.add(d);
              evaluatedAt[d] = evaluated;
              if (!alarmedBefore.has(d)) result.finalize_alarms_new.push(d);
            }
          } catch (err) {
            result.finalize_errors.push({ date: d, error: message(err) });
            // An alarmed day that throws takes its turn in the rotation too, so it never holds a slot every run.
            if (alarmed.has(d)) evaluatedAt[d] = new Date(wallMs()).toISOString();
          }
        }
      } catch (err) {
        result.finalize_errors.push({ date: "run", error: message(err) });
      } finally {
        release();
      }
    }
  }

  result.pending =
    pending.length - result.processed.length - result.kept.length -
    result.failures.filter((f) => result.given_up.includes(f.date)).length;
  result.waiting = result.waiting.filter((d) => !result.given_up.includes(d)).sort();
  result.done = result.pending === 0;
  result.finalize_owed = [...owed].sort();
  result.finalize_alarmed = [...alarmed].sort();
  result.licenses_given_up = licensesGivenUp();
  result.ok =
    result.failures.length === 0 && result.license_failures.length === 0 && result.finalize_errors.length === 0 && alarmed.size === 0;
  if (!deps.dryRun) await saveCursor();
  return result;
}
