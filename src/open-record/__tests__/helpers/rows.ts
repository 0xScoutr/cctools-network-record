import type { GapRow, RevisionRow, SeriesName, ValueRow, ValueStatus } from "../../contract";
import { SERIES_NAMES } from "../../contract";

/** One day as numeric(38,10) text, the way PostgREST returns `value::text` (a real 140-round day). */
export const SAMPLE: Record<SeriesName, string> = {
  first_round: "200001.0000000000",
  last_round: "200140.0000000000",
  rounds: "140.0000000000",
  supply_cc: "39690000000.5000000000",
  net_supply_change_cc: "8465034.2541081825",
  reference_price_usd: "0.1192960000",
  issuance_cc: "26636225.2699264274",
  app_rewards_cc: "15688736.6808733274",
  validator_rewards_cc: "1873305.5784408140",
  sv_rewards_cc: "5060882.8041730000",
  dev_fund_cc: "1331811.2633181160",
  faucet_rewards_cc: "0.0000000000",
  unfeatured_app_rewards_cc: "0.0000000000",
  unclaimed_rewards_cc: "2681488.9431211700",
  super_validators: "13.0000000000",
  sv_voting_threshold: "9.0000000000",
  featured_apps: "127.0000000000",
  validator_licenses: "1400.0000000000",
  app_reward_coupons: "28491906.9054931780",
  validator_reward_coupons: "9366527.8922040700",
};

export function vrow(date: string, series: SeriesName, value: string | null, status: ValueStatus = "final"): ValueRow {
  return {
    date, series, value, status, source_host: "api.cantonnodes.com", method: "scan-1",
    as_of: `${nextDay(date)}T00:00:00+00:00`, retrieved_at: "2026-10-06T01:35:00+00:00",
    finalized_at: status === "final" ? "2026-10-06T02:35:00+00:00" : null, revision: 0, revised_at: null,
  };
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function fullDay(date: string, status: ValueStatus = "final", over: Partial<Record<SeriesName, string | null>> = {}): ValueRow[] {
  return SERIES_NAMES.map((s) => vrow(date, s, s in over ? (over[s] ?? null) : SAMPLE[s], status));
}

export function gapRow(date: string, series: GapRow["series"], extra: Partial<GapRow> = {}): GapRow {
  return {
    date, series, reason_code: "round_missed", reason: "Rounds not captured: 200070", status: "backfill_planned",
    detected_at: "2026-10-06T00:35:00+00:00", resolved_at: null, evidence_url: null, ...extra,
  };
}

export function revisionRow(date: string, series: SeriesName, revisedAt: string): RevisionRow {
  return { date, series, old_value: null, new_value: SAMPLE[series], kind: "backfill", reason: "Late data", method: "scan-1", revised_at: revisedAt };
}
