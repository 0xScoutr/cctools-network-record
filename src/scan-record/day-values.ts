/**
 * One day of the open record, computed from raw inputs.
 * Pure: finalize.ts loads the inputs and decides provisional or final.
 *
 * Every series comes back with a value or a gap reason, never neither, and a
 * failing sanity gate is a `hold`: the value is kept provisional and alerted,
 * never published as a confident number.
 */

import {
  COUPON_SERIES,
  ISSUANCE_CATEGORIES,
  METHOD_ROUND_TOTALS,
  METHOD_SCAN,
  SERIES_NAMES,
  SUPPLY_FIRST_DATE,
  addDays,
  endOfDay,
  type GapStatus,
  type IssuanceCategory,
  type ReasonCode,
  type RecordMethod,
  type SeriesName,
  SOURCE_HOST_SEPARATOR,
} from "../open-record/contract";
import { ROUND_TOTALS_SERIES, type RoundTotalsVerification } from "./config";
import { add, dec, format, type Dec } from "./decimal";
import { checkRoundIssuance, couponTotals, type IssuanceConfig } from "./rounds";
import type { RoundRow, SnapshotRow } from "./store";

export const GATES = { minRounds: 120, maxRounds: 160, maxCountChange: 0.2 } as const;

export interface GapSpec {
  reason_code: ReasonCode;
  reason: string;
  status: GapStatus;
  /** Can still resolve before the settle deadline, so the null stays provisional until then. */
  transient: boolean;
}

/**
 * A non-null value always carries its source host and as_of: the table
 * refuses one without them (network_record_values_provenance, CHECK value is
 * null or both present). Only a null (a gap's row) names neither.
 */
export interface ComputedSeries {
  value: string | null;
  method: RecordMethod;
  source_host: string | null;
  as_of: string | null;
  hold: string | null;
  gap: GapSpec | null;
}

export interface RoundRange {
  first: number;
  last: number;
  source: "snapshot" | "forward";
}

export interface DayInputs {
  date: string;
  range: RoundRange | null;
  /** The stored rows of rounds range.first to range.last, and no others. */
  roundsInRange: RoundRow[];
  startedInDay: RoundRow[];
  /**
   * The stored rows of rounds range.first - 1 and range.last + 1, each null
   * when not stored: finalize reads them with the range and passes them here,
   * never inside roundsInRange. A forward range is the lowest and highest round
   * captured in the day, so a round never captured at either edge falls outside
   * it unseen and the day would publish short. Each edge of a forward range is
   * confirmed only by its neighbour's captured StartIssuing outside the day on
   * that side, or, before the first round, by the previous day's last_round
   * being first - 1; otherwise the round series are a gap naming the neighbour
   * (unconfirmedEdges). Not read on a snapshot range.
   */
  neighbours: { before: RoundRow | null; after: RoundRow | null };
  snapshot: SnapshotRow | null;
  prevSnapshot: SnapshotRow | null;
  /** The previous day's stored values, numeric text as the store returns it. */
  prevValues: Partial<Record<SeriesName, string | null>>;
  supply: { value: string; source_host: string } | null;
  prevSupply: { value: string; source_host: string } | null;
  /** First full UTC day of forward collection, or null if it never ran. */
  collectorStartDate: string | null;
  /**
   * Per series, whether its round-totals figure means the StartIssuing split
   * (config.ts ROUND_TOTALS_SERIES_VERIFIED). Only a verified series is
   * published from scan-rt-1 rows; an unverified one is what the day is
   * without the archive.
   */
  roundTotalsVerified: RoundTotalsVerification;
  /**
   * The snapshot stage gave up on this day's ValidatorLicense count while its
   * core row is stored (snapshot.ts, state licenses_gave_up). finalize.ts reads
   * it from CURSOR_SNAPSHOT while the stage still holds the day, and from the
   * day's open gap (licensesGaveUpReason) once published.
   */
  licensesGaveUp: boolean;
  /**
   * The day the collector's snapshot stage works on when these inputs are
   * loaded: snapshotStageDate(now) from snapshot.ts, the rule runSnapshotStage
   * itself uses (yesterday in UTC). Every loader of these inputs (finalize,
   * and the backfill if it computes days) passes it. Only that stage reads
   * ValidatorLicense: the snapshot backfill stores rows without the count
   * (its license completion pass reads it later, from the row's own host). So
   * once the stage has moved past a day, a count missing from it is not read
   * again by the daily stage, whoever stored the row, and it is published
   * with licensesNotReadReason (backfill_planned), not as pending.
   */
  snapshotStageDate: string;
}

