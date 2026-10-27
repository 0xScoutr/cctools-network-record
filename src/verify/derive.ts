/**
 * Re-derive one day of the record from Scan, with the collector's own code:
 *
 *   1. the ACS snapshot at D+1 00:00:00Z (snapshot.ts readSnapshot): the
 *      day's last_round and every snapshot series;
 *   2. IssuingMiningRound and OpenMiningRound in the ACS snapshot at
 *      D 00:00:00Z: the previous day's last round, so first_round, and the
 *      issuance config and tick the round gate checks each round against;
 *   3. the AmuletRules_MiningRound_StartIssuing exercise of every round from
 *      first_round to last_round, found on /v2/updates by walking forward
 *      from the previous round's StartIssuing (each round starts about 616 s
 *      after the one before), and stored as the collector stores it
 *      (collector.ts captureWrite);
 *   4. day-values.ts computeDay over those rows, with the previous day's
 *      published values for the day-over-day gates and the published supply
 *      (Scan serves only the current registry supply, so a past day's supply
 *      cannot be read again; see the report).
 *
 * Nothing is stored. The result is what finalize would compute from the
 * same Scan answers.
 */

import { TEMPLATES, extractSnapshot, type AcsCreatedEvent } from "../scan-record/acs";
import { captureWrite } from "../scan-record/collector";
import { ROUND_TOTALS_SERIES_VERIFIED } from "../scan-record/config";
import { computeDay, resolveRange, type ComputedSeries } from "../scan-record/day-values";
import { findStartIssuing, parseOpenAndIssuing, type OpenRoundMeta, type ScanTransaction } from "../scan-record/rounds";
import type { ScanApi } from "../scan-record/scan-client";
import { readSnapshot, snapshotStageDate } from "../scan-record/snapshot";
import type { RoundRow, SnapshotRow } from "../scan-record/store";
import { METHOD_SCAN, addDays, endOfDay, type SeriesName } from "../open-record/contract";

export const WALK = {
  /** The usual distance between two rounds' StartIssuing, measured over months of rounds. */
  spacingMs: 616_000,
  /**
   * Rows per /v2/updates page: about two minutes of ledger at the current
   * rate, so the page that starts `leadMs` before the estimate almost always
   * holds the StartIssuing. A public host allows a few requests a minute, so
   * fewer, larger pages are faster than many small ones.
   */
  pageSize: 300,
  /** The first page starts this long before the estimate. */
  leadMs: 40_000,
  /** A window ends this long after the estimate. */
  trailMs: 120_000,
  /** Pages per window before the round is looked for in the wide window. */
  maxPages: 4,
  /** The wide window: from the previous round's StartIssuing to two spacings after it. */
  wideMaxPages: 40,
} as const;

export interface DeriveInputs {
  scan: ScanApi;
  date: string;
  /** The migration id the day's snapshots were taken under; default the current one. */
  migrationId?: number;
  /** The previous day's published values, numeric text, for the day-over-day gates. */
  prevValues: Partial<Record<SeriesName, string | null>>;
  /** The published supply at the end of D and of D-1 (not re-derivable from Scan). */
  supply: { value: string; source_host: string } | null;
  prevSupply: { value: string; source_host: string } | null;
  now: Date;
  log?: (line: string) => void;
}

export interface DerivedDay {
  migrationId: number;
  host: string;
  snapshot: SnapshotRow;
  prevLastRound: number;
  rounds: RoundRow[];
  /** Rounds of the range whose StartIssuing was not found. */
  notFound: number[];
  pages: number;
  series: Record<SeriesName, ComputedSeries>;
  warnings: string[];
}

/** ACS create events as the open-and-issuing envelope parseOpenAndIssuing reads. */
function asEnvelope(events: AcsCreatedEvent[]) {
  return Object.fromEntries(
    events.map((e) => [
      e.contract_id,
      { contract: { contract_id: e.contract_id, created_at: e.created_at, payload: e.create_arguments } },
    ]),
  );
}

async function locate(
  scan: ScanApi,
  migrationId: number,
  round: number,
  windows: Array<{ after: number; stopAt: number; maxPages: number }>,
  counter: { pages: number },
): Promise<{ capture: NonNullable<ReturnType<typeof findStartIssuing>>; host: string } | null> {
  for (const w of windows) {
    let after = new Date(w.after).toISOString();
    for (let page = 0; page < w.maxPages; page++) {
      const res = await scan.updatesAfter(migrationId, after, WALK.pageSize);
      counter.pages++;
      const hit = findStartIssuing(res.transactions as ScanTransaction[], { round });
      if (hit) return { capture: hit, host: res.host };
      const last = res.transactions[res.transactions.length - 1];
      if (!last) throw new Error(`Scan ${res.host} has no update after ${after}`);
      if (Date.parse(last.record_time) > w.stopAt) break;
      after = last.record_time;
    }
  }
  return null;
}

