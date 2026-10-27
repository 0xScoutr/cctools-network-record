/**
 * The meaning check, per series: an archived round-totals
 * figure may be published under method scan-rt-1 only if it is the
 * StartIssuing split of the same round, read the way the forward collector
 * reads it. Neither series is, so config.ts verifies neither, and this suite
 * fails if either flag is true.
 *
 * Fixtures, no network: round 101404's StartIssuing (located on the update
 * stream by its round number) and its round-totals
 * entry (captured 2026-09-25), and round 91963's round-totals entry, copied
 * byte for byte from the archived page rt-091800-091999.json (sha256
 * 9cfa8f6a27c65c1d1f7b812e7cc7a8e618a987dc1b73dfb6885d62b643806cb5 in the
 * archive's manifest); the entry's own bytes hash to ENTRY_91963_SHA256.
 *
 * App rewards: round 101404 matches its StartIssuing split (2026-09-30), an
 * observation only, since that round's coupons were all collected in it. The
 * decisive check (2026-10-01): round 91963's archived app rewards exceed the
 * whole featured-app pool a round issues, and an issued split never exceeds
 * its pool. The pool is round 101404's issued app rewards, coupons x rate at
 * saturation: the archive repeats that value within 0.0003 CC in 3,163 rounds
 * of the import span, around round 91963 too (round 91604 on 2026-04-13,
 * round 93332 on 2026-04-26). Validator rewards: round 101404's archived
 * figure is 72.45% of its StartIssuing split.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUND_TOTALS_SERIES, ROUND_TOTALS_SERIES_VERIFIED, type RoundTotalsSeries } from "../config";
import { abs, dec, format } from "../decimal";
import { categoryAmounts, findStartIssuing, issuanceTolerance, type ScanTransaction } from "../rounds";

const ENTRY_91963_SHA256 = "faa136467024c5e1cd901557d9dd7ed9e0227f3c8288ff8c7f19bcfa4042e7cb";

const FIX = join(process.cwd(), "src/scan-record/__tests__/fixtures");
const read = (file: string) => readFileSync(join(FIX, file), "utf-8");
const txs: ScanTransaction[] = JSON.parse(read("start-issuing-101404.json")).transactions;
const rt101404 = JSON.parse(read("round-totals-101404.json")).entries[0];
const text91963 = read("round-totals-91963.json");
const rt91963 = JSON.parse(text91963).entries[0];
const capture = findStartIssuing(txs, { round: 101404 });
const cats = capture ? categoryAmounts(capture) : null;
const tolerance = capture ? issuanceTolerance(capture.summary) : null;
/** The featured-app pool a round issues: round 101404's issued app rewards, saturated. */
const pool = cats ? cats.app_rewards_cc : null;

/** Round 101404's archived figure of `series` against its StartIssuing split. */
function on101404(series: RoundTotalsSeries) {
  const startIssuing = cats![series];
  const roundTotals = dec(series === "app_rewards_cc" ? rt101404.app_rewards : rt101404.validator_rewards);
  const diff = abs(startIssuing - roundTotals);
  return { startIssuing: format(startIssuing), roundTotals: format(roundTotals), diff: format(diff), matches: diff <= tolerance! };
}

/** Whether round 91963's archived app rewards fit inside the pool, within the rounding bound, as an issued split must. */
const appFitsThePool = () => dec(rt91963.app_rewards) <= pool! + tolerance!;

/** A series passes only if every check of it does. */
const passes: Record<RoundTotalsSeries, () => boolean> = {
  app_rewards_cc: () => on101404("app_rewards_cc").matches && appFitsThePool(),
  validator_rewards_cc: () => on101404("validator_rewards_cc").matches,
};

describe("round-totals is not the StartIssuing split, for either series", () => {
  it("reads round 101404's StartIssuing and the archived entries of rounds 101404 and 91963", () => {
    expect(capture).not.toBeNull();
    expect(rt101404.closed_round).toBe(101404);
    expect(rt91963.closed_round).toBe(91963);
    expect(format(tolerance!)).toBe("0.0004013886");
    expect(format(pool!)).toBe("112062.4048781259");
    // 236926.8131974476 featured-app coupons x 0.4729832110 CC per coupon.
    expect(capture!.summary.featuredAppCoupons).toBe("236926.8131974476");
    expect(capture!.rates.featuredApp).toBe("0.4729832110");
    const entry = text91963.slice(text91963.indexOf("[") + 1, text91963.lastIndexOf("]"));
    expect(createHash("sha256").update(entry, "utf8").digest("hex")).toBe(ENTRY_91963_SHA256);
  });

  it("round 101404's app rewards match its StartIssuing split: an observation, not a verification", () => {
    expect(on101404("app_rewards_cc")).toEqual({
      startIssuing: "112062.4048781259",
      roundTotals: "112062.4048694990",
      diff: "0.0000086269",
      matches: true,
    });
  });

  it("round 91963's archived app rewards exceed the pool a round issues, so they are not an issued split", () => {
    expect(rt91963.app_rewards).toBe("164472.2778527820");
    expect(format(dec(rt91963.app_rewards) - pool!)).toBe("52409.8729746561");
    expect(appFitsThePool()).toBe(false);
  });

  it("validator rewards do not match on round 101404: round-totals is 72.45% of the StartIssuing split", () => {
    // 104448.9262456018 validator coupons x 0.2 CC per coupon.
    expect(capture!.summary.validatorCoupons).toBe("104448.9262456018");
    expect(capture!.rates.validator).toBe("0.2000000000");
    const v = on101404("validator_rewards_cc");
    expect(v).toMatchObject({ startIssuing: "20889.7852491204", roundTotals: "15135.2289934293", matches: false });
    expect((Number(v.roundTotals) / Number(v.startIssuing)).toFixed(4)).toBe("0.7245");
  });

  it("config.ts verifies a series only when its checks pass, so neither is verified", () => {
    expect(Object.keys(ROUND_TOTALS_SERIES_VERIFIED).sort()).toEqual([...ROUND_TOTALS_SERIES].sort());
    for (const series of ROUND_TOTALS_SERIES) {
      expect(ROUND_TOTALS_SERIES_VERIFIED[series], series).toBe(passes[series]());
    }
  });
});
