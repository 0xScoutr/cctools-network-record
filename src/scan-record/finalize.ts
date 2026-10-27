/**
 * The single writer of network_record_values and network_record_gaps.
 *
 *   before D+1 02:00Z  values are provisional; a transient gap stays open
 *   after              values become final; an explained null becomes a final
 *                      null; a missed round's gap becomes backfill_planned
 *   a failing gate     stays provisional, gap sanity_gate_failed, alert; a
 *                      human may release the value it held
 *                      (overrides.release_holds)
 *   a final null that later gets data   filled by revise_network_record()
 *                      with kind 'backfill' and the computed source host,
 *                      as_of and method (never the null's own method: a gap
 *                      is labelled by the branch that could not fill it),
 *                      logged, gap resolved; late data that fails a gate is
 *                      'held' instead: the null stays and its gap names the
 *                      gate, until the gate passes or a human releases it
 *   a withdrawn value  left alone until a human correction: no value write,
 *                      no revision, no gap resolution (RECORD_SQLSTATE.WITHDRAWN).
 *                      The withdrawn row names no source host and no as_of, so
 *                      the restoring correction (a human, never this job)
 *                      passes both, or the RPC refuses it (P0001)
 *   a final value whose value is unchanged              settled as it is:
 *                      compared through sameFinalValue (the contract's copy
 *                      of the RPC's rule: equal after rounding to the
 *                      column's 10 places), so another host, as_of or method
 *                      with the same value is neither a revision nor a
 *                      conflict, and the stored provenance stays as first
 *                      recorded
 *   a license count the snapshot stage gave up on       a final null with
 *                      its own reason (licensesGaveUpReason), found from
 *                      CURSOR_SNAPSHOT and then from its own open gap
 *   a license count nothing will read any more          once the stage has
 *                      moved past the day (snapshotStageDate), a final null
 *                      that is backfill_planned (licensesNotReadReason)
 *   a final value that would change     never written: 'conflict', alert
 *   a final value a human set           kept once its date|series is in
 *                      overrides.keep_final: 'final', no alert, and the open
 *                      gaps of a null it filled resolved
 *   a null with no reason               never finalized: 'unexplained', alert
 *
 * Two human lists live in scan_record_cursor row 'overrides'
 * (CURSOR_OVERRIDES), each a database write that, like every override, needs
 * the operator's approval. They mean different things and never stand in for
 * each other:
 *
 *   detail.release_holds  entries "date|series|value": releases a gate hold on
 *                      that value only, compared through sameFinalValue. The
 *                      value the gate held is published as if the gate had
 *                      passed. Any other value of the date|series (raw rows
 *                      that changed after the human checked them, before or
 *                      after the day is final) is gated again: held and
 *                      alerted while nothing final exists, a conflict once a
 *                      final value does. An entry without its value
 *                      ("date|series") releases nothing.
 *   detail.keep_final  entries "date|series": keeps a final value the raw
 *                      rows cannot give back: one
 *                      a human set through REVISE_RPC, as a correction, a
 *                      method revision that changed the value, or a null
 *                      filled by hand. Conflicts on it are no longer reported,
 *                      whatever its raw rows say later. It releases no hold.
 *
 * So the runbook of such a revision has two writes: the RPC, then the
 * date|series added to overrides.keep_final. Until the second lands, every
 * hourly run reports the value as a conflict and the run is not ok.
 *
 * An earlier single list, detail.accept, did both, so releasing a hold also
 * silenced every later conflict on that date|series. detail.accept is not
 * read: reading it as either list would keep the ambiguity. A row that still
 * carries it releases and keeps nothing, so a hold stays held and pages,
 * never silently kept.
 *
 * Every write marks the record dirty so the publisher re-renders the files,
 * including the writes a failed run committed before its error. Gaps move in
 * two phases around the value batch: the current reason of a row is opened
 * (or its text or status updated) before the batch, and the reasons that no
 * longer apply are resolved only after it. A failure at any point leaves at
 * worst an extra open gap, never a published null without its reason.
 *
 * Single writer means one finalizeDate at a time: every caller holds
 * FINALIZE_LOCK.
 */

