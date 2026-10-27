/**
 * Whether each /v0/round-totals series means the same thing as the
 * StartIssuing split, per series. Only a verified series would be published
 * from the archive (method scan-rt-1, day-values.ts) and written by its
 * import, which refuses to write anything while none is. The values live in
 * round-totals-verified.json, a plain JSON file that this module and an
 * import script without TypeScript can both read, so the two cannot disagree.
 *
 * Neither series is verified, so nothing from the archive is imported or
 * published. The meaning check:
 *   app_rewards_cc        Round 101404 matched on 2026-09-30 (StartIssuing
 *                         112062.4048781259, round-totals 112062.4048694990,
 *                         off by 0.0000086269, inside the rounding bound of
 *                         0.0004013886), but only because every coupon of
 *                         that round was collected in it. The archive
 *                         (2026-10-01) carries app rewards above the
 *                         featured-app pool a round issues (112062.4048781259,
 *                         saturated) by more than that bound in 4,139 of the
 *                         12,583 rounds of the import span: round 91963 has
 *                         164472.2778527820. An issued split never exceeds
 *                         its pool, so round-totals is not the issued split;
 *                         the data is consistent with rewards collected in a
 *                         round (an inference, not read from the Splice code).
 *   validator_rewards_cc  Round 101404: StartIssuing 20889.7852491204
 *                         (104448.9262456018 coupons x 0.2), round-totals
 *                         15135.2289934293, 72.45% of it.
 * Both stay false until a check passes; the meaning test fails unless each
 * series here is true exactly when its checks pass.
 *
 * Before a series is ever set true, two things need handling first. The
 * per-series branch of day-values publishes a day of archive rows only when
 * every row carries every verified series (fromTotals): rows an import
 * stored with a series null, unverified at the time, turn that day blank
 * (and a final value published from it into a conflict) once the series is
 * set true, and the import never writes over a stored round, so it cannot
 * fill them. And the scan-rt-1 line of the Methodology
 * (open-record/methodology.ts) changes with it; methodology.test.ts fails
 * until it does.
 */
import verified from "./round-totals-verified.json";

/** The archive's series: each is a network_record_rounds column and a record series of the same name. */
export const ROUND_TOTALS_SERIES = ["app_rewards_cc", "validator_rewards_cc"] as const;
export type RoundTotalsSeries = (typeof ROUND_TOTALS_SERIES)[number];
export type RoundTotalsVerification = Readonly<Record<RoundTotalsSeries, boolean>>;

export const ROUND_TOTALS_SERIES_VERIFIED: RoundTotalsVerification = verified;
