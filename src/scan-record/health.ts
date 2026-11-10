/**
 * Freshness alarms for the open record: per-source latches with
 * transition-only alerts (runtime/feed-health.ts; the finalize latches page
 * the operator, the rest reach the operator's summary), plus the losses
 * recorded at once for that summary (collectorLossAlerts). They never cover a
 * job that stops running; that takes a check from outside the process, such
 * as reading the public status.json.
 */

import { getCacheEntry, setCached } from "../runtime/cache-store";
import type { FeedHealthConfig, FeedOutcome } from "../runtime/feed-health";
import { SERIES_NAMES } from "../open-record/contract";
import { sendAlert } from "../runtime/alerts";
import type { BackfillResult } from "./backfill";
import {
  COLLECTOR_LIMITS,
  forwardSnapshotHealth,
  forwardStartIssuingHealth,
  type ForwardResult,
  type GivenUpLatch,
} from "./collector";
import { ALARM_STATES, dueSeriesOk, type FinalizeResult } from "./finalize";
import { isSvScanHost } from "./scan-budget";
import type { CursorRow } from "./store";

export const COLLECTOR_HEALTH: FeedHealthConfig = {
  stateKey: "feed-health:network-record-collector",
  cacheSource: "network-record-collector",
  // Default three five-minute runs: an issuing round stays visible about 20
  // minutes. The live threshold comes from the measured duty cycle
  // (collectorAlertPolicy), because a closed budget counts as a failed poll.
  failThreshold: 3,
  downWindow: "~15min",
  downTitle: "Open record collector degraded",
  recoveredTitle: "Open record collector recovered",
};

/**
 * The highest threshold the collector latches may use. The given-up latch
 * fails start-issuing on exactly COLLECTOR_LIMITS.givenUpRuns runs in a row
 * (collector.ts), so at givenUpRuns itself whether a lost round pages would
 * depend on how the streak is compared; one run less always crosses it.
 */
export const COLLECTOR_MAX_FAIL_THRESHOLD = COLLECTOR_LIMITS.givenUpRuns - 1;

/**
 * The duty cycle is measured before arming: the collector's latches page
 * only after the operator armed them, with a threshold chosen from 48 hours of
 * measured busy streaks, in scan_record_cursor row 'overrides':
 *   detail.collector_alerts = { armed: true, fail_threshold: 5 }
 * (a database write, so it needs the operator's approval). A threshold
 * above COLLECTOR_MAX_FAIL_THRESHOLD is lowered to it; one that is not an
 * integer of at least 2 takes the default. collectorLossAlerts does not wait
 * for arming.
 */
export function collectorAlertPolicy(overrides: CursorRow | null): FeedHealthConfig | null {
  const raw = overrides?.detail?.collector_alerts as { armed?: unknown; fail_threshold?: unknown } | undefined;
  if (raw?.armed !== true) return null;
  const n = Number(raw.fail_threshold);
  const failThreshold = Number.isInteger(n) && n >= 2 ? Math.min(n, COLLECTOR_MAX_FAIL_THRESHOLD) : COLLECTOR_HEALTH.failThreshold;
  return { ...COLLECTOR_HEALTH, failThreshold, downWindow: `~${failThreshold * 5}min` };
}

/**
 * Whether the record still reads a Super Validator. One Super Validator failing
 * over to another is the normal case and pages nobody (they upgrade one by one);
 * half an hour on another host (the public one last in the list) does, once,
 * and once more when it comes back. Independent of the collector's arming: it
 * only exists once the Scan host list names a Super Validator.
 */
export const SCAN_SOURCE_HEALTH: FeedHealthConfig = {
  stateKey: "feed-health:scan-source",
  cacheSource: "network-record-collector",
  failThreshold: 6,
  downWindow: "~30min",
  downTitle: "The open record is reading a public Scan host, not a Super Validator",
  recoveredTitle: "The open record is back on a Super Validator",
  page: true,
  action: () =>
    "It keeps collecting, and every value names the host that served. If the line says a 429 closed them, the backoff is holding on purpose: see what else reads Super Validators from the same IP before anything else. Otherwise check the forward (SCAN_FORWARD_PORTS) and the reach of the allowlisted IP to the Super Validators.",
};