import {
  CURSOR_FORWARD,
  CURSOR_OVERRIDES,
  CURSOR_SNAPSHOT,
  RECORD_FIRST_DATE,
  RECORD_SQLSTATE,
  SERIES_NAMES,
  addDays,
  endOfDay,
  sameFinalValue,
  settleDeadlineMs,
  settledDueDate,
  utcDate,
  type SeriesName,
  type ValueStatus,
} from "../open-record/contract";
import type { RoundTotalsVerification } from "./config";
import { computeDay, licensesGaveUpReason, resolveRange, type ComputedSeries, type DayInputs } from "./day-values";
import { SNAPSHOT_RETRY, snapshotStageDate } from "./snapshot";
import { recordErrorCode, type RecordStore, type RoundRow, type ValueWrite } from "./store";

export const FINALIZE_WINDOW_DAYS = 7;

/**
 * Held by every caller of finalizeDate and runFinalize (sharedClaim): the
 * hourly finalize job for its whole run, and the backfill around its finalizeDate
 * calls only (held through its Scan part, it would starve the hourly run
 * from 02:00 to 06:00). A backfill that finds it held finalizes its days on
 * a later run: a day older than the window has no other writer.
 *
 * finalizeDate reads a day, then writes it: two callers on one day read the
 * same final null, both call revise('backfill') and the second is refused
 * ("a backfill fills a null"), and two first inserts of one gap race its
 * open-gap unique index (23505). The database guards keep the record whole;
 * the lock keeps a day from being aborted halfway and paging for nothing.
 * holdMs matches the 600 s limit the scheduler gives one job run.
 */
export const FINALIZE_LOCK = {
  key: "network-record:finalize-lock",
  holdMs: 600_000,
} as const;

export type SeriesStateName = "final" | "final_null" | "provisional" | "held" | "revised" | "conflict" | "unexplained";

export interface SeriesState {
  state: SeriesStateName;
  reason?: string;
  gap_code?: string;
}

export interface DayResult {
  date: string;
  past_deadline: boolean;
  series: Record<SeriesName, SeriesState>;
  wrote: number;
  warnings: string[];
}

export interface FinalizeResult {
  ok: boolean;
  date: string;
  series: Partial<Record<SeriesName, SeriesState>>;
  days: Array<{ date: string; past_deadline: boolean; wrote: number; counts: Partial<Record<SeriesStateName, number>> }>;
  warnings: Array<{ date: string; note: string }>;
  /** Days whose finalize threw, oldest first; absent from `days`. Any entry makes the run not ok. */
  errors: Array<{ date: string; error: string }>;
  /**
   * The due day's own failure, as "date: message": set only when the due day
   * was not evaluated (a caller whose run failed as a whole sets it too).
   * `series` is then empty, so its per-series outcomes are unknown, not
   * failed. A failure on any other day of the window leaves it unset: the due
   * day's series still report in full, and that failure shows in `errors`
   * and makes `ok` false.
   */
  error?: string;
}

export interface FinalizeContext {
  collectorStartDate: string | null;
  /** overrides.release_holds: "date|series" to the values whose gate hold a human released (see the header). */
  releasedHolds: ReadonlyMap<string, readonly string[]>;
  /** overrides.keep_final: "date|series" whose human-set final value is kept, with no conflict reports (see the header). */
  keptFinals: ReadonlySet<string>;
}

const stringSet = (raw: unknown): Set<string> =>
  new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);

/**
 * overrides.release_holds as "date|series" to the values a human checked. An
 * entry that names no value, or a value that is not a number, releases
 * nothing: the hold stays and pages.
 */
export function releasedHoldsOf(raw: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const parts = entry.split("|");
    if (parts.length !== 3) continue;
    const [day, name, checked] = parts;
    try {
      sameFinalValue(checked, checked);
    } catch {
      continue;
    }
    const key = `${day}|${name}`;
    out.set(key, [...(out.get(key) ?? []), checked]);
  }
  return out;
}

