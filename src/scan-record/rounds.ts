/**
 * Mining rounds as Scan serves them, and the issuance split of each round.
 *
 * The split is read from the AmuletRules_MiningRound_StartIssuing exercise
 *: its `summary` carries the coupon totals, the IssuingMiningRound
 * it creates carries the per-coupon rates, and the UnclaimedReward and
 * UnclaimedDevelopmentFundCoupon it creates carry those two amounts. Unclaimed
 * is read from its own event and never computed as a remainder, so the
 * per-round gate is not a tautology.
 */

import type { CouponSeries, IssuanceCategory } from "../open-record/contract";
import { abs, add, dec, mul, type Dec } from "./decimal";

export interface IssuanceConfig {
  amuletToIssuePerYear: string;
  [key: string]: unknown;
}

export interface OpenRoundMeta {
  round: number;
  contractId: string;
  opensAt: string | null;
  amuletPrice: string | null;
  issuanceConfig: IssuanceConfig | null;
  tickDurationUs: string | null;
}

export interface IssuingRoundRef {
  round: number;
  contractId: string;
  /** Creation time of the IssuingMiningRound, the effective time of its StartIssuing. */
  createdAt: string;
}

export interface ParsedRounds {
  open: OpenRoundMeta[];
  issuing: IssuingRoundRef[];
}

export interface ScanEvent {
  event_type: "created_event" | "exercised_event";
  event_id: string;
  contract_id: string;
  template_id: string;
  choice?: string;
  choice_argument?: Record<string, unknown>;
  child_event_ids?: string[];
  create_arguments?: Record<string, unknown>;
  created_at?: string;
}

export interface ScanTransaction {
  update_id: string;
  migration_id: number;
  record_time: string;
  events_by_id: Record<string, ScanEvent>;
}

export interface StartIssuingCapture {
  round: number;
  updateId: string;
  /** Record time of the transaction: the round's day. */
  recordTime: string;
  migrationId: number;
  issuingContractId: string;
  summary: {
    featuredAppCoupons: string;
    unfeaturedAppCoupons: string;
    validatorCoupons: string;
    svRewardWeight: string;
    validatorFaucetCoupons: string;
  };
  rates: {
    featuredApp: string;
    unfeaturedApp: string;
    validator: string;
    sv: string;
    validatorFaucet: string;
  };
  unclaimed: string;
  devFund: string;
}

interface ContractEnvelope {
  contract?: {
    contract_id?: string;
    created_at?: string;
    payload?: Record<string, unknown>;
  };
}

function entity(templateId: string): string {
  const i = templateId.indexOf(":");
  return i >= 0 ? templateId.slice(i + 1) : templateId;
}

function text(value: unknown, fallback: string | null = null): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function roundOf(args: Record<string, unknown> | undefined): number | null {
  const round = args?.round as { number?: unknown } | undefined;
  const n = Number(round?.number);
  return Number.isInteger(n) ? n : null;
}

export function parseOpenAndIssuing(body: unknown): ParsedRounds {
  const b = (body ?? {}) as {
    open_mining_rounds?: Record<string, ContractEnvelope>;
    issuing_mining_rounds?: Record<string, ContractEnvelope>;
  };
  const open: OpenRoundMeta[] = [];
  const issuing: IssuingRoundRef[] = [];

  for (const envelope of Object.values(b.open_mining_rounds ?? {})) {
    const c = envelope?.contract;
    const p = c?.payload;
    const round = roundOf(p);
    if (!c?.contract_id || round == null) continue;
    const config = p?.issuanceConfig as IssuanceConfig | undefined;
    const tick = (p?.tickDuration as { microseconds?: unknown } | undefined)?.microseconds;
    open.push({
      round,
      contractId: c.contract_id,
      opensAt: text(p?.opensAt),
      amuletPrice: text(p?.amuletPrice),
      issuanceConfig: config && typeof config.amuletToIssuePerYear === "string" ? config : null,
      tickDurationUs: text(tick),
    });
  }

  for (const envelope of Object.values(b.issuing_mining_rounds ?? {})) {
    const c = envelope?.contract;
    const round = roundOf(c?.payload);
    if (!c?.contract_id || !c.created_at || round == null) continue;
    issuing.push({ round, contractId: c.contract_id, createdAt: c.created_at });
  }

  open.sort((a, z) => a.round - z.round);
  issuing.sort((a, z) => a.round - z.round);
  return { open, issuing };
}