export function scanSourceOutcomes(
  configuredHosts: readonly string[],
  last: { host: string; at: string } | null,
  /** When a 429 closed the Super Validators until, if it did. */
  closedUntil: string | null = null,
): FeedOutcome[] {
  if (!configuredHosts.some(isSvScanHost)) return [];
  const base = { id: "scan-source", label: "Scan source of the open record" };
  if (last === null) return [{ ...base, ok: true, skipped: true, detail: "no read lately" }];
  const gate = closedUntil === null ? "" : `; every Super Validator closed until ${closedUntil} after a 429`;
  return [{ ...base, ok: isSvScanHost(last.host), detail: `${last.host}, read at ${last.at}${gate}` }];
}

/**
 * One latch per stage. The snapshot has its own id, fed only by the snapshot
 * stage: a day the stage gave up on stays failing on "acs-snapshot" for the
 * rest of the UTC day without touching "rounds-poll" or "start-issuing", whose
 * failures and recoveries page on their own.
 */
const COLLECTOR_STAGES = [
  { id: "rounds-poll", label: "Scan open and issuing rounds" },
  { id: "start-issuing", label: "StartIssuing capture" },
  { id: "acs-snapshot", label: "Daily ACS snapshot" },
] as const;

/**
 * A run that found the lock held. One skip is a normal overlap; a streak means
 * the lock is stuck or SQLite fails (sharedClaim answers false on an error),
 * so the collector has silently stopped. The other stages keep their counters.
 */
export function collectorSkipOutcomes(): FeedOutcome[] {
  return [
    ...COLLECTOR_STAGES.map((s) => ({ ...s, ok: true, skipped: true })),
    { id: "lock", label: "Collector run lock", ok: false, detail: "another run held the lock, or the shared cache failed" },
  ];
}

/**
 * Round numbers for an alert: at most COLLECTOR_LIMITS.abandonedListed of
 * them, then the total. An outage of weeks gives up thousands of rounds in
 * one run, and the collector lists only the lowest of them in `abandoned`.
 */
export function roundsText(rounds: readonly number[], total: number): string {
  const shown = rounds.slice(0, COLLECTOR_LIMITS.abandonedListed);
  return `${shown.join(", ")}${total > shown.length ? ", ..." : ""} (${total} in all)`;
}

function snapshotOutcome(r: ForwardResult, nowMs: number): FeedOutcome {
  const t = new Date(nowMs);
  // The D+1 00:00Z snapshot may not be readable at 00:15; a failed attempt
  // before 01:30 is not counted yet. starved and gave_up always are.
  const grace = t.getUTCHours() < 1 || (t.getUTCHours() === 1 && t.getUTCMinutes() < 30);
  const health = forwardSnapshotHealth(r);
  const stage = r.snapshot != null && r.snapshot !== "deferred" ? r.snapshot : null;
  return {
    id: "acs-snapshot",
    label: "Daily ACS snapshot",
    ok: health !== "failing",
    // Neutral (deferred, waiting, licenses_gave_up, not reached) is no signal:
    // the latch keeps its streak, neither counted up nor reset. A license
    // count given up pages through collectorLossAlerts instead, once a day.
    skipped: health === "neutral" || (stage?.state === "failed" && grace),
    detail: r.snapshot_error ?? (r.snapshot === "deferred" ? `deferred: ${r.snapshot_deferred}` : stage?.detail),
  };
}

/**
 * rounds-poll and start-issuing come from round collection only (`busy`,
 * `errors` and `stalled` never carry the snapshot stage's), acs-snapshot from
 * the stage only. start-issuing and acs-snapshot are the collector's own
 * verdicts (forwardStartIssuingHealth, forwardSnapshotHealth): failing is a
 * failed outcome, neutral a skipped one.
 */
export function collectorOutcomes(r: ForwardResult, nowMs: number): FeedOutcome[] {
  const start = forwardStartIssuingHealth(r);
  return [
    {
      id: "rounds-poll",
      label: "Scan open and issuing rounds",
      // A busy repair (repair_deferred) and a deferred stage are waits, never a failed poll.
      ok: r.host != null && r.busy == null && r.errors.length === 0 && r.stalled == null,
      detail: r.busy ? `budget: ${r.busy}` : r.errors[0] ?? r.stalled ?? undefined,
    },
    {
      id: "start-issuing",
      label: "StartIssuing capture",
      // Failing on not_located, locate_errors, repair_errors or the given-up
      // latch (set by every run with abandoned_total > 0); neutral when
      // nothing failed but due work waited (repair_waiting, a deferred locate
      // or repair, a run that ended early), which keeps the streak.
      ok: start.health !== "failing",
      skipped: start.health === "neutral",
      detail: start.detail ?? undefined,
    },
    snapshotOutcome(r, nowMs),
    { id: "lock", label: "Collector run lock", ok: true },
  ];
}