const ZERO = BigInt(0);
/** Every series summed over the day's rounds: the issuance split, its total and the coupon totals it is priced on. */
const FLOW_SERIES: SeriesName[] = [...ISSUANCE_CATEGORIES, "issuance_cc", ...COUPON_SERIES];

/**
 * Day D's rounds. The ACS reading is used when both boundary
 * snapshots exist: last_round(D) is the highest IssuingMiningRound at D+1
 * 00:00Z and first_round(D) = last_round(D-1) + 1. Otherwise the forward
 * collector's StartIssuing record times give the range, whose edges
 * computeDay confirms with the neighbouring rounds (DayInputs.neighbours).
 */
export function resolveRange(snapshot: SnapshotRow | null, prev: SnapshotRow | null, started: RoundRow[]): RoundRange | null {
  if (snapshot?.last_round != null && prev?.last_round != null) {
    return { first: prev.last_round + 1, last: snapshot.last_round, source: "snapshot" };
  }
  if (started.length === 0) return null;
  const numbers = started.map((r) => r.round);
  return { first: Math.min(...numbers), last: Math.max(...numbers), source: "forward" };
}

/**
 * The published reason of a license count the snapshot stage gave up on. It
 * names no time of day and no attempt count, so every recomputation gives the
 * same text, and finalize finds it again after CURSOR_SNAPSHOT has moved on to
 * a later day. The daily stage does not read that count again, so the gap is
 * backfill_planned, not transient.
 */
export function licensesGaveUpReason(date: string): string {
  return (
    `The ValidatorLicense count of the ACS snapshot at ${endOfDay(date)} could not be read and was given up; ` +
    "the snapshot's other series are stored, and the license history backfill (phase C) is planned"
  );
}

/**
 * The published reason of a license count nothing will read any more: the
 * snapshot stage moved past the day without it (DayInputs.snapshotStageDate).
 * True whoever stored the row, the backfill included, and whether or not the
 * row is stored yet, so it is stable from the day the stage moves on.
 */
export function licensesNotReadReason(date: string): string {
  return (
    `The ValidatorLicense count of the ACS snapshot at ${endOfDay(date)} was not read while the daily snapshot stage ` +
    "covered this day, and the snapshot backfill does not read it; the license history backfill (phase C) is planned"
  );
}

/**
 * Every host a value was read from, sorted, comma separated. Hosts fail over
 * (scan-client.ts), so the rounds of one day can come from two of them, and a
 * value credited to only one would say something false.
 */
function hostsOf(hosts: readonly string[]): string {
  return [...new Set(hosts)].sort().join(SOURCE_HOST_SEPARATOR);
}

/** The only way a series gets a value: the host and the instant are required, never a null fallback. */
function value(v: string, host: string, method: RecordMethod, asOf: string): ComputedSeries {
  return { value: v, method, source_host: host, as_of: asOf, hold: null, gap: null };
}

function gap(reason_code: ReasonCode, reason: string, status: GapStatus, transient: boolean, method: RecordMethod = METHOD_SCAN): ComputedSeries {
  return { value: null, method, source_host: null, as_of: null, hold: null, gap: { reason_code, reason, status, transient } };
}

