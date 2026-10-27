import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dec, format, mul } from "../decimal";
import {
  categoryAmounts,
  checkRoundIssuance,
  couponTotals,
  findStartIssuing,
  parseOpenAndIssuing,
  type ScanTransaction,
} from "../rounds";

const FIXTURES = join(process.cwd(), "src/scan-record/__tests__/fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
const txs = (): ScanTransaction[] => load("updates-start-issuing-114513.json").transactions;

describe("parseOpenAndIssuing", () => {
  it("reads open rounds with their price, config and tick, and issuing rounds with their creation time", () => {
    const parsed = parseOpenAndIssuing(load("open-and-issuing.json"));
    expect(parsed.open).toEqual([
      {
        round: 114683,
        contractId: "00f4057cd4439d88",
        opensAt: "2026-09-25T10:52:26.749664Z",
        amuletPrice: "0.119296",
        issuanceConfig: expect.objectContaining({ amuletToIssuePerYear: "10000000000.0" }),
        tickDurationUs: "600000000",
      },
    ]);
    expect(parsed.issuing).toEqual([
      { round: 114513, contractId: "00c98a61d34f5395", createdAt: "2026-09-24T06:06:09.707106Z" },
    ]);
  });

  it("returns empty lists for an empty or malformed body", () => {
    expect(parseOpenAndIssuing({})).toEqual({ open: [], issuing: [] });
    expect(parseOpenAndIssuing(null)).toEqual({ open: [], issuing: [] });
  });
});

describe("findStartIssuing", () => {
  it("finds the round's StartIssuing by the IssuingMiningRound it created", () => {
    const c = findStartIssuing(txs(), { contractId: "00c98a61d34f5395" });
    expect(c).toEqual({
      round: 114513,
      updateId: "1220f8518aa9",
      recordTime: "2026-09-24T06:06:09.881439Z",
      migrationId: 4,
      issuingContractId: "00c98a61d34f5395",
      summary: {
        featuredAppCoupons: "203513.6207535227",
        unfeaturedAppCoupons: "0E-10",
        validatorCoupons: "66903.7706586005",
        svRewardWeight: "3746500",
        validatorFaucetCoupons: "0",
      },
      rates: {
        featuredApp: "0.5506383526",
        unfeaturedApp: "0.5506383526",
        validator: "0.2000000000",
        sv: "0.0096487823",
        validatorFaucet: "0E-10",
      },
      unclaimed: "19153.4924508655",
      devFund: "9512.9375951294",
    });
  });

  it("finds it by round number too, and returns null for a round that is not there", () => {
    expect(findStartIssuing(txs(), { round: 114513 })?.updateId).toBe("1220f8518aa9");
    expect(findStartIssuing(txs(), { round: 999 })).toBeNull();
    expect(findStartIssuing(txs(), { contractId: "nope" })).toBeNull();
  });
});

describe("issuance of round 114513", () => {
  const c = findStartIssuing(txs(), { round: 114513 })!;

  it("splits into the seven categories, unclaimed read from its own event", () => {
    const cats = categoryAmounts(c);
    expect(Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, format(v)]))).toEqual({
      app_rewards_cc: "112062.4048633809",
      validator_rewards_cc: "13380.7541317201",
      sv_rewards_cc: "36149.1628869500",
      dev_fund_cc: "9512.9375951294",
      faucet_rewards_cc: "0.0000000000",
      unfeatured_app_rewards_cc: "0.0000000000",
      unclaimed_rewards_cc: "19153.4924508655",
    });
  });

  it("reads the featured-app and validator coupon totals of its StartIssuing summary", () => {
    const totals = couponTotals(c.summary);
    expect(Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, format(v)]))).toEqual({
      app_reward_coupons: "203513.6207535227",
      validator_reward_coupons: "66903.7706586005",
    });
    // The rewards are these totals times the round's rates, so the published pair can be checked.
    expect(format(mul(totals.app_reward_coupons, dec(c.rates.featuredApp)))).toBe(
      format(categoryAmounts(c).app_rewards_cc),
    );
  });

  it("sums to the round's scheduled issuance within the rounding bound", () => {
    const check = checkRoundIssuance(categoryAmounts(c), c.summary, { amuletToIssuePerYear: "10000000000.0" }, "600000000");
    expect(format(check.expected)).toBe("190258.7519025875");
    expect(format(check.sum)).toBe("190258.7519280459");
    expect(format(check.diff)).toBe("0.0000254584");
    expect(format(check.tolerance)).toBe("0.0004016927");
    expect(check.ok).toBe(true);
  });

  it("fails the gate when a category is missing", () => {
    const cats = { ...categoryAmounts(c), unclaimed_rewards_cc: dec("0") };
    const check = checkRoundIssuance(cats, c.summary, { amuletToIssuePerYear: "10000000000.0" }, "600000000");
    expect(check.ok).toBe(false);
  });
});