export const ROUNDS_ABANDONED_TITLE = "Open record gave up rounds";
export const LICENSES_GAVE_UP_TITLE = "Open record gave up a license count";
/** The given-up latch whose alert was delivered last: its total, first and last round (cache store, no TTL). */
export const ROUNDS_ALERT_KEY = "feed-health:network-record-rounds-gave-up";
/** The last day whose given-up license count was paged (cache store, no TTL). */
export const LICENSES_ALERT_KEY = "feed-health:network-record-licenses-gave-up";

type PagedLatch = Pick<GivenUpLatch, "total" | "first" | "last">;

const latchText = (g: PagedLatch) => (g.total === 1 ? `round ${g.first}` : `${g.total} rounds from ${g.first} to ${g.last}`);

/**
 * Records one loss alert for the daily summary, and its marker only once
 * that worked: sendAlert answers false (the alert sink did not take it and the
 * channel fallback refused it) instead of throwing, and a marker written after
 * a failed send would silence the loss for good. A failed send is logged with
 * its whole text. Nothing can be done live about a given-up round, and the
 * backfill completes a day's licenses, so neither pages.
 */
async function sendLossAlert(title: string, text: string, record: { key: string; value: unknown } | null): Promise<void> {
  if (!(await sendAlert("error", title, text))) {
    console.error(`[network-record] alert not delivered: ${title}: ${text}`);
    return;
  }
  if (record == null) return;
  try {
    await setCached(record.key, record.value, { source: COLLECTOR_HEALTH.cacheSource });
  } catch (err) {
    console.error(`[network-record] could not record the delivered alert ${record.key}:`, err);
  }
}

/**
 * The collector reports each given-up round in one run only, but its
 * given-up latch holds them for COLLECTOR_LIMITS.givenUpRuns complete runs:
 * a run inside that window whose latch is not the one on record pages it
 * again, so a failed send (or a restart between the cursor write and the
 * send) cannot lose the page. Only those runs read the marker.
 */
async function roundsLossAlert(r: ForwardResult): Promise<void> {
  const latch = r.given_up;
  const marker: PagedLatch | null = latch != null ? { total: latch.total, first: latch.first, last: latch.last } : null;
  let text: string;
  if (r.abandoned_total > 0) {
    // The latch also covers earlier losses, whose page may not have gone out.
    const held = latch != null && latch.total > r.abandoned_total ? ` The given-up latch holds ${latchText(latch)}.` : "";
    text =
      `Rounds given up for good this run, published as round_missed: ${roundsText(r.abandoned, r.abandoned_total)}.${held} ` +
      `start-issuing stays failing on the given-up latch for ${COLLECTOR_LIMITS.givenUpRuns} runs.`;
  } else {
    if (marker == null) return;
    const paged = await getCacheEntry<PagedLatch>(ROUNDS_ALERT_KEY);
    const onRecord =
      paged.status === "hit" &&
      paged.value.total === marker.total &&
      paged.value.first === marker.first &&
      paged.value.last === marker.last;
    if (onRecord) return;
    text =
      `Rounds given up for good, published as round_missed: ${latchText(marker)}. ` +
      `No delivered alert for them is on record, so this run sends it.`;
  }
  await sendLossAlert(ROUNDS_ABANDONED_TITLE, text, marker && { key: ROUNDS_ALERT_KEY, value: marker });
}

async function licensesLossAlert(r: ForwardResult): Promise<void> {
  const stage = r.snapshot != null && r.snapshot !== "deferred" ? r.snapshot : null;
  if (stage?.state !== "licenses_gave_up") return;
  const paged = await getCacheEntry<{ date: string }>(LICENSES_ALERT_KEY);
  if (paged.status === "hit" && paged.value.date === stage.date) return;
  await sendLossAlert(
    LICENSES_GAVE_UP_TITLE,
    `validator_licenses for ${stage.date} stays empty; the day's other snapshot series are stored. ${stage.detail ?? ""}`.trim(),
    { key: LICENSES_ALERT_KEY, value: { date: stage.date } },
  );
}

