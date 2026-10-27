/**
 * Forward collection, every five minutes:
 *   1. the open and issuing rounds; each open round's price, issuance config
 *      and tick are stored while it is open (an IssuingMiningRound carries
 *      neither);
 *   2. the StartIssuing split of every issuing round not yet captured, found
 *      by the IssuingMiningRound contract it created;
 *   3. once a day, the ACS snapshot (snapshot.ts), inside the run's lock and
 *      ahead of the repairs;
 *   4. targeted repair of rounds that started while no run was looking (a
 *      restart, a database outage, a burst of 429s), found by
 *      paging /v2/updates around a time interpolated from captured neighbours.
 *
 * It writes raw inputs only. finalize.ts is the single writer of values.
 */

import { CURSOR_FORWARD, METHOD_SCAN } from "../open-record/contract";
import { format } from "./decimal";
import {
  categoryAmounts,
  findStartIssuing,
  type IssuingRoundRef,
  type OpenRoundMeta,
  type ScanTransaction,
  type StartIssuingCapture,
} from "./rounds";
import { ScanBusyError } from "./scan-budget";
import { scanCallWorstCaseMs, type ScanApi } from "./scan-client";
import { runSnapshotStage, snapshotStageHealth, type SnapshotHealth, type SnapshotStageResult } from "./snapshot";
import { blankRound, type RecordStore, type RoundCaptureWrite, type RoundRow } from "./store";

/**
 * The collector's run lock. The scheduler that runs the collector claims it
 * and passes `claimedAt + holdMs - marginMs` as the run's deadline, so every
 * Scan call of the run ends before the lock can expire and a next run overlap it.
 */
export const COLLECTOR_LOCK = {
  key: "network-record:collector-lock",
  holdMs: 290_000,
  marginMs: 10_000,
} as const;

export const COLLECTOR_LIMITS = {
  capturesPerRun: 4,
  /**
   * Live mainnet carries 2.1 to 2.9 transactions per second (16 in March 2026)
   * and the DSO's own confirmations cluster at round starts: 23 transactions
   * sat between createdAt - 5 s and round 114513's StartIssuing. The budget
   * counts requests, not rows, so one page of 200 (about 5 MB) replaces many
   * small ones; paging continues until 10 s past createdAt.
   */
  locatePageSize: 200,
  locatePages: 3,
  locateLeadMs: 2_000,
  locateTrailMs: 10_000,
  repairsPerRun: 1,
  /**
   * An attempt is one repair window paged to its end (a page whose last
   * record passed it, or repairPages pages) without the round. A miss is
   * deterministic (the same window would miss again), so each miss doubles
   * the next window (repairLeadMs) instead of repeating it. A window the run
   * budget or a busy budget cuts short is no attempt: the next run pages on
   * from where it stopped (`repair_resume` on the forward cursor). A Scan
   * error is no attempt either (repairErrorBackoffMs), and neither is an
   * empty page short of the window's end, which takes the same backoff: that
   * host's ledger stops before the window does (a lagging fallback host, for
   * one), which is no proof the round is missing. Nor is a refused store
   * write, which ends the run before the cursor is written.
   */
  repairAttempts: 3,
  /**
   * A repair that fails with a Scan error (a 5xx, a timeout, a shape error,
   * an empty page short of the window's end) puts its round on a backoff
   * instead of spending an attempt: no page for it until this long has
   * passed, doubling with each error in a row up to repairErrorBackoffMaxMs,
   * while the runs repair other rounds. A short incident on /v2/updates
   * cannot use up a round's attempts; a round that keeps failing is retried
   * until the cursor passes it at the repair horizon, which abandons it like
   * any other (`repair_backoff` on the forward cursor).
   */
  repairErrorBackoffMs: 30 * 60_000,
  repairErrorBackoffMaxMs: 4 * 60 * 60_000,
  /**
   * Pages per attempt, across runs. The widest window (+/-600 s) holds about
   * 3,100 rows at the September rate (2.1 to 2.9 transactions per second),
   * 7 pages of repairPageSize: 16 leave room for twice that rate before an
   * attempt stops short of its window's end, which counts as a miss.
   */
  repairPages: 16,
  /**
   * Rows per repair page (the Scan maximum is 1000). Measured on 2026-09-25
   * by a read-only probe that asked for gzip, one sample: a 1000-row
   * /v2/updates page after 2026-09-24T06:00Z answered in 2.26 s with 2.48 MB
   * on the wire and 26.4 MB of JSON decoded, 389 s of ledger at 2.57 per
   * second. That is far inside the client's 30 s timeout, which also bounds
   * the body, but the whole body is decoded and parsed in the collector's
   * process, and one transaction has reached 4.5 MB
   * (a 100-row page of 2026-04-15 decoded to 6.3 MB): 500 rows halve the
   * worst page.
   */
  repairPageSize: 500,
  /**
   * Half of an attempt's window around the estimate, doubled by each miss:
   * +/-150 s, then +/-300 s, then +/-600 s, almost a round (616 s) either
   * side. Between two close neighbours the estimate is within seconds;
   * extrapolated from one side over up to repairAnchorRounds rounds it can
   * be off by more than 150 s, which a repeated window would never find.
   */
  repairLeadMs: 150_000,
  /** Rounds further back than this are left to finalize as round_missed (about two days). */
  repairHorizonRounds: 300,
  /**
   * `abandoned` lists at most this many rounds (`abandoned_total` counts them
   * all): after an outage of weeks the horizon passes thousands in one run,
   * and the list goes into the alarm text and the job log.
   */
  abandonedListed: 20,
  /**
   * Complete runs (runs that write the cursor) that report a given-up round
   * in `given_up`, the run that gave it up included; a round given up while
   * the latch holds starts it over. The collector alarm pages only after
   * failThreshold failing runs in a row, and the next ok run resets the
   * streak, so a loss reported by one run alone would never page. health.ts
   * clamps failThreshold to at most givenUpRuns - 1: the latch fails exactly
   * givenUpRuns runs, so at givenUpRuns itself whether a loss pages would
   * depend on how the streak is compared. About two hours: then start-issuing
   * recovers, and a later failure pages again.
   */
  givenUpRuns: 24,
  /**
   * A round is repaired only while a captured round lies at most this many
   * rounds away. Further out, the estimate drifts past even the widest repair
   * window (after an outage longer than the horizon, the only anchor can be
   * 300 rounds away), so the pages would be spent on windows that cannot hold
   * the round. A gap is repaired from whichever side has an anchor, and each
   * repair becomes the next one's anchor.
   */
  repairAnchorRounds: 6,
  /** Measured: 13,276 rounds from 2026-06-22T17:52Z to 2026-09-25T10:42Z, about 616 s each. */
  roundSpacingMs: 616_000,
  /**
   * Checked before every locate and repair page, with the lock deadline: no
   * page starts past this budget, nor when its worst case (queue wait plus
   * timeout) would end after the deadline. With 30 s spacing and up to 70 s
   * of queue wait per call, a run that starts its last call at 180 s ends
   * before the lock deadline (COLLECTOR_LOCK: 290 s less a 10 s margin); the
   * deadline check keeps that true when the lock was claimed before the run
   * started. Every call also carries the deadline, so a fallback to a second
   * host is refused as busy rather than dialled past the lock.
   */
  runBudgetMs: 180_000,
} as const;