function held(c: ComputedSeries, why: string, code: ReasonCode = "sanity_gate_failed"): ComputedSeries {
  return { ...c, hold: why, gap: { reason_code: code, reason: why, status: "open", transient: true } };
}

/**
 * Ends the reason of a round-totals series whose meaning check failed
 * (config.ts): the archive has a figure for it, but not the StartIssuing
 * split's, so the record leaves the series blank instead.
 */
const ROUND_TOTALS_NOT_VERIFIED =
  "The round-totals archive's figure for this series did not match the StartIssuing split when checked, so it is not published";

/** A gap with `sentence` added to its reason; code, status and method unchanged. */
function withSentence(c: ComputedSeries, sentence: string): ComputedSeries {
  return c.gap ? { ...c, gap: { ...c.gap, reason: `${c.gap.reason}. ${sentence}` } } : c;
}

function listRounds(rounds: number[]): string {
  const shown = rounds.slice(0, 5).join(", ");
  return rounds.length > 5 ? `${shown} and ${rounds.length - 5} more` : shown;
}

function latest(times: Array<string | null>): string | null {
  let best: string | null = null;
  for (const t of times) if (t != null && (best == null || Date.parse(t) > Date.parse(best))) best = t;
  return best;
}

function configFor(row: RoundRow, rows: RoundRow[]): { config: IssuanceConfig; tick: number } | null {
  if (row.issuance_config && row.tick_duration_us != null) return { config: row.issuance_config, tick: row.tick_duration_us };
  const near = rows
    .filter((r) => r.issuance_config != null && r.tick_duration_us != null)
    .sort((a, b) => Math.abs(a.round - row.round) - Math.abs(b.round - row.round))[0];
  return near ? { config: near.issuance_config as IssuanceConfig, tick: near.tick_duration_us as number } : null;
}

/**
 * The edges of a forward range that nothing confirms, one clause each naming
 * the neighbour round the day may include. A snapshot range
 * has its edges from the ACS readings and needs no neighbour.
 */
function unconfirmedEdges(inp: DayInputs, range: RoundRange, prevLast: number | null): string[] {
  if (range.source !== "forward") return [];
  const startedAt = (row: RoundRow | null, round: number) =>
    row?.round === round && row.start_issuing_at != null ? Date.parse(row.start_issuing_at) : null;
  const clauses: string[] = [];
  const before = startedAt(inp.neighbours.before, range.first - 1);
  const leftByPrevDay = prevLast === range.first - 1;
  if (!leftByPrevDay && !(before != null && before < Date.parse(`${inp.date}T00:00:00Z`))) {
    clauses.push(`round ${range.first - 1} has no captured StartIssuing before this day`);
  }
  const after = startedAt(inp.neighbours.after, range.last + 1);
  if (!(after != null && after >= Date.parse(endOfDay(inp.date)))) {
    clauses.push(`round ${range.last + 1} has no captured StartIssuing after this day`);
  }
  return clauses;
}

function roundGate(row: RoundRow, rows: RoundRow[]): string | null {
  if (!row.split) return `round ${row.round} has no StartIssuing summary`;
  const cfg = configFor(row, rows);
  if (!cfg) return `round ${row.round} has no issuance config`;
  const cats = Object.fromEntries(ISSUANCE_CATEGORIES.map((k) => [k, dec(row[k] as string)])) as Record<IssuanceCategory, Dec>;
  const check = checkRoundIssuance(cats, row.split.summary, cfg.config, cfg.tick);
  return check.ok ? null : `round ${row.round} issuance is off by ${format(check.diff)} CC (tolerance ${format(check.tolerance)})`;
}