/** The StartIssuing capture for a round, by the IssuingMiningRound contract it created or by number. */
export function findStartIssuing(
  transactions: ScanTransaction[],
  match: { contractId?: string; round?: number },
): StartIssuingCapture | null {
  for (const tx of transactions) {
    for (const ev of Object.values(tx.events_by_id ?? {})) {
      if (ev.event_type !== "exercised_event" || ev.choice !== "AmuletRules_MiningRound_StartIssuing") continue;
      const children = (ev.child_event_ids ?? [])
        .map((id) => tx.events_by_id[id])
        .filter((c): c is ScanEvent => c != null && c.event_type === "created_event");
      const issuing = children.find((c) => entity(c.template_id) === "Splice.Round:IssuingMiningRound");
      if (!issuing?.create_arguments) continue;
      const round = roundOf(issuing.create_arguments);
      if (round == null) continue;
      if (match.contractId != null && issuing.contract_id !== match.contractId) continue;
      if (match.round != null && round !== match.round) continue;

      const summary = (ev.choice_argument?.summary ?? {}) as Record<string, unknown>;
      const rates = issuing.create_arguments;
      const amountOf = (name: string) =>
        text(children.find((c) => entity(c.template_id) === name)?.create_arguments?.amount, "0") as string;

      return {
        round,
        updateId: tx.update_id,
        recordTime: tx.record_time,
        migrationId: tx.migration_id,
        issuingContractId: issuing.contract_id,
        summary: {
          featuredAppCoupons: text(summary.totalFeaturedAppRewardCoupons, "0") as string,
          unfeaturedAppCoupons: text(summary.totalUnfeaturedAppRewardCoupons, "0") as string,
          validatorCoupons: text(summary.totalValidatorRewardCoupons, "0") as string,
          svRewardWeight: text(summary.totalSvRewardWeight, "0") as string,
          validatorFaucetCoupons: text(summary.optTotalValidatorFaucetCoupons, "0") as string,
        },
        rates: {
          featuredApp: text(rates.issuancePerFeaturedAppRewardCoupon, "0") as string,
          unfeaturedApp: text(rates.issuancePerUnfeaturedAppRewardCoupon, "0") as string,
          validator: text(rates.issuancePerValidatorRewardCoupon, "0") as string,
          sv: text(rates.issuancePerSvRewardCoupon, "0") as string,
          validatorFaucet: text(rates.optIssuancePerValidatorFaucetCoupon, "0") as string,
        },
        unclaimed: amountOf("Splice.Amulet:UnclaimedReward"),
        devFund: amountOf("Splice.Amulet:UnclaimedDevelopmentFundCoupon"),
      };
    }
  }
  return null;
}

export function categoryAmounts(
  c: Pick<StartIssuingCapture, "summary" | "rates" | "unclaimed" | "devFund">,
): Record<IssuanceCategory, Dec> {
  return {
    app_rewards_cc: mul(dec(c.summary.featuredAppCoupons), dec(c.rates.featuredApp)),
    validator_rewards_cc: mul(dec(c.summary.validatorCoupons), dec(c.rates.validator)),
    sv_rewards_cc: mul(dec(c.summary.svRewardWeight), dec(c.rates.sv)),
    dev_fund_cc: dec(c.devFund),
    faucet_rewards_cc: mul(dec(c.summary.validatorFaucetCoupons), dec(c.rates.validatorFaucet)),
    unfeatured_app_rewards_cc: mul(dec(c.summary.unfeaturedAppCoupons), dec(c.rates.unfeaturedApp)),
    unclaimed_rewards_cc: dec(c.unclaimed),
  };
}

/**
 * The featured-app and validator coupon totals of the StartIssuing summary,
 * the quantities app_rewards_cc and validator_rewards_cc are priced on
 * (coupons x rate). Read as Scan states them, never derived from the rewards.
 */
export function couponTotals(summary: StartIssuingCapture["summary"]): Record<CouponSeries, Dec> {
  return {
    app_reward_coupons: dec(summary.featuredAppCoupons),
    validator_reward_coupons: dec(summary.validatorCoupons),
  };
}

const MICROS_PER_YEAR = BigInt(365 * 24 * 3600) * BigInt(1_000_000);
const TEN_TO_THE_TEN = BigInt(10) ** BigInt(10);

/** amuletToIssuePerYear x tickDuration / 365 days, from the round's own config (never a constant). */
export function expectedIssuance(config: IssuanceConfig, tickDurationUs: string | number): Dec {
  return (dec(config.amuletToIssuePerYear) * BigInt(tickDurationUs)) / MICROS_PER_YEAR;
}

/**
 * Each issuancePer* rate is a Daml Decimal rounded to 10 places, and the
 * amount is coupons x rate, so the category sum can drift by up to 1e-10 per
 * coupon unit, which is why the check cannot be "exact to 1e-6".
 */
export function issuanceTolerance(summary: StartIssuingCapture["summary"]): Dec {
  const coupons = add(
    dec(summary.featuredAppCoupons),
    dec(summary.unfeaturedAppCoupons),
    dec(summary.validatorCoupons),
    dec(summary.svRewardWeight),
    dec(summary.validatorFaucetCoupons),
  );
  return coupons / TEN_TO_THE_TEN + dec("0.000000001");
}

export interface RoundIssuanceCheck {
  ok: boolean;
  sum: Dec;
  expected: Dec;
  diff: Dec;
  tolerance: Dec;
}

export function checkRoundIssuance(
  categories: Record<IssuanceCategory, Dec>,
  summary: StartIssuingCapture["summary"],
  config: IssuanceConfig,
  tickDurationUs: string | number,
): RoundIssuanceCheck {
  const sum = add(...Object.values(categories));
  const expected = expectedIssuance(config, tickDurationUs);
  const diff = abs(sum - expected);
  const tolerance = issuanceTolerance(summary);
  return { ok: diff <= tolerance, sum, expected, diff, tolerance };
}