/**
 * Losses recorded at once for the daily summary, outside the latches and
 * whether or not they are armed: arming waits for the measured duty cycle
 * because a busy budget fails a poll, and neither loss comes from one run's
 * budget. Each one is marked in the cache store once it was recorded, and only then,
 * so a send that failed is sent again by the next run that still reports the
 * loss; a marker that
 * cannot be read or written records it again (a repeat is better than a
 * silent loss).
 *   rounds-abandoned  a run with abandoned_total > 0 records it, whatever
 *                     failThreshold says, listing this run's rounds. The
 *                     given-up latch holds them for givenUpRuns runs, which
 *                     record the latch again until it is on record
 *                     (ROUNDS_ALERT_KEY), and keeps start-issuing failing, so
 *                     the loss also reaches the armed latch and its recovery.
 *   licenses          the day's ValidatorLicense count gave up while its core
 *                     row is stored (licenses_gave_up), which the latch
 *                     counts neutral: it is recorded here, once per day. Every
 *                     run of that day reports the same state, so the day sent is
 *                     kept in the cache store (LICENSES_ALERT_KEY).
 * Never throws: sendAlert does not, getCacheEntry does not, and the
 * marker writes are caught.
 */
export async function collectorLossAlerts(r: ForwardResult): Promise<void> {
  await roundsLossAlert(r);
  await licensesLossAlert(r);
}

/**
 * Finalize (the hourly finalize job, at :35). Armed from its first run:
 * finalize makes no Scan calls, so the collector's duty cycle does not apply.
 * Every run that claims FINALIZE_LOCK reports the same ids, one per series of
 * the due day and "run": checkFeedHealth keeps only
 * the ids it is given, so an id left out of one run would lose its streak and
 * its latch. The lock has its own key (FINALIZE_LOCK_HEALTH).
 */
export const FINALIZE_HEALTH: FeedHealthConfig = {
  stateKey: "feed-health:network-record-finalize",
  cacheSource: "network-record-finalize",
  // Two hourly runs: the due day is then more than an hour past its target.
  failThreshold: 2,
  downWindow: "~2h",
  downTitle: "Open record is not settling",
  recoveredTitle: "Open record settling again",
  // The daily record is published under our name: page now.
  page: true,
  action: () => "read the finalize job's log; the day stays provisional, past the public final-by-D+1-03:00-UTC promise, until it settles.",
};

/**
 * Why a run is not ok, for its alert line: the days that threw (or, for a run
 * that could not start, its own error), then the days past their deadline
 * with a series that needs a human. Only the due day has series outcomes, so
 * this line is where an older day is named.
 */