/** `boundaryReason` names the edges of a forward range nothing confirms: the sums may lack a round, so none is published. */
function flows(
  inp: DayInputs,
  range: RoundRange,
  rangeHold: string | null,
  rangeCode: ReasonCode,
  forwardDay: boolean,
  asOfEnd: string,
  boundaryReason: string | null,
): Partial<Record<SeriesName, ComputedSeries>> {
  const byRound = new Map(inp.roundsInRange.map((r) => [r.round, r]));
  const rows: RoundRow[] = [];
  const absent: number[] = [];
  for (let n = range.first; n <= range.last; n++) {
    const row = byRound.get(n);
    if (row) rows.push(row);
    else absent.push(n);
  }
  const complete = (r: RoundRow) => r.method === METHOD_SCAN && r.split != null && ISSUANCE_CATEGORIES.every((k) => r[k] != null);
  // The archive's series whose meaning check passed (config.ts): only these
  // would be published from it, so a row of it needs only their figures.
  // None has passed, so the branch below that reads the archive is not taken.
  const verifiedTotals = ROUND_TOTALS_SERIES.filter((k) => inp.roundTotalsVerified[k]);
  const fromTotals = (r: RoundRow) => r.method === METHOD_ROUND_TOTALS && verifiedTotals.every((k) => r[k] != null);
  const out: Partial<Record<SeriesName, ComputedSeries>> = {};
  const gate = (c: ComputedSeries, why: string | null, code: ReasonCode) => (why ? held(c, why, code) : c);
  const notCollected = () =>
    gap(
      "not_collected",
      `Before the forward collector started${inp.collectorStartDate ? ` on ${inp.collectorStartDate}` : ""}; the update-stream backfill is planned`,
      "backfill_planned",
      false,
    );

  // Why the round series have no value when neither branch below publishes
  // them: a forward day names the rounds it lacks; before the collector, a
  // day both ACS readings bound whose rounds were partly read (the
  // StartIssuing backfill) names the rounds it lacks, and a day with none
  // read was not collected. Archive rows are
  // not read rounds, so this is also the reason of an archive series whose
  // meaning check failed.
  const lacking = [...absent, ...rows.filter((r) => !complete(r)).map((r) => r.round)].sort((a, b) => a - b);
  const missed =
    boundaryReason == null
      ? `Rounds not captured: ${listRounds(lacking)}`
      : lacking.length === 0
        ? boundaryReason
        : `Rounds not captured: ${listRounds(lacking)}. ${boundaryReason}`;
  const partlyRead = range.source === "snapshot" && boundaryReason == null && rows.some(complete);
  const reason = forwardDay
    ? gap("round_missed", missed, "open", true)
    : partlyRead
      ? gap("round_missed", missed, "backfill_planned", false)
      : notCollected();

  if (boundaryReason == null && absent.length === 0 && rows.length > 0 && rows.every(complete)) {
    // Both branches that publish a value have at least one row, whose
    // source_host is NOT NULL in network_record_rounds.
    const host = hostsOf(rows.map((r) => r.source_host));
    const asOf = latest(rows.map((r) => r.start_issuing_at)) ?? asOfEnd;
    let why = rangeHold;
    let code = rangeCode;
    if (!why) {
      for (const r of rows) {
        const bad = roundGate(r, rows);
        if (bad) {
          why = bad;
          code = "sanity_gate_failed";
          break;
        }
      }
    }
    // issuance_cc is the sum of the seven published columns (contract), so it
    // adds the columns as rounded to 10 places, not the unrounded total, whose
    // rounding can differ from theirs in the last place.
    let total = ZERO;
    for (const k of ISSUANCE_CATEGORIES) {
      const published = format(add(...rows.map((r) => dec(r[k] as string))));
      total += dec(published);
      out[k] = gate(value(published, host, METHOD_SCAN, asOf), why, code);
    }
    out.issuance_cc = gate(value(format(total), host, METHOD_SCAN, asOf), why, code);
    // complete() guarantees each row's StartIssuing summary. Held with the
    // rewards: a split that fails the gate is not trusted for its coupons either.
    for (const k of COUPON_SERIES) {
      const sum = add(...rows.map((r) => couponTotals((r.split as NonNullable<RoundRow["split"]>).summary)[k]));
      out[k] = gate(value(format(sum), host, METHOD_SCAN, asOf), why, code);
    }
    return out;
  }

  if (boundaryReason == null && absent.length === 0 && rows.length > 0 && verifiedTotals.length > 0 && rows.every(fromTotals)) {
    const host = hostsOf(rows.map((r) => r.source_host));
    const asOf = latest(rows.map((r) => r.closed_at)) ?? asOfEnd;
    for (const k of ROUND_TOTALS_SERIES) {
      if (!inp.roundTotalsVerified[k]) {
        // Its archived figure failed the meaning check: blank, never zero
        // and never that figure, with the day's reason and why the archive
        // is not used for it.
        out[k] = withSentence(reason, ROUND_TOTALS_NOT_VERIFIED);
        continue;
      }
      const sum = add(...rows.map((r) => dec(r[k] as string)));
      out[k] = gate(value(format(sum), host, METHOD_ROUND_TOTALS, asOf), rangeHold, rangeCode);
    }
    const missing = gap(
      "source_not_available_before",
      "The round-totals archive has no figure for this series; it needs the update-stream backfill (phase C)",
      "backfill_planned",
      false,
      METHOD_ROUND_TOTALS,
    );
    for (const k of ["sv_rewards_cc", "dev_fund_cc", "faucet_rewards_cc", "unfeatured_app_rewards_cc", "unclaimed_rewards_cc", "issuance_cc"] as const) {
      out[k] = missing;
    }
    // The archive carries no coupon totals either: they come only from a
    // captured StartIssuing summary. Before the collector they are not
    // collected, never zero; on a later day they wait like the series above.
    for (const k of COUPON_SERIES) out[k] = forwardDay ? missing : notCollected();
    return out;
  }

  for (const k of FLOW_SERIES) out[k] = reason;
  return out;
}