export async function deriveDay(inp: DeriveInputs): Promise<DerivedDay> {
  const { scan, date } = inp;
  const log = inp.log ?? (() => {});
  const migrationId = inp.migrationId ?? (await scan.migrationId());
  const prevDate = addDays(date, -1);

  log(`ACS snapshot at ${endOfDay(date)} (DsoRules, OpenMiningRound, IssuingMiningRound, FeaturedAppRight, ValidatorLicense)`);
  const snapshot = await readSnapshot(scan, migrationId, date, { withLicenses: true });
  const host = snapshot.source_host;

  log(`ACS snapshot at ${endOfDay(prevDate)} (IssuingMiningRound, OpenMiningRound)`);
  const startIssuing = await scan.acsSnapshot(migrationId, endOfDay(prevDate), TEMPLATES.issuingRound, host);
  const startOpen = await scan.acsSnapshot(migrationId, endOfDay(prevDate), TEMPLATES.openRound, host);
  const prevLastRound = extractSnapshot({
    dsoRules: [], openRounds: [], issuingRounds: startIssuing.events, featuredApps: [], validatorLicenses: null,
  }).lastRound;
  if (prevLastRound == null || snapshot.last_round == null) throw new Error(`no IssuingMiningRound bounds ${date}`);
  const open: OpenRoundMeta[] = parseOpenAndIssuing({ open_mining_rounds: asEnvelope(startOpen.events), issuing_mining_rounds: {} }).open;
  const issuing = parseOpenAndIssuing({ open_mining_rounds: {}, issuing_mining_rounds: asEnvelope(startIssuing.events) }).issuing;
  const anchor = issuing.find((r) => r.round === prevLastRound);

  const first = prevLastRound + 1;
  const last = snapshot.last_round;
  log(`rounds ${first} to ${last} (${last - first + 1}): locating each StartIssuing on /v2/updates`);
  const rounds: RoundRow[] = [];
  const notFound: number[] = [];
  const counter = { pages: 0 };
  let prevAt = anchor ? Date.parse(anchor.createdAt) : Date.parse(`${date}T00:00:00Z`) - WALK.spacingMs;
  let spacing: number = WALK.spacingMs;
  let earliest = 0;
  let latest = 0;
  for (let n = first; n <= last; n++) {
    const estimate = prevAt + spacing;
    const found = await locate(
      scan,
      migrationId,
      n,
      [
        { after: estimate - WALK.leadMs, stopAt: estimate + WALK.trailMs, maxPages: WALK.maxPages },
        { after: prevAt, stopAt: prevAt + 2 * WALK.spacingMs, maxPages: WALK.wideMaxPages },
      ],
      counter,
    );
    if (!found) {
      notFound.push(n);
      log(`round ${n}: no StartIssuing found`);
      prevAt = estimate;
      continue;
    }
    const at = Date.parse(found.capture.recordTime);
    earliest = Math.min(earliest, at - estimate);
    latest = Math.max(latest, at - estimate);
    // The next estimate follows the rounds actually seen, within a day's usual range.
    if (n > first || anchor) spacing = Math.min(Math.max(at - prevAt, 590_000), 640_000);
    prevAt = at;
    rounds.push({ ...(captureWrite(found, undefined, open, false) as RoundRow), opens_at: null, closed_at: null, amulet_price: null });
    if ((n - first + 1) % 10 === 0 || n === last) {
      const s = (ms: number) => `${ms >= 0 ? "+" : ""}${Math.round(ms / 1000)} s`;
      log(`  ${n - first + 1} of ${last - first + 1} rounds located in ${counter.pages} pages; StartIssuing ${s(earliest)} to ${s(latest)} from the estimate`);
    }
  }

  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const dayEnd = Date.parse(endOfDay(date));
  const started = rounds.filter((r) => {
    const t = Date.parse(r.start_issuing_at as string);
    return t >= dayStart && t < dayEnd;
  });
  const prevSnapshot: SnapshotRow = {
    date: prevDate, record_time: endOfDay(prevDate), migration_id: migrationId, source_host: host, method: METHOD_SCAN,
    last_round: prevLastRound, reference_round: null, reference_price_usd: null, super_validators: null,
    sv_voting_threshold: null, featured_apps: null, validator_licenses: null,
  };
  const range = resolveRange(snapshot, prevSnapshot, started);
  const computed = computeDay({
    date,
    range,
    roundsInRange: rounds.filter((r) => range != null && r.round >= range.first && r.round <= range.last),
    startedInDay: started,
    neighbours: { before: null, after: null },
    snapshot,
    prevSnapshot,
    prevValues: inp.prevValues,
    supply: inp.supply,
    prevSupply: inp.prevSupply,
    collectorStartDate: null,
    roundTotalsVerified: ROUND_TOTALS_SERIES_VERIFIED,
    licensesGaveUp: false,
    snapshotStageDate: snapshotStageDate(inp.now.getTime()),
  });
  return {
    migrationId, host, snapshot, prevLastRound, rounds, notFound, pages: counter.pages,
    series: computed.series, warnings: computed.warnings,
  };
}