function finalizeRunDetail(r: FinalizeResult): string | undefined {
  const parts = r.errors.length > 0 ? r.errors.map((e) => `${e.date}: ${e.error}`) : r.error ? [r.error] : [];
  for (const d of r.days) {
    if (!d.past_deadline) continue;
    const alarms = [...ALARM_STATES].filter((s) => (d.counts[s] ?? 0) > 0).map((s) => `${d.counts[s]} ${s}`);
    if (alarms.length > 0) parts.push(`${d.date}: ${alarms.join(", ")}`);
  }
  if (parts.length === 0 && !r.ok) parts.push(`due day ${r.date} not settled`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

export function finalizeOutcomes(r: FinalizeResult): FeedOutcome[] {
  const outcomes: FeedOutcome[] = SERIES_NAMES.map((name) => {
    const s = r.series[name];
    return {
      id: `series:${name}`,
      label: `${name} for ${r.date}`,
      // The rule of the run's `ok`: a round never captured, or a source that
      // never answered, is explained in gaps.csv and still worth a page.
      ok: s != null && dueSeriesOk(s),
      // The due day was not evaluated: its series are unknown, not failed.
      skipped: r.error != null,
      detail: s ? `${s.state}${s.gap_code ? ` (${s.gap_code})` : ""}${s.reason ? `: ${s.reason}` : ""}` : "no state",
    };
  });
  outcomes.push({ id: "run", label: "finalize run", ok: r.ok && r.error == null, detail: finalizeRunDetail(r) });
  return outcomes;
}

/**
 * FINALIZE_LOCK on its own key. A run that finds the lock held runs while
 * the holder writes FINALIZE_HEALTH: on that key its read and write could
 * land around the holder's and overwrite the holder's series and run state.
 * So a skip writes only this key, and the run that claims the lock reports
 * it ok here. One skip is an overlap (another finalize run, or the backfill
 * around its finalizeDate calls); two in a row mean the lock is stuck or the
 * shared cache fails (sharedClaim answers false on an error), so the record
 * has stopped settling.
 */
export const FINALIZE_LOCK_HEALTH: FeedHealthConfig = {
  stateKey: "feed-health:network-record-finalize-lock",
  cacheSource: "network-record-finalize",
  failThreshold: 2,
  downWindow: "~2h",
  downTitle: "Open record finalize lock is stuck",
  recoveredTitle: "Open record finalize lock free again",
  page: true,
  action: () => "read the finalize job's log; no day settles while the lock is held.",
};

/** The lock's one outcome: claimed, or found held. */
export function finalizeLockOutcomes(claimed: boolean): FeedOutcome[] {
  return claimed
    ? [{ id: "lock", label: "Finalize run lock", ok: true }]
    : [{ id: "lock", label: "Finalize run lock", ok: false, detail: "another run held the lock, or the shared cache failed" }];
}

/**
 * The backfill job (every five minutes from 02:02 to
 * 05:57 UTC). Every run reports the same six ids, so none loses its streak.
 */
export const BACKFILL_HEALTH: FeedHealthConfig = {
  stateKey: "feed-health:network-record-backfill",
  cacheSource: "network-record-backfill",
  // Six five-minute runs in the window without a single day stored.
  failThreshold: 6,
  downWindow: "~30min",
  downTitle: "Open record backfill is not progressing",
  recoveredTitle: "Open record backfill progressing again",
};

const FINALIZE_WAIT_TEXT: Record<NonNullable<BackfillResult["finalize_wait"]>, string> = {
  lock: "finalize lock held",
  finalize_slot: "left clear of the finalize job's :35 run",
  time: "out of time this run",
};

export function backfillOutcomes(r: BackfillResult): FeedOutcome[] {
  const owed = `${r.finalize_owed.length} days owed a finalize`;
  // Every pending day is held back after a failed read (BACKFILL_RETRY_MS):
  // the run read nothing, which is a wait, not a signal either way.
  const idle =
    r.pending > 0 && r.waiting.length === r.pending && r.yielded == null &&
    r.processed.length + r.kept.length + r.failures.length === 0;
  return [
    {
      id: "progress",
      label: "Backfill progress",
      // A day another writer stored first is done too.
      ok: r.done || r.processed.length + r.kept.length > 0,
      skipped: idle,
      detail:
        `${r.pending} days pending${r.yielded ? `; yielded (${r.yielded})` : ""}` +
        (r.waiting.length > 0 ? `; ${r.waiting.length} waiting to retry` : ""),
    },
    {
      id: "failures",
      label: "Backfill snapshot reads",
      ok: r.failures.length === 0,
      skipped: idle,
      detail: r.failures[0] ? `${r.failures[0].date}: ${r.failures[0].error}` : undefined,
    },
    {
      id: "given-up",
      label: "Days the backfill gave up on",
      ok: r.given_up.length === 0,
      detail: r.given_up.length > 0 ? `${r.given_up.join(", ")}: clear their attempts in scan_record_cursor 'backfill' to retry` : undefined,
    },
    {
      id: "finalize",
      label: "Backfill finalize of the days it stored",
      // A day whose finalize threw stays owed and is tried again next run.
      ok: r.finalize_errors.length === 0,
      // FINALIZE_LOCK held by the finalize job, or the job's slot, is a
      // wait, not a signal: the owed days go to the next run. A lock that
      // stays held pages on the finalize job's own lock latch.
      skipped: r.finalize_deferred,
      detail: r.finalize_errors[0]
        ? `${r.finalize_errors[0].date}: ${r.finalize_errors[0].error}; ${owed}`
        : r.finalize_owed.length > 0
          ? `${owed}${r.finalize_wait ? ` (${FINALIZE_WAIT_TEXT[r.finalize_wait]})` : ""}`
          : undefined,
    },
    {
      id: "finalize-alarms",
      label: "Days the backfill finalized that need a human",
      // Older than the finalize job's window, the backfill is the only one
      // that finalizes a day: a held gate, a conflict or a null with no
      // reason past the deadline stays owed and failing here until it settles.
      ok: r.finalize_alarmed.length === 0,
      detail:
        r.finalize_alarms.length > 0
          ? r.finalize_alarms.map((a) => `${a.date} ${a.series} ${a.state}${a.reason ? `: ${a.reason}` : ""}`).join("; ")
          : r.finalize_alarmed.length > 0
            ? `${r.finalize_alarmed.join(", ")}: alarmed, not evaluated again this run`
            : undefined,
    },
    {
      id: "licenses",
      label: "Backfill license counts",
      ok: r.license_failures.length === 0 && r.licenses_given_up.length === 0,
      // No license work this run: no signal either way.
      skipped: r.licenses_added.length + r.license_failures.length + r.licenses_given_up.length === 0,
      detail: r.license_failures[0]
        ? `${r.license_failures[0].date}: ${r.license_failures[0].error}`
        : r.licenses_given_up.length > 0
          ? `${r.licenses_given_up.join(", ")}: gave up; clear their license_attempts in scan_record_cursor 'backfill' to retry`
          : undefined,
    },
  ];
}
