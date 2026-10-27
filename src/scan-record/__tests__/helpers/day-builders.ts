import { ISSUANCE_CATEGORIES, addDays, endOfDay } from "../../../open-record/contract";
import type { RoundTotalsVerification } from "../../config";
import { format } from "../../decimal";
import { categoryAmounts, findStartIssuing, type ScanTransaction } from "../../rounds";
import { blankRound, type RoundRow, type SnapshotRow } from "../../store";
import { loadFixture } from "./fake-scan";

export const HOST = "api.cantonnodes.com";
const capture = findStartIssuing(loadFixture("updates-start-issuing-114513.json").transactions as ScanTransaction[], {
  round: 114513,
})!;
const cats = categoryAmounts(capture);

/** A captured round with round 114513's real split, config and tick. */
export function capturedRound(n: number, startIso: string | null): RoundRow {
  const row: RoundRow = {
    ...blankRound(n, HOST),
    start_issuing_at: startIso,
    tick_duration_us: 600_000_000,
    issuance_config: { amuletToIssuePerYear: "10000000000.0" },
    split: { summary: capture.summary, rates: capture.rates, config_inferred: false },
    update_id: `u${n}`,
    migration_id: 4,
  };
  for (const k of ISSUANCE_CATEGORIES) row[k] = format(cats[k], 20);
  return row;
}

/** `count` rounds from `first`, ten minutes apart from 00:00:30Z on `date`. */
export function dayOfRounds(date: string, first: number, count = 140): RoundRow[] {
  const start = Date.parse(`${date}T00:00:30Z`);
  return Array.from({ length: count }, (_, i) => capturedRound(first + i, new Date(start + i * 600_000).toISOString()));
}

/** Rounds first - 1 and first + count, captured just outside the day that dayOfRounds(date, first, count) fills. */
export function neighboursOf(date: string, first: number, count = 140): { before: RoundRow; after: RoundRow } {
  return {
    before: capturedRound(first - 1, new Date(Date.parse(`${date}T00:00:00Z`) - 570_000).toISOString()),
    after: capturedRound(first + count, new Date(Date.parse(`${addDays(date, 1)}T00:00:30Z`)).toISOString()),
  };
}

export function snapshotRow(date: string, lastRound: number, extra: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    date, record_time: endOfDay(date), migration_id: 4, source_host: HOST, method: "scan-1",
    last_round: lastRound, reference_round: lastRound + 3, reference_price_usd: "0.119296",
    super_validators: 13, sv_voting_threshold: 9, featured_apps: 127, validator_licenses: 1400, ...extra,
  };
}

/** roundTotalsVerified with no series of the round-totals archive verified: the archive is never used. */
export const NO_ROUND_TOTALS: RoundTotalsVerification = { app_rewards_cc: false, validator_rewards_cc: false };
/** Every series verified: a hypothetical archive whose figures all passed the meaning check. */
export const ALL_ROUND_TOTALS: RoundTotalsVerification = { app_rewards_cc: true, validator_rewards_cc: true };

export const SUPPLY_END = "39690000000.5";
export const SUPPLY_START = "39681534966.2458918175";