/**
 * One run of forward collection. Each field says which outcome of the
 * collector's health feed it feeds, so a failure pages
 * on the outcome it belongs to. health.ts reads start-issuing and acs-snapshot
 * through forwardStartIssuingHealth and forwardSnapshotHealth, never from
 * fields it picks itself:
 *   rounds-poll    fails on `busy`, `errors` or `stalled` (or no `host`): the
 *                  poll or a locate met a busy budget, the run ended early,
 *                  or no due locate got an answer before the run budget or
 *                  the lock deadline. A busy budget in the repairs is
 *                  `repair_deferred`, a wait.
 *   start-issuing  forwardStartIssuingHealth: fails on `not_located`,
 *                  `locate_errors`, `repair_errors` or `given_up`. A run
 *                  with none of them that left due work unanswered
 *                  (`locate_deferred`, `repair_deferred`, `repair_waiting`,
 *                  or a run that ended early) gives no signal (skipped), like
 *                  the snapshot's waiting: a run that never tried the failing
 *                  path must not end its failure streak. A backoff, for one,
 *                  follows an error already counted, and an ok while it runs
 *                  would mean a /v2/updates path that keeps failing never pages.
 *   acs-snapshot   forwardSnapshotHealth.
 * A queue, a store or a lock that starves round collection shows as
 * `stalled` on every run while it lasts, since an issuing round stays due
 * until it is captured. No outcome detects a repair that is stuck
 * (`unanchored` or `missing` staying up while nothing is repaired): not
 * covered yet. The repair horizon is the backstop: it gives up every
 * round still missing about two days after it started, and `given_up` pages
 * that.
 */