export function computeDay(inp: DayInputs): { series: Record<SeriesName, ComputedSeries>; warnings: string[] } {
  const asOfEnd = endOfDay(inp.date);
  const forwardDay = inp.collectorStartDate != null && inp.date >= inp.collectorStartDate;
  const out: Partial<Record<SeriesName, ComputedSeries>> = {};
  const warnings: string[] = [];

  // 1. Rounds and the issuance split.
  if (!inp.range) {
    const missing = gap(
      "source_unavailable",
      "No round boundary for this day: the ACS snapshots at both ends are not read and no StartIssuing was captured",
      "open",
      true,
    );
    for (const s of ["first_round", "last_round", "rounds", ...FLOW_SERIES] as SeriesName[]) out[s] = missing;
  } else {
    const { first, last } = inp.range;
    const count = last - first + 1;
    // The boundary's source: the snapshot that read it, else the captured
    // rounds that gave it. With neither there is no host to publish the counts
    // under, so they are a gap, never a value with a null host.
    const rowHosts = inp.startedInDay.length > 0 ? inp.startedInDay : inp.roundsInRange;
    const fromRows = rowHosts.length > 0 ? hostsOf(rowHosts.map((r) => r.source_host)) : null;
    const host = inp.range.source === "snapshot" ? (inp.snapshot?.source_host ?? fromRows) : (fromRows ?? inp.snapshot?.source_host ?? null);
    // first_round and rounds also rest on the previous day's snapshot when the range came from the two snapshots.
    const spanHost = host !== null && inp.range.source === "snapshot" && inp.prevSnapshot ? hostsOf([host, inp.prevSnapshot.source_host]) : host;
    const prevLastText = inp.prevValues.last_round;
    const prevLast = prevLastText != null ? Math.round(Number(prevLastText)) : null;
    // A forward range edge nothing confirms: the day may include the named
    // neighbour, so neither the counts nor the sums are known. A forward day
    // names it as round_missed; before the collector started,
    // the ACS snapshot backfill gives the boundary instead.
    const edges = unconfirmedEdges(inp, inp.range, prevLast);
    const boundaryReason =
      edges.length === 0
        ? null
        : `Day boundary not confirmed: ${edges.join(", and ")}, so the day may include ${edges.length > 1 ? "them" : "it"}`;
    const boundary =
      boundaryReason == null
        ? null
        : forwardDay
          ? gap("round_missed", boundaryReason, "open", true)
          : gap(
              "not_collected",
              `${boundaryReason}. Before the forward collector started${inp.collectorStartDate ? ` on ${inp.collectorStartDate}` : ""}, ` +
                "the boundary comes from the ACS snapshots at both ends, and their backfill is planned",
              "backfill_planned",
              false,
            );
    let why: string | null = null;
    let code: ReasonCode = "sanity_gate_failed";
    if (count < GATES.minRounds || count > GATES.maxRounds) {
      why = `rounds ${count} outside ${GATES.minRounds} to ${GATES.maxRounds}`;
    }
    if (!why && prevLast != null && first !== prevLast + 1) {
      why = `first_round ${first} does not follow the previous day's last_round ${prevLast}`;
    }
    if (!why && inp.range.source === "snapshot") {
      const dayStart = Date.parse(`${inp.date}T00:00:00Z`);
      const dayEnd = Date.parse(asOfEnd);
      const outside = inp.startedInDay.filter((r) => r.round < first || r.round > last).map((r) => r.round);
      const misplaced = inp.roundsInRange
        .filter((r) => r.start_issuing_at != null)
        .filter((r) => Date.parse(r.start_issuing_at as string) < dayStart || Date.parse(r.start_issuing_at as string) >= dayEnd)
        .map((r) => r.round);
      const disagree = [...outside, ...misplaced];
      if (disagree.length > 0) {
        why = `ACS boundary and StartIssuing times disagree on rounds ${listRounds(disagree)}`;
        code = "sources_disagree";
      }
    }
    const counts: Array<[SeriesName, number]> = [["first_round", first], ["last_round", last], ["rounds", count]];
    for (const [name, n] of counts) {
      if (host == null) {
        out[name] = gap("source_unavailable", "No source host names this day's round boundary", "open", true);
        continue;
      }
      if (boundary) {
        out[name] = boundary;
        continue;
      }
      const c = value(String(n), name === "last_round" ? host : (spanHost as string), METHOD_SCAN, asOfEnd);
      out[name] = why ? held(c, why, code) : c;
    }
    Object.assign(out, flows(inp, inp.range, why, code, forwardDay, asOfEnd, boundaryReason));
  }

  // 2. Snapshot series, all from the one ACS snapshot at D+1 00:00Z.
  const snap = inp.snapshot;
  const unread = () =>
    gap("source_unavailable", "The ACS snapshot at the end of this day has not been read yet", "open", true);
  // snapshot.ts stores the core row first and retries the license count for
  // up to SNAPSHOT_RETRY.maxAttempts reads; meanwhile the other series of the
  // same snapshot are published, so the reason names the count, not the snapshot.
  const licensesUnread = () =>
    gap(
      "source_unavailable",
      `The ValidatorLicense count of the ACS snapshot at ${asOfEnd} has not been read yet; the snapshot's other series are stored`,
      "open",
      true,
    );
  const gateCount = (name: SeriesName, current: number, host: string): ComputedSeries => {
    const c = value(String(current), host, METHOD_SCAN, asOfEnd);
    if (current === 0) return held(c, `${name} is 0`);
    const prevText = inp.prevValues[name];
    const prev = prevText != null ? Math.round(Number(prevText)) : null;
    if (prev != null && prev > 0 && Math.abs(current - prev) / prev > GATES.maxCountChange) {
      return held(c, `${name} moved from ${prev} to ${current}, more than ${GATES.maxCountChange * 100}% in a day`);
    }
    return c;
  };
  out.super_validators = snap?.super_validators != null ? gateCount("super_validators", snap.super_validators, snap.source_host) : unread();
  out.sv_voting_threshold =
    snap?.sv_voting_threshold != null ? gateCount("sv_voting_threshold", snap.sv_voting_threshold, snap.source_host) : unread();
  out.featured_apps = snap?.featured_apps != null ? gateCount("featured_apps", snap.featured_apps, snap.source_host) : unread();
  out.reference_price_usd =
    snap?.reference_price_usd != null
      ? value(format(dec(snap.reference_price_usd)), snap.source_host, METHOD_SCAN, asOfEnd)
      : unread();
  // Once the stage works on a later day, the daily stage does not read this
  // count again (DayInputs.snapshotStageDate), row or no row: it is not pending any more.
  const licensesNoLongerRead = inp.date < inp.snapshotStageDate;
  out.validator_licenses =
    snap?.validator_licenses != null
      ? gateCount("validator_licenses", snap.validator_licenses, snap.source_host)
      : snap != null && inp.licensesGaveUp
        ? gap("source_unavailable", licensesGaveUpReason(inp.date), "backfill_planned", false)
        : forwardDay
          ? licensesNoLongerRead
            ? gap("source_unavailable", licensesNotReadReason(inp.date), "backfill_planned", false)
            : snap != null
              ? licensesUnread()
              : unread()
          : gap("not_collected", "ValidatorLicense history before the collector started is backfilled in phase C", "backfill_planned", false);

  // 3. Supply, from the exact 00:00Z registry readings.
  if (inp.supply) {
    const c = value(format(dec(inp.supply.value)), inp.supply.source_host, METHOD_SCAN, asOfEnd);
    const frozen = inp.prevSupply != null && dec(inp.prevSupply.value) === dec(inp.supply.value);
    out.supply_cc = frozen ? held(c, "supply_cc unchanged day over day (the frozen total_cc signature)") : c;
  } else {
    out.supply_cc =
      inp.date < SUPPLY_FIRST_DATE
        ? gap("source_not_available_before", "No 00:00 UTC registry reading before 2026-09-03", "backfill_planned", false)
        : gap("source_unavailable", "No registry reading with totalSupplyAsOf at the end of this day", "open", true);
  }
  const prevDate = addDays(inp.date, -1);
  if (inp.supply && inp.prevSupply) {
    const net = dec(inp.supply.value) - dec(inp.prevSupply.value);
    const c = value(format(net), hostsOf([inp.supply.source_host, inp.prevSupply.source_host]), METHOD_SCAN, asOfEnd);
    const supplyHold = out.supply_cc?.hold ?? null;
    out.net_supply_change_cc = supplyHold ? held(c, supplyHold) : c;
    // Observations only: why supply moved is not known until a later check
    // reconciles supply(D) - supply(D-1) = minted - burned.
    if (net < ZERO) warnings.push("Net supply change is negative: supply fell over this day. Issuance is not minted supply (see Methodology, Known limitations).");
    const issuance = out.issuance_cc?.value;
    if (issuance != null && net > dec(issuance)) {
      warnings.push("Net supply change exceeds the day's scheduled issuance; issuance is not minted supply (see Methodology, Known limitations).");
    }
  } else {
    out.net_supply_change_cc =
      prevDate < SUPPLY_FIRST_DATE
        ? gap("source_not_available_before", `Needs the end-of-day supply for ${prevDate}, which was not read`, "backfill_planned", false)
        : gap("source_unavailable", "Needs the registry supply at both ends of the day", "open", true);
  }

  for (const s of SERIES_NAMES) if (!out[s]) throw new Error(`computeDay left ${s} undefined`);
  return { series: out as Record<SeriesName, ComputedSeries>, warnings };
}