/** Collector start (first full day after it first ran) and the two human lists of date|series. */
export async function loadFinalizeContext(store: RecordStore): Promise<FinalizeContext> {
  const [forward, overrides] = await Promise.all([store.getCursor(CURSOR_FORWARD), store.getCursor(CURSOR_OVERRIDES)]);
  const startedAt = forward?.detail?.started_at;
  return {
    collectorStartDate: typeof startedAt === "string" ? addDays(utcDate(Date.parse(startedAt)), 1) : null,
    releasedHolds: releasedHoldsOf(overrides?.detail?.release_holds),
    keptFinals: stringSet(overrides?.detail?.keep_final),
  };
}

/** Evaluate one day and write what changed. The caller holds FINALIZE_LOCK. */
export async function finalizeDate(
  date: string,
  deps: {
    store: RecordStore;
    now: Date;
    roundTotalsVerified: RoundTotalsVerification;
    collectorStartDate: string | null;
    releasedHolds: FinalizeContext["releasedHolds"];
    keptFinals: FinalizeContext["keptFinals"];
  },
): Promise<DayResult> {
  const { store, now } = deps;
  const prevDate = addDays(date, -1);
  const [snapshot, prevSnapshot, started, prevValues, existing, existingGaps, supply, prevSupply, snapshotCursor] = await Promise.all([
    store.getSnapshot(date),
    store.getSnapshot(prevDate),
    store.getRoundsStartedBetween(`${date}T00:00:00Z`, endOfDay(date)),
    store.getValues(prevDate),
    store.getValues(date),
    store.getGaps(date),
    store.getSupplyAt(endOfDay(date)),
    store.getSupplyAt(endOfDay(prevDate)),
    store.getCursor(CURSOR_SNAPSHOT),
  ]);
  // The license count the snapshot stage gave up on (licenses_gave_up): its
  // spent attempts name the day on CURSOR_SNAPSHOT until the next day's stage
  // takes the row over at 00:15, and from the first publication on, the
  // day's open gap carries the reason, so the reason never flips back.
  const stageAttempts = snapshotCursor?.last_date === date ? snapshotCursor.detail?.attempts : undefined;
  const licensesGaveUp =
    snapshot != null &&
    snapshot.validator_licenses == null &&
    ((typeof stageAttempts === "number" && stageAttempts >= SNAPSHOT_RETRY.maxAttempts) ||
      existingGaps.some(
        (g) => g.series === "validator_licenses" && g.resolved_at == null && g.reason === licensesGaveUpReason(date),
      ));
  const range = resolveRange(snapshot, prevSnapshot, started);
  // Rounds first - 1 and last + 1 confirm the edges of a forward range
  // (DayInputs.neighbours): read in the same call as the range and kept out
  // of roundsInRange. A snapshot range has its edges from the ACS readings.
  let roundsInRange: RoundRow[] = [];
  let neighbours: DayInputs["neighbours"] = { before: null, after: null };
  if (range?.source === "forward") {
    const rows = await store.getRounds(range.first - 1, range.last + 1);
    roundsInRange = rows.filter((r) => r.round >= range.first && r.round <= range.last);
    neighbours = {
      before: rows.find((r) => r.round === range.first - 1) ?? null,
      after: rows.find((r) => r.round === range.last + 1) ?? null,
    };
  } else if (range) {
    roundsInRange = await store.getRounds(range.first, range.last);
  }
  const computed = computeDay({
    date,
    range,
    roundsInRange,
    startedInDay: started,
    neighbours,
    snapshot,
    prevSnapshot,
    prevValues: Object.fromEntries(prevValues.map((v) => [v.series, v.value])),
    supply,
    prevSupply,
    collectorStartDate: deps.collectorStartDate,
    roundTotalsVerified: deps.roundTotalsVerified,
    licensesGaveUp,
    // The snapshot stage's own rule for the day it works on: once it has
    // moved past `date`, nothing reads the day's license count again.
    snapshotStageDate: snapshotStageDate(now.getTime()),
  });

  const nowIso = now.toISOString();
  const pastDeadline = now.getTime() >= settleDeadlineMs(date);
  const byName = new Map(existing.map((v) => [v.series, v]));
  const openGaps = existingGaps.filter((g) => g.resolved_at == null);
  const writes: ValueWrite[] = [];
  /** Non-final series whose stale gaps are resolved once the value batch is written. */
  const afterBatch: Array<{ name: SeriesName; c: ComputedSeries }> = [];
  const series = {} as Record<SeriesName, SeriesState>;
  let wrote = 0;

  /**
   * A withdrawal lasts until a human correction, and the database refuses
   * every other write to a withdrawn series with RECORD_SQLSTATE.WITHDRAWN.
   * Its open 'withdrawn' gaps were read above, before any write, so those
   * series are left out of the value writes, the revisions and the gap
   * resolution. A withdrawal made after the reads still comes back as
   * WITHDRAWN: that (date, series) alone is skipped, by code. Any other
   * error, FINAL_CHANGED included, fails the run.
   */
  const withdrawn = new Set<string>(openGaps.filter((g) => g.reason_code === "withdrawn").map((g) => g.series));
  const withdrawnState = (): SeriesState => ({
    state: "final_null",
    reason: "withdrawn; only a correction restores it",
    gap_code: "withdrawn",
  });
  const skipIfWithdrawn = (err: unknown, names: Iterable<SeriesName>) => {
    if (recordErrorCode(err) !== RECORD_SQLSTATE.WITHDRAWN) throw err;
    for (const name of names) {
      withdrawn.add(name);
      series[name] = withdrawnState();
    }
  };

  /**
   * Phase 1 of the gaps of `name`: open the computed reason, or update its
   * text or status, when it is new or changed. It never resolves anything, so
   * it runs before the value batch: a batch that then fails leaves at worst
   * an extra open gap beside the previous row.
   */
  const openGap = async (name: SeriesName, c: ComputedSeries) => {
    if (!c.gap) return;
    const code = c.gap.reason_code;
    const gapStatus = code === "round_missed" && pastDeadline ? "backfill_planned" : c.gap.status;
    const current = openGaps.find((g) => g.series === name && g.reason_code === code);
    if (!current || current.reason !== c.gap.reason || current.status !== gapStatus) {
      await store.upsertGap({ date, series: name, reason_code: code, reason: c.gap.reason, status: gapStatus });
      wrote++;
    }
  };
  /**
   * Phase 2: resolve every open reason of `name` other than the computed one
   * (all of them when the value has none). It runs only once the row those
   * reasons explained is written, so a failure here leaves at worst a stale
   * extra gap, never a null without its reason.
   */
  const resolveStaleGaps = async (name: SeriesName, c: ComputedSeries) => {
    const keep = c.gap?.reason_code;
    if (openGaps.some((g) => g.series === name && g.reason_code !== keep)) {
      await store.resolveGaps(date, name, nowIso, keep);
      wrote++;
    }
  };
  /**
   * Both phases at once, for a series whose value row is not written: final
   * nulls too, whose value never changes but whose reason can
   * (source_unavailable before the backfill, not_collected after it).
   */
  const reconcileGaps = async (name: SeriesName, c: ComputedSeries) => {
    await openGap(name, c);
    await resolveStaleGaps(name, c);
  };
  /** A gate hold a human released for this very value (overrides.release_holds). */
  const releasedFor = (name: SeriesName, value: string | null) =>
    value != null && (deps.releasedHolds.get(`${date}|${name}`) ?? []).some((checked) => sameFinalValue(value, checked));

  try {
    for (const name of SERIES_NAMES) {
      if (withdrawn.has(name)) {
        series[name] = withdrawnState();
        continue;
      }
      try {
        let c: ComputedSeries = computed.series[name];
        if (c.hold && releasedFor(name, c.value)) c = { ...c, hold: null, gap: null };
        const e = byName.get(name);

        if (c.value == null && !c.gap) {
          series[name] = { state: "unexplained", reason: "null with no gap reason" };
          continue;
        }

        const status: ValueStatus = c.hold
          ? "provisional"
          : c.value != null
            ? pastDeadline ? "final" : "provisional"
            : c.gap?.transient && !pastDeadline ? "provisional" : "final";

        if (e?.status === "final") {
          // The value alone decides, as in revise_network_record() (sameFinalValue:
          // equal after rounding to the column's 10 places): an unchanged value
          // is settled, never a revision and never a conflict, whatever host,
          // as_of or method the computation names now. REVISE_RPC could not
          // change those alone.
          if (sameFinalValue(e.value, c.value)) {
            if (!c.hold) await reconcileGaps(name, c);
            series[name] = { state: e.value == null ? "final_null" : "final", gap_code: c.gap?.reason_code };
            continue;
          }
          if (e.value == null && c.value != null) {
            if (c.hold) {
              // Late data that fails a gate is held like any other value: the
              // final null stays, and its gap names the gate in place of why
              // the value was missing, until the gate passes or a human
              // releases the date|series (which clears the hold above).
              await reconcileGaps(name, c);
              series[name] = { state: "held", reason: c.hold, gap_code: c.gap?.reason_code };
              continue;
            }
            const why = openGaps.find((g) => g.series === name)?.reason ?? "the value arrived after the day was final";
            // The value is new, and so is its provenance: the RPC keeps the
            // null's own method unless it is given this one.
            await store.revise(date, name, c.value, "backfill", `Late data: ${why}`, c.source_host, c.as_of, c.method);
            await store.resolveGaps(date, name, nowIso);
            wrote++;
            series[name] = { state: "revised", reason: why };
            continue;
          }
          if (deps.keptFinals.has(`${date}|${name}`)) {
            // A value a human set through REVISE_RPC (a correction, a method
            // revision that changed it, or a null filled by hand) is one the
            // raw rows cannot give back: correcting what the source served is
            // the point. keep_final, never release_holds, keeps it as
            // settled, not a conflict. It is published, so no gap stays open
            // beside it.
            await reconcileGaps(name, { ...c, gap: null });
            series[name] = { state: "final", reason: "accepted: final value kept" };
            continue;
          }
          series[name] = {
            state: "conflict",
            reason: `final ${e.value ?? "null"} would become ${c.value ?? "null"}${c.hold ? ` (${c.hold})` : ""}`,
          };
          continue;
        }

        const changed = !e || !sameFinalValue(e.value, c.value) || e.status !== status || e.method !== c.method || e.source_host !== c.source_host;
        // The reason of the row about to be written is open before the row
        // is; the reasons it replaces are resolved after the batch.
        await openGap(name, c);
        if (changed) {
          writes.push({
            date, series: name, value: c.value, status, source_host: c.source_host, method: c.method,
            as_of: c.as_of, retrieved_at: nowIso, finalized_at: status === "final" ? nowIso : null,
          });
        }

        afterBatch.push({ name, c });

        series[name] = c.hold
          ? { state: "held", reason: c.hold, gap_code: c.gap?.reason_code }
          : {
              state: status === "final" ? (c.value == null ? "final_null" : "final") : "provisional",
              reason: c.gap?.reason,
              gap_code: c.gap?.reason_code,
            };
      } catch (err) {
        skipIfWithdrawn(err, [name]);
      }
    }

    let pending = writes.filter((w) => !withdrawn.has(w.series));
    if (pending.length > 0) {
      try {
        await store.upsertValues(pending);
      } catch (err) {
        // One batch statement: a series withdrawn after the reads refuses all of
        // it. Re-read the open withdrawals, leave those series out, write the rest once.
        if (recordErrorCode(err) !== RECORD_SQLSTATE.WITHDRAWN) throw err;
        const since = (await store.getGaps(date))
          .filter((g) => g.reason_code === "withdrawn" && g.resolved_at == null && g.series !== "all")
          .map((g) => g.series as SeriesName);
        skipIfWithdrawn(err, since);
        pending = pending.filter((w) => !withdrawn.has(w.series));
        if (pending.length > 0) await store.upsertValues(pending);
      }
      wrote += pending.length;
    }

    // Only now, with the value rows written, are the reasons they replaced
    // resolved: a batch that failed above resolved nothing, so a published
    // null never loses its reason. A resolution that fails here after the
    // batch committed leaves a stale extra gap and marks the day dirty below;
    // the next run finds the value unchanged and resolves it.
    for (const { name, c } of afterBatch) {
      if (withdrawn.has(name)) continue;
      try {
        await resolveStaleGaps(name, c);
      } catch (err) {
        skipIfWithdrawn(err, [name]);
      }
    }
  } catch (err) {
    // Writes made before the failure are committed, one statement each, and a
    // next run that finds them matching writes nothing: mark them for the
    // render now. The run's own error is the one that propagates.
    if (wrote > 0) {
      await store.markDirty(nowIso).catch((markErr: unknown) => {
        console.error(`[scan-record] finalize ${date}: not marked dirty after a failure:`, markErr);
      });
    }
    throw err;
  }
  if (wrote > 0) await store.markDirty(nowIso);
  return { date, past_deadline: pastDeadline, series, wrote, warnings: computed.warnings };
}