export interface ForwardResult {
  /**
   * No outcome failed this run: start-issuing and the snapshot stage are not
   * failing (forwardStartIssuingHealth, forwardSnapshotHealth), the budget was
   * not busy for the poll or a locate, the run did not end early, and it did
   * not stall (`stalled`). A wait (a deferred locate or repair, a round on its
   * error backoff, a deferred or waiting stage) is no failure, unless every
   * due locate waited.
   */
  ok: boolean;
  host: string | null;
  migration_id: number | null;
  open_rounds: number[];
  issuing_rounds: number[];
  captured: number[];
  /** start-issuing: issuing rounds whose locate window ended without their StartIssuing. */
  not_located: number[];
  /**
   * start-issuing: locates that failed with a Scan error other than a busy
   * budget (a 5xx, a timeout, a shape error). The next run locates them again.
   */
  locate_errors: string[];
  /**
   * start-issuing, no signal: issuing rounds still without a capture whose
   * locate did not run to its end this run (capturesPerRun, the run budget or
   * the lock deadline stopped it). A wait the next run picks up, unless no
   * due locate got an answer at all: that run is `stalled`.
   */
  locate_deferred: number[];
  repaired: number[];
  /** No signal alone: rounds between the cursor and the issuing rounds still without a capture, given up or not. */
  missing: number[];
  /**
   * start-issuing: repairs that failed with a Scan error other than a busy
   * budget, an empty page short of the window's end included. Each puts its
   * round on a backoff (repairErrorBackoffMs), not an attempt.
   */
  repair_errors: string[];
  /** start-issuing, no signal: missing rounds on an error backoff after this run. */
  repair_waiting: number;
  /**
   * start-issuing, no signal: the missing round whose repair was due this run
   * but got no answer, and why: the run budget or the lock deadline left no
   * time for its first page, or the shared budget was busy (a closed gate, a
   * long queue). No attempt is counted, its backoff stays as it was, a window
   * that has spent a page is kept for the next run (`repair_resume`), and the
   * cursor is still written. Null when no due repair was left unanswered.
   */
  repair_deferred: string | null;
  /**
   * No signal alone: missing rounds with attempts left but no captured round
   * within COLLECTOR_LIMITS.repairAnchorRounds, so no repair window can be
   * placed. Normal while a long gap is repaired inward from its edges; a
   * count that stays up while nothing is repaired means the repair is stuck
   * until the horizon gives those rounds up.
   */
  unanchored: number;
  /**
   * Rounds given up for good this run, each listed once, lowest first, at
   * most COLLECTOR_LIMITS.abandonedListed of them: its repair attempts ran
   * out, or the cursor fell behind the repair horizon and passed it
   * uncaptured. Finalize publishes them as round_missed. Reported only by a
   * run that wrote the cursor, which is what keeps them given up. They are
   * the event; `given_up` is the signal that holds them.
   */
  abandoned: number[];
  /** Every round given up this run, listed in `abandoned` or not. */
  abandoned_total: number;
  /**
   * start-issuing: the given-up latch, held on the forward cursor. It takes
   * in every round given up (this run's `abandoned` included) and stays set
   * on COLLECTOR_LIMITS.givenUpRuns complete runs in a row, so one loss fails
   * start-issuing long enough to page. Null when no round was given up that
   * recently. A run that ended early reports none and leaves it as it was.
   */
  given_up: GivenUpLatch | null;
  cursor: number | null;
  /**
   * The daily snapshot stage as this run left it:
   *   null        not reached (the run failed before it; `busy` or `errors`
   *               say why), or the stage threw (`snapshot_error` says why);
   *   "deferred"  not run to an answer: the shared budget was busy, or the
   *               lock deadline was too close for the stage's next call (the
   *               stage refuses that as busy before dialling). A wait the next
   *               run picks up, never a failure; a day still without a row at
   *               04:00 UTC comes back from the stage as starved instead.
   *   a result    the stage's own answer, counted by snapshotStageHealth.
   */
  snapshot: SnapshotStageResult | "deferred" | null;
  snapshot_deferred: string | null;
  snapshot_error: string | null;
  /**
   * rounds-poll: the shared budget was busy (a closed gate, a long queue, the
   * lock deadline) for the poll or a locate, and the run ended there: no
   * cursor written. A busy repair is `repair_deferred`, a busy snapshot stage
   * `snapshot: "deferred"`: both waits, and the run goes on.
   */
  busy: string | null;
  /**
   * rounds-poll: why the run did none of its round collection, or null.
   * Issuing rounds were due and none got an answer (captured, not located or
   * failed): the run budget or the lock deadline stopped every locate
   * (`locate_deferred`), because a slow store, a starved queue or a lock
   * claimed late spent the run before them. The live client would have
   * refused those pages as busy (queue); the collector stops first so the run
   * still writes its cursor. Each deferral alone is a wait, but a run that
   * did no round collection is not ok. start-issuing still gives no signal:
   * its failing path never ran.
   */
  stalled: string | null;
  /**
   * rounds-poll: the error that ended the run early: the poll of the open and
   * issuing rounds failed, or the store refused a read or a write (a found
   * round's capture included, so it is found again next run instead of lost).
   * Nothing after it ran: no cursor write, and no snapshot stage unless it
   * had already run. A failed locate is in `locate_errors`, a failed repair in
   * `repair_errors`, an error thrown by the snapshot stage in `snapshot_error`.
   */
  errors: string[];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * How the snapshot stage counts in a run: failing when the stage says so
 * (snapshotStageHealth: failed, gave_up, starved) or threw; neutral when it
 * was deferred, not reached, waiting out a backoff or done with a day whose
 * core row is stored but whose license count gave up (licenses_gave_up),
 * which neither starts nor ends a failure streak; healthy otherwise.
 */
export function forwardSnapshotHealth(r: Pick<ForwardResult, "snapshot" | "snapshot_error">): SnapshotHealth {
  if (r.snapshot_error != null) return "failing";
  if (r.snapshot == null || r.snapshot === "deferred") return "neutral";
  return snapshotStageHealth(r.snapshot);
}

/** The given-up latch (ForwardResult.given_up), stored as the forward cursor's detail.given_up. */
export interface GivenUpLatch {
  /** Rounds given up since the latch was last empty. */
  total: number;
  /** The lowest and the highest of them. */
  first: number;
  last: number;
  /** Complete runs after this one that still report it. */
  runs_left: number;
}

function readGivenUp(value: unknown): GivenUpLatch | null {
  if (value == null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.total !== "number" || typeof v.first !== "number" || typeof v.last !== "number") return null;
  if (typeof v.runs_left !== "number" || v.runs_left < 1) return null;
  return { total: v.total, first: v.first, last: v.last, runs_left: v.runs_left };
}

/** The start-issuing outcome of one run, for the collector's health feed. */
export interface StartIssuingHealth {
  /** healthy is an ok outcome, failing a failed one, neutral a skipped one (no signal: the streak is kept). */
  health: SnapshotHealth;
  /** The first failing field and what it holds, for the alert line; null unless failing. */
  detail: string | null;
}

const firstOf = (items: string[]) => (items.length > 1 ? `${items[0]} (and ${items.length - 1} more)` : items[0]);

/**
 * How a run counts on start-issuing (see ForwardResult): failing on the first
 * of `not_located`, `locate_errors`, `repair_errors` and `given_up` that holds
 * anything, which the detail names; else neutral when the run left due work
 * unanswered (a deferred locate or repair, a round on its error backoff, or a
 * run that ended early or stalled, which rounds-poll counts); else healthy.
 */
export function forwardStartIssuingHealth(
  r: Pick<
    ForwardResult,
    | "not_located" | "locate_errors" | "locate_deferred" | "repair_errors" | "repair_waiting" | "repair_deferred"
    | "given_up" | "busy" | "errors"
  >,
): StartIssuingHealth {
  const failing = (detail: string): StartIssuingHealth => ({ health: "failing", detail });
  if (r.not_located.length > 0) return failing(`not_located: ${r.not_located.join(", ")}`);
  if (r.locate_errors.length > 0) return failing(`locate_errors: ${firstOf(r.locate_errors)}`);
  if (r.repair_errors.length > 0) return failing(`repair_errors: ${firstOf(r.repair_errors)}`);
  if (r.given_up != null) {
    const g = r.given_up;
    return failing(`given_up: ${g.total === 1 ? `round ${g.first}` : `${g.total} rounds from ${g.first} to ${g.last}`}`);
  }
  const unanswered =
    r.locate_deferred.length > 0 || r.repair_deferred != null || r.repair_waiting > 0 || r.busy != null || r.errors.length > 0;
  return { health: unanswered ? "neutral" : "healthy", detail: null };
}

/**
 * A StartIssuing found on /v2/updates, with the host of the page that held
 * it. Pages of one locate or repair window can come from different hosts
 * (scanRequest falls back along SCAN_RECORD_HOSTS, and a repair window can
 * page on across runs), and neither needs to be the host that answered the
 * poll: the capture names the host that served its StartIssuing, because
 * every stored value keeps the host it came from.
 */
export interface Found {
  capture: StartIssuingCapture;
  host: string;
}

/**
 * The stored row of a located StartIssuing: its seven categories at 20
 * places, its summary and rates, and the issuance config and tick of the
 * round's own open-round meta, else of the nearest open round (`open`), in
 * which case the split says the config was inferred. The verify CLI builds
 * its rows through it too, so a re-derived day is the day the collector stores.
 */
export function captureWrite(
  { capture: c, host }: Found,
  known: RoundRow | undefined,
  open: OpenRoundMeta[],
  repaired: boolean,
): RoundCaptureWrite {
  const cats = categoryAmounts(c);
  // An IssuingMiningRound carries no config. The round's own open-round meta
  // was stored while it was open; if the collector was not running then, the
  // nearest open round's config is used and the row says so.
  const fallback = open[0];
  const config = known?.issuance_config ?? fallback?.issuanceConfig ?? null;
  const tick = known?.tick_duration_us ?? (fallback?.tickDurationUs != null ? Number(fallback.tickDurationUs) : null);
  return {
    round: c.round,
    start_issuing_at: c.recordTime,
    tick_duration_us: tick,
    issuance_config: config,
    app_rewards_cc: format(cats.app_rewards_cc, 20),
    validator_rewards_cc: format(cats.validator_rewards_cc, 20),
    sv_rewards_cc: format(cats.sv_rewards_cc, 20),
    dev_fund_cc: format(cats.dev_fund_cc, 20),
    faucet_rewards_cc: format(cats.faucet_rewards_cc, 20),
    unfeatured_app_rewards_cc: format(cats.unfeatured_app_rewards_cc, 20),
    unclaimed_rewards_cc: format(cats.unclaimed_rewards_cc, 20),
    split: { summary: c.summary, rates: c.rates, config_inferred: known?.issuance_config == null },
    issuing_contract_id: c.issuingContractId,
    update_id: c.updateId,
    migration_id: c.migrationId,
    source_host: host,
    method: METHOD_SCAN,
    repaired,
  };
}

/**
 * StartIssuing time of `round`, interpolated from the nearest captured rounds
 *. Null when no captured round lies within
 * COLLECTOR_LIMITS.repairAnchorRounds of it: no estimate a repair window can trust.
 */
export function estimateStartMs(round: number, known: Map<number, Pick<RoundRow, "start_issuing_at">>): number | null {
  let lo: [number, number] | null = null;
  let hi: [number, number] | null = null;
  for (const [n, row] of known) {
    if (!row.start_issuing_at) continue;
    const t = Date.parse(row.start_issuing_at);
    if (n < round && (!lo || n > lo[0])) lo = [n, t];
    if (n > round && (!hi || n < hi[0])) hi = [n, t];
  }
  const nearest = Math.min(lo ? round - lo[0] : Infinity, hi ? hi[0] - round : Infinity);
  if (nearest > COLLECTOR_LIMITS.repairAnchorRounds) return null;
  if (lo && hi) return lo[1] + ((round - lo[0]) / (hi[0] - lo[0])) * (hi[1] - lo[1]);
  if (lo) return lo[1] + (round - lo[0]) * COLLECTOR_LIMITS.roundSpacingMs;
  if (hi) return hi[1] - (hi[0] - round) * COLLECTOR_LIMITS.roundSpacingMs;
  return null;
}

/**
 * The StartIssuing of `ref`, paged from just before the IssuingMiningRound's
 * creation, with the host of the page that held it (Found). "cut" when the
 * run budget or the lock deadline stopped it before its window ended: a wait,
 * not a round it cannot find.
 */
async function locateRound(
  scan: ScanApi,
  migrationId: number,
  ref: IssuingRoundRef,
  overBudget: () => boolean,
  deadline: number,
): Promise<Found | null | "cut"> {
  const createdMs = Date.parse(ref.createdAt);
  let after = new Date(createdMs - COLLECTOR_LIMITS.locateLeadMs).toISOString();
  for (let page = 0; page < COLLECTOR_LIMITS.locatePages; page++) {
    if (page > 0 && overBudget()) return "cut";
    const res = await scan.updatesAfter(migrationId, after, COLLECTOR_LIMITS.locatePageSize, deadline);
    const capture = findStartIssuing(res.transactions, { contractId: ref.contractId });
    if (capture) return { capture, host: res.host };
    const last = res.transactions[res.transactions.length - 1];
    if (!last || Date.parse(last.record_time) > createdMs + COLLECTOR_LIMITS.locateTrailMs) return null;
    after = last.record_time;
  }
  return null;
}

/**
 * A repair window: the round, where paging stands (`after`), where the window
 * ends and the pages this attempt has spent. A window the run budget cuts
 * short is kept on the forward cursor (detail.repair_resume) and the next run
 * pages on from `after`, so a window that needs more pages than one run can
 * give still ends, and the cut is no attempt. A Scan error drops the window:
 * the try after the backoff starts it over from the estimate, so the one
 * stored window never belongs to a round that is waiting.
 */
interface RepairWindow {
  round: number;
  after: string;
  stop_at: string;
  pages: number;
}

function readRepairWindow(value: unknown): RepairWindow | null {
  if (value == null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.round !== "number" || typeof v.after !== "string" || typeof v.stop_at !== "string") return null;
  if (typeof v.pages !== "number") return null;
  return { round: v.round, after: v.after, stop_at: v.stop_at, pages: v.pages };
}

/** A round whose repair failed with a Scan error `errors` times in a row, not paged again before `next_try_at`. */
interface RepairBackoff {
  errors: number;
  next_try_at: string;
}

function readRepairBackoff(value: unknown): Record<string, RepairBackoff> {
  const out: Record<string, RepairBackoff> = {};
  if (value == null || typeof value !== "object") return out;
  for (const [round, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry == null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.errors === "number" && typeof e.next_try_at === "string") {
      out[round] = { errors: e.errors, next_try_at: e.next_try_at };
    }
  }
  return out;
}

type RepairOutcome =
  | ({ kind: "found" } & Found)
  | { kind: "not_found" }
  | { kind: "cut"; window: RepairWindow }
  | { kind: "busy"; reason: ScanBusyError["reason"]; window: RepairWindow };

/**
 * Pages a repair window. A busy budget is returned with the window as it
 * stands; any other Scan error is thrown. A miss (not_found) is a page whose
 * last record passed the window's end, or repairPages pages spent. An empty
 * page short of the window's end is thrown as a Scan error instead: that
 * host's ledger stops before the window does (a lagging fallback host, for
 * one), which says nothing about the round.
 */
async function repairRound(
  scan: ScanApi,
  migrationId: number,
  window: RepairWindow,
  overBudget: () => boolean,
  deadline: number,
): Promise<RepairOutcome> {
  const stopAt = Date.parse(window.stop_at);
  let { after, pages } = window;
  while (pages < COLLECTOR_LIMITS.repairPages) {
    // The caller checked the budget before this run's first page of the window.
    if (pages > window.pages && overBudget()) return { kind: "cut", window: { ...window, after, pages } };
    let res: { host: string; transactions: ScanTransaction[] };
    try {
      res = await scan.updatesAfter(migrationId, after, COLLECTOR_LIMITS.repairPageSize, deadline);
    } catch (err) {
      if (err instanceof ScanBusyError) return { kind: "busy", reason: err.reason, window: { ...window, after, pages } };
      throw err;
    }
    pages++;
    const hit = findStartIssuing(res.transactions, { round: window.round });
    if (hit) return { kind: "found", capture: hit, host: res.host };
    const last = res.transactions[res.transactions.length - 1];
    if (!last) {
      // Paged up to the window's end: a miss. Short of it: no proof the round is missing.
      if (Date.parse(after) >= stopAt) return { kind: "not_found" };
      throw new Error(`Scan ${res.host} has no update after ${after}, short of the repair window's end at ${window.stop_at}`);
    }
    if (Date.parse(last.record_time) > stopAt) return { kind: "not_found" };
    after = last.record_time;
  }
  return { kind: "not_found" };
}

/** The store's getRounds row cap: a longer span is read in parts. */
const ROUNDS_PER_READ = 1_000;

/** Rounds in [from, to] with no StartIssuing captured. */
async function uncapturedIn(store: RecordStore, from: number, to: number): Promise<number[]> {
  const out: number[] = [];
  for (let lo = from; lo <= to; lo += ROUNDS_PER_READ) {
    const hi = Math.min(to, lo + ROUNDS_PER_READ - 1);
    const captured = new Set((await store.getRounds(lo, hi)).filter((r) => r.update_id).map((r) => r.round));
    for (let r = lo; r <= hi; r++) if (!captured.has(r)) out.push(r);
  }
  return out;
}

/**
 * The daily snapshot stage, after the locates and before the repairs, with
 * the run's deadline so none of its calls runs past the lock. It goes before
 * the repairs because its first call needs most of the lock
 * (snapshotCoreHeadroomMs) and a day without it starves from 04:00 UTC, while
 * a repair can wait a run inside its two-day horizon; a stage with nothing to
 * read (not due, already stored, waiting) spends no call and leaves the run's
 * budget to the repairs. It always runs: the
 * stage itself refuses as busy, before its first call, a core read the
 * deadline cannot cover (snapshotCoreHeadroomMs), and from 04:00 UTC returns
 * a day that still has no row as starved rather than busy, so runs whose
 * round collection keeps using the lock time page instead of deferring
 * unseen. A busy budget or an error here says nothing about round
 * collection, so it never lands in `busy` or `errors`. The stage keeps its
 * attempts on its own row (CURSOR_SNAPSHOT); nothing here writes it.
 */
async function snapshotStage(
  result: ForwardResult,
  deps: { store: RecordStore; scan: ScanApi; migrationId: number; now: Date; deadline: number; clock: () => number },
): Promise<void> {
  try {
    result.snapshot = await runSnapshotStage({
      store: deps.store, scan: deps.scan, migrationId: deps.migrationId, now: deps.now, deadline: deps.deadline,
    });
  } catch (err) {
    if (err instanceof ScanBusyError) {
      const left = Math.max(0, Math.round((deps.deadline - deps.clock()) / 1000));
      result.snapshot = "deferred";
      result.snapshot_deferred = `budget busy (${err.reason}), ${left} s left before the lock deadline`;
    } else {
      result.snapshot_error = messageOf(err);
    }
  }
}

/**
 * `deadline` (epoch ms) is the time by which every Scan call of the run must
 * have ended: the caller passes its lock expiry less COLLECTOR_LOCK.marginMs.
 * Round collection starts no page whose worst case would pass it, every call
 * carries it, and the snapshot stage gets it too.
 */
export async function runForwardCollection(deps: {
  store: RecordStore;
  scan: ScanApi;
  now: Date;
  deadline: number;
  clock?: () => number;
}): Promise<ForwardResult> {
  const { store, scan, now, deadline } = deps;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const worstCallMs = scanCallWorstCaseMs("record");
  const overBudget = () => clock() - started > COLLECTOR_LIMITS.runBudgetMs || clock() + worstCallMs > deadline;
  const result: ForwardResult = {
    ok: false, host: null, migration_id: null, open_rounds: [], issuing_rounds: [], captured: [],
    not_located: [], locate_errors: [], locate_deferred: [], repaired: [], missing: [], repair_errors: [],
    repair_waiting: 0, repair_deferred: null, unanchored: 0, abandoned: [], abandoned_total: 0, given_up: null, cursor: null,
    snapshot: null, snapshot_deferred: null, snapshot_error: null, busy: null, stalled: null, errors: [],
  };

  try {
    const migrationId = await scan.migrationId(deadline);
    result.migration_id = migrationId;
    const { host, rounds } = await scan.openAndIssuing(deadline);
    result.host = host;
    result.open_rounds = rounds.open.map((r) => r.round);
    result.issuing_rounds = rounds.issuing.map((r) => r.round);
    if (rounds.open.length === 0 && rounds.issuing.length === 0) throw new Error("open-and-issuing returned no rounds");

    await store.upsertRoundMeta(
      rounds.open.map((m) => ({
        round: m.round,
        opens_at: m.opensAt,
        tick_duration_us: m.tickDurationUs != null ? Number(m.tickDurationUs) : null,
        issuance_config: m.issuanceConfig,
        amulet_price: m.amuletPrice,
        source_host: host,
        method: METHOD_SCAN,
      })),
    );

    const cursor = await store.getCursor(CURSOR_FORWARD);
    // The newest round known to have started issuing. With none issuing, the
    // round below the oldest open one may still be summarizing:
    // AdvanceOpenMiningRounds turns the oldest open round into a
    // SummarizingMiningRound, which issues only from its StartIssuing, and
    // open-and-issuing lists no summarizing round. Taken as started, it would
    // be missing before it happened, and three repair windows placed ahead of
    // it would give it up while a locate still captures it once it issues.
    const newestStarted = rounds.issuing.length > 0
      ? rounds.issuing[rounds.issuing.length - 1].round
      : rounds.open[0].round - 2;
    const oldestIssuing = rounds.issuing.length > 0 ? rounds.issuing[0].round : newestStarted + 1;
    const horizon = newestStarted - COLLECTOR_LIMITS.repairHorizonRounds;
    const from = cursor?.last_round != null ? Math.max(cursor.last_round + 1, horizon) : oldestIssuing;
    // One round below the window, so a repair always has its lower anchor.
    const known = new Map<number, RoundRow>(
      (await store.getRounds(Math.max(0, Math.min(from, oldestIssuing) - 1), newestStarted)).map((r) => [r.round, r]),
    );

    const remember = (w: RoundCaptureWrite) =>
      known.set(w.round, { ...(known.get(w.round) ?? blankRound(w.round, host)), ...w });

    for (const ref of rounds.issuing) {
      if (known.get(ref.round)?.update_id) continue;
      // Once the cap or the budget stops the locates, every round left is a wait (a cut locate spent the budget).
      if (result.captured.length >= COLLECTOR_LIMITS.capturesPerRun || overBudget()) {
        result.locate_deferred.push(ref.round);
        continue;
      }
      let located: Found | null | "cut";
      try {
        located = await locateRound(scan, migrationId, ref, overBudget, deadline);
      } catch (err) {
        // A timeout, a 5xx or a shape error: a Scan failure, not a round it
        // cannot find. The next run locates it again; the run goes on. A busy
        // budget ends the run.
        if (err instanceof ScanBusyError) throw err;
        result.locate_errors.push(`locate round ${ref.round}: ${messageOf(err)}`);
        continue;
      }
      // Cut by the run budget or the lock deadline: a wait, not a round it cannot find. The next run pages again.
      if (located === "cut") {
        result.locate_deferred.push(ref.round);
        continue;
      }
      if (located === null) {
        result.not_located.push(ref.round);
        continue;
      }
      // A refused write ends the run (`errors`): the round was found, and the next run finds it again.
      const write = captureWrite(located, known.get(ref.round), rounds.open, false);
      await store.upsertRoundCaptures([write]);
      remember(write);
      result.captured.push(ref.round);
    }
    // Every due locate deferred and none answered: the run budget or the lock
    // deadline was spent before the run's round collection (ForwardResult.stalled).
    const answered = result.captured.length + result.not_located.length + result.locate_errors.length;
    if (result.locate_deferred.length > 0 && answered === 0) {
      const elapsed = Math.round((clock() - started) / 1000);
      const left = Math.max(0, Math.round((deadline - clock()) / 1000));
      result.stalled =
        `no due locate got an answer (${result.locate_deferred.join(", ")}): ` +
        `${elapsed} s into the run, ${left} s before the lock deadline`;
    }

    await snapshotStage(result, { store, scan, migrationId, now, deadline, clock });

    const attempts = { ...((cursor?.detail?.repair_attempts as Record<string, number> | undefined) ?? {}) };
    const backoff = readRepairBackoff(cursor?.detail?.repair_backoff);
    const waiting = (r: number) => {
      const b = backoff[String(r)];
      return b != null && now.getTime() < Date.parse(b.next_try_at);
    };
    /** Every round given up this run; reported once the cursor that keeps them given up is written. */
    const abandoned: number[] = [];
    const missing: number[] = [];
    for (let r = from; r < oldestIssuing; r++) if (!known.get(r)?.update_id) missing.push(r);
    // A window an earlier run cut short goes first, so it pages on until it
    // ends, and is kept until then even by a run with no time to page it.
    const stored = readRepairWindow(cursor?.detail?.repair_resume);
    const resume = stored != null && missing.includes(stored.round) ? stored : null;
    let nextWindow: RepairWindow | null = resume;
    const order = resume != null ? [resume.round, ...missing.filter((r) => r !== resume.round)] : missing;
    let repairsLeft: number = COLLECTOR_LIMITS.repairsPerRun;
    for (const r of order) {
      if (repairsLeft === 0) break;
      const key = String(r);
      if ((attempts[key] ?? 0) >= COLLECTOR_LIMITS.repairAttempts) continue;
      // On an error backoff: the next missing round gets this run's repair.
      if (waiting(r)) continue;
      let window: RepairWindow;
      if (resume?.round === r) {
        window = resume;
      } else {
        const estimate = estimateStartMs(r, known);
        if (estimate == null) continue;
        // Each miss doubles the window, so no attempt pages what an earlier one missed in the same place.
        const leadMs = COLLECTOR_LIMITS.repairLeadMs * 2 ** (attempts[key] ?? 0);
        window = {
          round: r,
          after: new Date(estimate - leadMs).toISOString(),
          stop_at: new Date(estimate + leadMs).toISOString(),
          pages: 0,
        };
      }
      // Due, but no page fits the run: a wait, and the run says which round
      // waits. A stored window stays stored (nextWindow still holds it).
      if (overBudget()) {
        result.repair_deferred = `repair round ${r}: no page fits the run budget or the lock deadline`;
        break;
      }
      repairsLeft--;
      if (nextWindow?.round === r) nextWindow = null;
      let outcome: RepairOutcome;
      try {
        outcome = await repairRound(scan, migrationId, window, overBudget, deadline);
      } catch (err) {
        // A Scan error (a busy budget comes back as an outcome) is no attempt:
        // the round waits out a backoff, so a short incident cannot use up its
        // attempts, and the runs repair other rounds meanwhile. Its window is
        // dropped (see RepairWindow).
        const errors = (backoff[key]?.errors ?? 0) + 1;
        const delayMs = Math.min(
          COLLECTOR_LIMITS.repairErrorBackoffMs * 2 ** (errors - 1),
          COLLECTOR_LIMITS.repairErrorBackoffMaxMs,
        );
        const nextTryAt = new Date(now.getTime() + delayMs).toISOString();
        backoff[key] = { errors, next_try_at: nextTryAt };
        result.repair_errors.push(`repair round ${r}: ${messageOf(err)} (error ${errors} in a row; next try at ${nextTryAt})`);
        continue;
      }
      if (outcome.kind === "busy") {
        // A wait, not a failure of the poll: no attempt, the backoff as it
        // was, no more repairs this run, and the cursor is still written. A
        // window that has spent a page is kept, so the next run pages on.
        result.repair_deferred = `repair round ${r}: budget busy (${outcome.reason})`;
        if (outcome.window.pages > 0) nextWindow = outcome.window;
        break;
      }
      if (outcome.kind === "cut") {
        nextWindow = outcome.window;
        continue;
      }
      // Scan answered: whatever it said, the error streak is over.
      delete backoff[key];
      if (outcome.kind === "found") {
        const write = captureWrite(outcome, known.get(r), rounds.open, true);
        // A refused write ends the run (`errors`) before the cursor is
        // written, so it costs no attempt and the next run repairs it again.
        await store.upsertRoundCaptures([write]);
        remember(write);
        result.repaired.push(r);
        delete attempts[key];
        continue;
      }
      // The whole window paged without the round: an attempt, and the next one pages a window twice as wide.
      attempts[key] = (attempts[key] ?? 0) + 1;
      if (attempts[key] >= COLLECTOR_LIMITS.repairAttempts) abandoned.push(r);
    }
    result.missing = missing.filter((r) => !result.repaired.includes(r));
    result.repair_waiting = result.missing.filter(waiting).length;
    result.unanchored = result.missing.filter(
      (r) => (attempts[String(r)] ?? 0) < COLLECTOR_LIMITS.repairAttempts && estimateStartMs(r, known) == null,
    ).length;

    // The cursor is the highest round below which everything is captured, or
    // has fallen behind the repair horizon and is left to finalize.
    let last = cursor?.last_round ?? oldestIssuing - 1;
    if (last < horizon - 1) {
      // Every round the cursor passes uncaptured is given up here, once;
      // a round whose attempts ran out was reported on the run they did.
      for (const r of await uncapturedIn(store, last + 1, horizon - 1)) {
        if ((attempts[String(r)] ?? 0) < COLLECTOR_LIMITS.repairAttempts) abandoned.push(r);
      }
      last = horizon - 1;
    }
    while (known.get(last + 1)?.update_id) last++;
    for (const k of Object.keys(attempts)) if (Number(k) <= last) delete attempts[k];
    for (const k of Object.keys(backoff)) if (Number(k) <= last) delete backoff[k];
    result.cursor = last;
    abandoned.sort((a, b) => a - b);
    // The given-up latch: each complete run counts it down, and a round given
    // up now starts it over, so one loss fails start-issuing on givenUpRuns
    // runs in a row. A run that ends early writes no cursor and leaves it as it was.
    const held = readGivenUp(cursor?.detail?.given_up);
    let givenUp: GivenUpLatch | null = held != null ? { ...held, runs_left: held.runs_left - 1 } : null;
    if (abandoned.length > 0) {
      const lowest = abandoned[0];
      const highest = abandoned[abandoned.length - 1];
      givenUp = {
        total: (givenUp?.total ?? 0) + abandoned.length,
        first: Math.min(givenUp?.first ?? lowest, lowest),
        last: Math.max(givenUp?.last ?? highest, highest),
        runs_left: COLLECTOR_LIMITS.givenUpRuns - 1,
      };
    }
    const startedAt = (cursor?.detail?.started_at as string | undefined) ?? now.toISOString();
    // Only the forward row's own keys: the snapshot stage keeps its attempts on CURSOR_SNAPSHOT.
    await store.setCursor({
      id: CURSOR_FORWARD,
      last_round: last,
      last_date: cursor?.last_date ?? null,
      last_poll_at: now.toISOString(),
      detail: {
        started_at: startedAt,
        repair_attempts: attempts,
        ...(nextWindow != null ? { repair_resume: nextWindow } : {}),
        ...(Object.keys(backoff).length > 0 ? { repair_backoff: backoff } : {}),
        ...(givenUp != null && givenUp.runs_left > 0 ? { given_up: givenUp } : {}),
      },
    });
    result.abandoned = abandoned.slice(0, COLLECTOR_LIMITS.abandonedListed);
    result.abandoned_total = abandoned.length;
    result.given_up = givenUp;

    // Not ok exactly when an outcome fails: rounds-poll (a stalled run),
    // start-issuing (a round not located, a failed locate or repair, a round
    // on the given-up latch) or the snapshot stage (failed, gave_up, starved,
    // or thrown). A wait (a deferred locate or repair, a round on its error
    // backoff, a waiting or deferred stage, a day whose license count alone
    // gave up) counts neither way, unless every due locate waited.
    result.ok =
      result.stalled == null &&
      forwardStartIssuingHealth(result).health !== "failing" &&
      forwardSnapshotHealth(result) !== "failing";
  } catch (err) {
    if (err instanceof ScanBusyError) result.busy = err.reason;
    else result.errors.push(messageOf(err));
    result.ok = false;
  }
  return result;
}