/** Series states that need a human: a run is not ok while a day past its settle deadline has one. */
export const ALARM_STATES: ReadonlySet<SeriesStateName> = new Set(["held", "conflict", "unexplained"]);
const SETTLED = new Set<SeriesStateName>(["final", "final_null", "revised"]);
/**
 * An explained null that still means the pipeline failed on the due day: a
 * run is never ok on an empty or half-collected record.
 */
export const FAILURE_GAP_CODES: ReadonlySet<string> = new Set(["source_unavailable", "round_missed"]);

/**
 * A series of the due day that lets the run be ok: settled, and not a null
 * whose reason is a failure of the pipeline. The finalize alarm judges each
 * series by it too (health.ts finalizeOutcomes), so a page and `ok` cannot
 * disagree.
 */
export function dueSeriesOk(s: SeriesState): boolean {
  return SETTLED.has(s.state) && !FAILURE_GAP_CODES.has(s.gap_code ?? "");
}

/** Hourly, under FINALIZE_LOCK: re-evaluate the last seven days (the settle and repair window). */
export async function runFinalize(deps: { store: RecordStore; now: Date; roundTotalsVerified: RoundTotalsVerification }): Promise<FinalizeResult> {
  const { store, now } = deps;
  const context = await loadFinalizeContext(store);
  const today = utcDate(now.getTime());
  // Judged at the settle cut (D+1 02:00), not the 03:00 promise: the 02:35
  // run already answers for D, so a day that will not settle pages early.
  const due = settledDueDate(now.getTime());
  const days: DayResult[] = [];
  const errors: FinalizeResult["errors"] = [];
  // Oldest first, so each day's gates read the day before as this run left
  // it. A day that throws is recorded and the others still run: one bad old
  // day must not hold back the due day for up to a week.
  for (let i = FINALIZE_WINDOW_DAYS; i >= 1; i--) {
    const date = addDays(today, -i);
    if (date < RECORD_FIRST_DATE) continue;
    try {
      days.push(
        await finalizeDate(date, {
          store, now, roundTotalsVerified: deps.roundTotalsVerified,
          collectorStartDate: context.collectorStartDate,
          releasedHolds: context.releasedHolds, keptFinals: context.keptFinals,
        }),
      );
    } catch (err) {
      errors.push({ date, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const dueDay = days.find((d) => d.date === due);
  const dueError = errors.find((e) => e.date === due);
  const ok =
    errors.length === 0 &&
    dueDay != null &&
    Object.values(dueDay.series).every(dueSeriesOk) &&
    days.every((d) => !d.past_deadline || Object.values(d.series).every((s) => !ALARM_STATES.has(s.state)));
  return {
    ok,
    date: due,
    series: dueDay?.series ?? {},
    days: days.map((d) => {
      const counts: Partial<Record<SeriesStateName, number>> = {};
      for (const s of Object.values(d.series)) counts[s.state] = (counts[s.state] ?? 0) + 1;
      return { date: d.date, past_deadline: d.past_deadline, wrote: d.wrote, counts };
    }),
    warnings: days.flatMap((d) => d.warnings.map((note) => ({ date: d.date, note }))),
    errors,
    error: dueError ? `${due}: ${dueError.error}` : undefined,
  };
}
