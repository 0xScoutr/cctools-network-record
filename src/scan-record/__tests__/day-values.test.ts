import { describe, expect, it } from "vitest";
import { COUPON_SERIES, ISSUANCE_CATEGORIES, SERIES_NAMES, type SeriesName } from "../../open-record/contract";
import { ROUND_TOTALS_SERIES_VERIFIED } from "../config";
import { add, dec, format } from "../decimal";
import { computeDay, licensesGaveUpReason, licensesNotReadReason, resolveRange, type DayInputs } from "../day-values";
import { snapshotStageDate } from "../snapshot";
import { blankRound, type RoundRow } from "../store";
import {
  ALL_ROUND_TOTALS,
  HOST,
  NO_ROUND_TOTALS,
  SUPPLY_END,
  SUPPLY_START,
  capturedRound,
  dayOfRounds,
  neighboursOf,
  snapshotRow,
} from "./helpers/day-builders";

const DATE = "2026-10-05";

function inputs(over: Partial<DayInputs> = {}): DayInputs {
  const rounds = dayOfRounds(DATE, 200001);
  const snapshot = snapshotRow(DATE, 200140);
  const prevSnapshot = snapshotRow("2026-10-04", 200000);
  return {
    date: DATE,
    range: resolveRange(snapshot, prevSnapshot, rounds),
    roundsInRange: rounds,
    startedInDay: rounds,
    neighbours: neighboursOf(DATE, 200001),
    snapshot,
    prevSnapshot,
    prevValues: {},
    supply: { value: SUPPLY_END, source_host: HOST },
    prevSupply: { value: SUPPLY_START, source_host: HOST },
    collectorStartDate: "2026-10-02",
    roundTotalsVerified: NO_ROUND_TOTALS,
    licensesGaveUp: false,
    // Computed the morning after: the snapshot stage still works on the day.
    snapshotStageDate: snapshotStageDate(Date.parse("2026-10-06T00:35:00Z")),
    ...over,
  };
}

/** The series a day's round boundary decides. */
const ROUND_SERIES = ["first_round", "last_round", "rounds", ...ISSUANCE_CATEGORIES, "issuance_cc", ...COUPON_SERIES] as const;

const valueOf = (r: ReturnType<typeof computeDay>, s: SeriesName) => r.series[s].value;

describe("a value read from more than one host", () => {
  it("names every host its rounds came from, not just the first row's", () => {
    const base = inputs();
    const rows = base.roundsInRange.map((r, i) => (i === 0 ? { ...r, source_host: "scan.sv-1.global.canton.network.example.invalid" } : r));
    const r = computeDay({ ...base, roundsInRange: rows, startedInDay: rows });
    expect(r.series.app_rewards_cc.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
    expect(r.series.issuance_cc.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
  });

  it("credits a forward range to the rows it came from, not to a snapshot that did not give it", () => {
    const rounds = dayOfRounds(DATE, 200001).map((r, i) => (i === 0 ? { ...r, source_host: "scan.sv-1.global.canton.network.example.invalid" } : r));
    // A snapshot of the day stored without its last round: the range still comes from the rounds.
    const snapshot = { ...snapshotRow(DATE, 200140), last_round: null, source_host: "scan.sv-2.global.canton.network.example.invalid" };
    const r = computeDay(inputs({ snapshot, roundsInRange: rounds, startedInDay: rounds, range: resolveRange(snapshot, null, rounds) }));
    expect(r.series.first_round.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
    expect(r.series.last_round.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
    expect(r.series.rounds.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
  });

  it("credits first_round and rounds to both snapshots they are built from, and last_round to the day's own", () => {
    const base = inputs();
    const r = computeDay({ ...base, prevSnapshot: { ...(base.prevSnapshot as NonNullable<DayInputs["prevSnapshot"]>), source_host: "scan.sv-1.global.canton.network.example.invalid" } });
    expect(r.series.last_round.source_host).toBe(HOST);
    expect(r.series.first_round.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
    expect(r.series.rounds.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
  });

  it("names one host when one served them all", () => {
    expect(computeDay(inputs()).series.app_rewards_cc.source_host).toBe(HOST);
  });

  it("names both readings' hosts on the net supply change", () => {
    const r = computeDay(inputs({ prevSupply: { value: SUPPLY_START, source_host: "scan.sv-1.global.canton.network.example.invalid" } }));
    expect(r.series.net_supply_change_cc.source_host).toBe(`${HOST}, scan.sv-1.global.canton.network.example.invalid`);
    expect(r.series.supply_cc.source_host).toBe(HOST);
  });
});

describe("computeDay on a complete forward day", () => {
  const r = computeDay(inputs());

  it("assigns rounds by the ACS boundary and sums the issuance split", () => {
    expect(valueOf(r, "first_round")).toBe("200001");
    expect(valueOf(r, "last_round")).toBe("200140");
    expect(valueOf(r, "rounds")).toBe("140");
    expect(valueOf(r, "app_rewards_cc")).toBe("15688736.6808733274");
    expect(valueOf(r, "validator_rewards_cc")).toBe("1873305.5784408140");
    expect(valueOf(r, "unclaimed_rewards_cc")).toBe("2681488.9431211700");
    expect(valueOf(r, "issuance_cc")).toBe("26636225.2699264274");
  });

  it("sums the StartIssuing coupon totals of the day's rounds, with the rewards' provenance", () => {
    // 140 rounds of round 114513's summary: 203513.6207535227 and 66903.7706586005 coupons each.
    expect(valueOf(r, "app_reward_coupons")).toBe("28491906.9054931780");
    expect(valueOf(r, "validator_reward_coupons")).toBe("9366527.8922040700");
    for (const s of COUPON_SERIES) {
      expect(r.series[s], s).toMatchObject({
        method: "scan-1", source_host: HOST, as_of: r.series.app_rewards_cc.as_of, hold: null, gap: null,
      });
    }
  });

  it("reads the snapshot and supply series", () => {
    expect(valueOf(r, "super_validators")).toBe("13");
    expect(valueOf(r, "sv_voting_threshold")).toBe("9");
    expect(valueOf(r, "featured_apps")).toBe("127");
    expect(valueOf(r, "validator_licenses")).toBe("1400");
    expect(valueOf(r, "reference_price_usd")).toBe("0.1192960000");
    expect(valueOf(r, "supply_cc")).toBe("39690000000.5000000000");
    expect(valueOf(r, "net_supply_change_cc")).toBe("8465034.2541081825");
  });

  it("holds nothing and leaves no series without a value or a reason", () => {
    for (const s of SERIES_NAMES) {
      expect(r.series[s].hold, s).toBeNull();
      expect(r.series[s].value != null || r.series[s].gap != null, s).toBe(true);
    }
  });

  it("publishes issuance_cc as the sum of the seven published columns", () => {
    const rounds = dayOfRounds(DATE, 200001);
    // Past the 10th place, app rewards carry 0.24e-10 over the day. 0.3e-10 more on
    // validator rewards rounds every column down while their unrounded total rounds up.
    rounds[0] = {
      ...rounds[0],
      validator_rewards_cc: format(dec(rounds[0].validator_rewards_cc as string) + dec("0.00000000003"), 20),
    };
    const d = computeDay(inputs({ roundsInRange: rounds, startedInDay: rounds }));
    expect(d.series.issuance_cc.hold).toBeNull();
    const published = add(...ISSUANCE_CATEGORIES.map((k) => dec(d.series[k].value as string)));
    expect(d.series.issuance_cc.value).toBe(format(published));
    expect(d.series.issuance_cc.value).toBe("26636225.2699264274");
  });

  it("needs no neighbouring rounds when both ACS readings give the boundary", () => {
    const d = computeDay(inputs({ neighbours: { before: null, after: null } }));
    for (const s of ROUND_SERIES) expect(d.series[s].gap, s).toBeNull();
    expect(valueOf(d, "issuance_cc")).toBe("26636225.2699264274");
  });
});

describe("computeDay on a forward range, the ACS reading missing at one end", () => {
  // The range is then the lowest and highest round whose StartIssuing was captured in the day.
  const forward = (rounds: RoundRow[], over: Partial<DayInputs> = {}) =>
    inputs({ snapshot: null, roundsInRange: rounds, startedInDay: rounds, range: resolveRange(null, null, rounds), ...over });
  const { before, after } = neighboursOf(DATE, 200001);

  it("publishes the day when captured neighbours confirm both edges", () => {
    const r = computeDay(forward(dayOfRounds(DATE, 200001)));
    expect(valueOf(r, "first_round")).toBe("200001");
    expect(valueOf(r, "last_round")).toBe("200140");
    expect(valueOf(r, "issuance_cc")).toBe("26636225.2699264274");
    for (const s of ROUND_SERIES) expect(r.series[s].gap, s).toBeNull();
  });

  it("names a first round that was never captured instead of publishing the day one round short", () => {
    // Round 200001's open-round meta is stored, but its StartIssuing was neither captured nor repaired.
    const rounds = dayOfRounds(DATE, 200001).filter((x) => x.round !== 200001);
    const meta = { ...blankRound(200001, HOST), opens_at: "2026-10-04T23:40:00.000Z" };
    const r = computeDay(forward(rounds, { neighbours: { before: meta, after } }));
    for (const s of ROUND_SERIES) {
      expect(r.series[s], s).toMatchObject({
        value: null, hold: null, gap: { reason_code: "round_missed", status: "open", transient: true },
      });
      expect(r.series[s].gap?.reason, s).toContain("round 200001 has no captured StartIssuing before this day");
    }
  });

  it("names a last round that was never captured, which no contiguity gate of this day can see", () => {
    const rounds = dayOfRounds(DATE, 200001).filter((x) => x.round !== 200140);
    const r = computeDay(forward(rounds, { neighbours: { before, after: null } }));
    for (const s of ROUND_SERIES) {
      expect(r.series[s], s).toMatchObject({
        value: null, hold: null, gap: { reason_code: "round_missed", status: "open", transient: true },
      });
      expect(r.series[s].gap?.reason, s).toContain("round 200140 has no captured StartIssuing after this day");
    }
  });

  it("takes the previous day's last_round as the left edge when that round's row is not read", () => {
    const r = computeDay(forward(dayOfRounds(DATE, 200001), {
      neighbours: { before: null, after },
      prevValues: { last_round: "200000.0000000000" },
    }));
    expect(valueOf(r, "first_round")).toBe("200001");
    expect(valueOf(r, "issuance_cc")).toBe("26636225.2699264274");
  });

  it("names both a missed round inside the range and the unconfirmed edge", () => {
    const rounds = dayOfRounds(DATE, 200001).filter((x) => x.round !== 200070);
    const r = computeDay(forward(rounds, { neighbours: { before, after: null } }));
    expect(r.series.app_rewards_cc.gap).toMatchObject({ reason_code: "round_missed", transient: true });
    expect(r.series.app_rewards_cc.gap?.reason).toContain("Rounds not captured: 200070");
    expect(r.series.app_rewards_cc.gap?.reason).toContain("round 200141 has no captured StartIssuing after this day");
  });

  it("does not call rounds before the forward collector started missed", () => {
    // The collector's first run was at 06:00 on the day before its first full day.
    const rounds = dayOfRounds(DATE, 200001).slice(36);
    const r = computeDay(forward(rounds, { neighbours: { before: null, after }, collectorStartDate: "2026-10-06" }));
    for (const s of ROUND_SERIES) {
      expect(r.series[s], s).toMatchObject({
        value: null, hold: null, gap: { reason_code: "not_collected", status: "backfill_planned", transient: false },
      });
    }
    expect(r.series.first_round.gap?.reason).toContain("round 200036");
  });
});

describe("computeDay gaps and gates", () => {
  it("names a missed round on a forward day, without guessing the split", () => {
    const rounds = dayOfRounds(DATE, 200001).filter((x) => x.round !== 200070);
    const r = computeDay(inputs({ roundsInRange: rounds, startedInDay: rounds }));
    expect(r.series.app_rewards_cc).toMatchObject({ value: null, gap: { reason_code: "round_missed", transient: true } });
    expect(r.series.app_rewards_cc.gap?.reason).toContain("200070");
    expect(r.series.issuance_cc.value).toBeNull();
    expect(r.series.rounds.value).toBe("140");
    for (const s of COUPON_SERIES) {
      expect(r.series[s], s).toMatchObject({ value: null, gap: { reason_code: "round_missed", transient: true } });
      expect(r.series[s].gap?.reason, s).toContain("200070");
    }
  });

  it("uses the round-totals archive only when its meaning check passed", () => {
    const rt: RoundRow[] = dayOfRounds("2026-05-01", 95001).map((x) => ({
      ...capturedRound(x.round, null), method: "scan-rt-1" as const, closed_at: "2026-05-01T12:00:00Z",
      sv_rewards_cc: null, dev_fund_cc: null, faucet_rewards_cc: null, unfeatured_app_rewards_cc: null,
      unclaimed_rewards_cc: null, split: null,
    }));
    const base = {
      date: "2026-05-01", roundsInRange: rt, startedInDay: [],
      snapshot: snapshotRow("2026-05-01", 95140, { validator_licenses: null }),
      prevSnapshot: snapshotRow("2026-04-30", 95000),
      range: { first: 95001, last: 95140, source: "snapshot" as const },
      supply: null, prevSupply: null,
    };
    const verified = computeDay(inputs({ ...base, roundTotalsVerified: ALL_ROUND_TOTALS }));
    expect(verified.series.app_rewards_cc).toMatchObject({ value: "15688736.6808733274", method: "scan-rt-1" });
    expect(verified.series.validator_rewards_cc).toMatchObject({ value: "1873305.5784408140", method: "scan-rt-1" });
    expect(verified.series.sv_rewards_cc.gap).toMatchObject({ reason_code: "source_not_available_before", status: "backfill_planned" });
    expect(verified.series.validator_licenses.gap).toMatchObject({ reason_code: "not_collected", transient: false });
    expect(verified.series.supply_cc.gap).toMatchObject({ reason_code: "source_not_available_before" });

    const unverified = computeDay(inputs({ ...base, roundTotalsVerified: NO_ROUND_TOTALS }));
    for (const s of ["app_rewards_cc", "validator_rewards_cc"] as const) {
      expect(unverified.series[s].gap, s).toMatchObject({ reason_code: "not_collected", status: "backfill_planned" });
      expect(unverified.series[s].gap?.reason, s).not.toContain("round-totals");
    }

    // The archive carries no coupon totals: a backfill day names them not collected, never zero.
    for (const d of [verified, unverified]) {
      for (const s of COUPON_SERIES) {
        expect(d.series[s], s).toMatchObject({
          value: null, hold: null, gap: { reason_code: "not_collected", status: "backfill_planned", transient: false },
        });
        expect(d.series[s].gap?.reason, s).toContain("Before the forward collector started on 2026-10-02");
      }
    }
  });

  it("publishes nothing from the round-totals archive under the verification config.ts holds", () => {
    // Rows carrying both archived figures: whatever an import stored, the flags decide.
    const rt: RoundRow[] = dayOfRounds("2026-05-01", 95001).map((x) => ({
      ...capturedRound(x.round, null), method: "scan-rt-1" as const, closed_at: "2026-05-01T12:00:00Z",
      sv_rewards_cc: null, dev_fund_cc: null, faucet_rewards_cc: null, unfeatured_app_rewards_cc: null,
      unclaimed_rewards_cc: null, split: null,
    }));
    const d = computeDay(inputs({
      date: "2026-05-01", roundsInRange: rt, startedInDay: [],
      snapshot: snapshotRow("2026-05-01", 95140), prevSnapshot: snapshotRow("2026-04-30", 95000),
      range: { first: 95001, last: 95140, source: "snapshot" },
      supply: null, prevSupply: null,
      roundTotalsVerified: ROUND_TOTALS_SERIES_VERIFIED,
    }));
    for (const s of SERIES_NAMES) expect(d.series[s].method, s).toBe("scan-1");
    for (const s of ["app_rewards_cc", "validator_rewards_cc"] as const) {
      expect(d.series[s], s).toMatchObject({
        value: null, gap: { reason_code: "not_collected", status: "backfill_planned", transient: false },
      });
    }
  });

  it("publishes only the verified series of the archive: validator rewards stay blank with their reason, never zero", () => {
    // A hypothetical config verifying app rewards only (config.ts verifies
    // neither): what an import would write then (validator null), and rows
    // that carry both figures. The flag decides, not what is stored.
    const archived = (withValidator: boolean): RoundRow[] => dayOfRounds("2026-05-01", 95001).map((x) => ({
      ...capturedRound(x.round, null), method: "scan-rt-1" as const, closed_at: "2026-05-01T12:00:00Z",
      validator_rewards_cc: withValidator ? x.validator_rewards_cc : null,
      sv_rewards_cc: null, dev_fund_cc: null, faucet_rewards_cc: null, unfeatured_app_rewards_cc: null,
      unclaimed_rewards_cc: null, split: null,
    }));
    for (const rows of [archived(false), archived(true)]) {
      const d = computeDay(inputs({
        date: "2026-05-01", roundsInRange: rows, startedInDay: [],
        snapshot: snapshotRow("2026-05-01", 95140), prevSnapshot: snapshotRow("2026-04-30", 95000),
        range: { first: 95001, last: 95140, source: "snapshot" },
        supply: null, prevSupply: null,
        roundTotalsVerified: { app_rewards_cc: true, validator_rewards_cc: false },
      }));
      expect(d.series.app_rewards_cc).toMatchObject({
        value: "15688736.6808733274", method: "scan-rt-1", source_host: HOST, as_of: "2026-05-01T12:00:00Z", hold: null, gap: null,
      });
      expect(d.series.validator_rewards_cc).toMatchObject({
        value: null, method: "scan-1", source_host: null, as_of: null, hold: null,
        gap: { reason_code: "not_collected", status: "backfill_planned", transient: false },
      });
      expect(d.series.validator_rewards_cc.gap?.reason).toBe(
        "Before the forward collector started on 2026-10-02; the update-stream backfill is planned. " +
          "The round-totals archive's figure for this series did not match the StartIssuing split when checked, so it is not published",
      );
      // The series the archive never carries keep their own reasons.
      expect(d.series.sv_rewards_cc.gap).toMatchObject({ reason_code: "source_not_available_before", status: "backfill_planned" });
      expect(d.series.issuance_cc.value).toBeNull();
      expect(d.series.validator_reward_coupons.gap).toMatchObject({ reason_code: "not_collected" });
    }

    // On a forward day, archive rows stand where no StartIssuing was captured: the unverified series names the missed rounds.
    const forward = computeDay(inputs({
      date: "2026-05-01", roundsInRange: archived(true), startedInDay: [],
      snapshot: snapshotRow("2026-05-01", 95140), prevSnapshot: snapshotRow("2026-04-30", 95000),
      range: { first: 95001, last: 95140, source: "snapshot" },
      supply: null, prevSupply: null, collectorStartDate: "2026-04-01",
      roundTotalsVerified: { app_rewards_cc: true, validator_rewards_cc: false },
    }));
    expect(forward.series.app_rewards_cc).toMatchObject({ value: "15688736.6808733274", method: "scan-rt-1" });
    expect(forward.series.validator_rewards_cc).toMatchObject({
      value: null, method: "scan-1", gap: { reason_code: "round_missed", status: "open", transient: true },
    });
    expect(forward.series.validator_rewards_cc.gap?.reason).toBe(
      "Rounds not captured: 95001, 95002, 95003, 95004, 95005 and 135 more. " +
        "The round-totals archive's figure for this series did not match the StartIssuing split when checked, so it is not published",
    );
  });

  it("publishes no coupon totals for a day before the collector started, even with its boundary read", () => {
    const r = computeDay(inputs({
      date: "2026-05-01", roundsInRange: [], startedInDay: [],
      snapshot: snapshotRow("2026-05-01", 95140), prevSnapshot: snapshotRow("2026-04-30", 95000),
      range: { first: 95001, last: 95140, source: "snapshot" },
      supply: null, prevSupply: null,
    }));
    expect(valueOf(r, "rounds")).toBe("140");
    for (const s of COUPON_SERIES) {
      expect(r.series[s], s).toMatchObject({ value: null, gap: { reason_code: "not_collected", status: "backfill_planned" } });
    }
  });

  it("gives the coupon totals the day's gap when no round boundary is known", () => {
    const r = computeDay(inputs({ range: null, snapshot: null, roundsInRange: [], startedInDay: [] }));
    for (const s of COUPON_SERIES) {
      expect(r.series[s], s).toMatchObject({ value: null, gap: { reason_code: "source_unavailable", transient: true } });
    }
  });

  it("holds the round series when the count or the contiguity is wrong", () => {
    const short = dayOfRounds(DATE, 200001, 119);
    const r1 = computeDay(inputs({
      roundsInRange: short, startedInDay: short, snapshot: null,
      range: resolveRange(null, null, short), neighbours: neighboursOf(DATE, 200001, 119),
    }));
    expect(r1.series.rounds.hold).toContain("119");

    const r2 = computeDay(inputs({
      snapshot: null, range: resolveRange(null, null, dayOfRounds(DATE, 200001)),
      prevValues: { last_round: "199990.0000000000" },
    }));
    expect(r2.series.first_round.hold).toContain("199990");
    expect(r2.series.app_rewards_cc.hold).not.toBeNull();
    for (const s of COUPON_SERIES) expect(r2.series[s].hold, s).toBe(r2.series.app_rewards_cc.hold);
  });

  it("flags a StartIssuing time that disagrees with the ACS boundary", () => {
    const rounds = dayOfRounds(DATE, 200001);
    rounds[139] = capturedRound(200140, "2026-10-06T00:01:00Z");
    const r = computeDay(inputs({ roundsInRange: rounds }));
    expect(r.series.last_round.gap).toMatchObject({ reason_code: "sources_disagree" });
    expect(r.series.last_round.hold).toContain("200140");
  });

  it("fails the per-round issuance gate on a wrong split", () => {
    const rounds = dayOfRounds(DATE, 200001);
    rounds[10] = { ...rounds[10], unclaimed_rewards_cc: "0" };
    const r = computeDay(inputs({ roundsInRange: rounds, startedInDay: rounds }));
    expect(r.series.issuance_cc.hold).toContain("round 200011");
    expect(r.series.app_rewards_cc.gap?.reason_code).toBe("sanity_gate_failed");
    // Held like the rewards they price: kept, provisional and alerted, never a confident number.
    for (const s of COUPON_SERIES) {
      expect(r.series[s].gap?.reason_code, s).toBe("sanity_gate_failed");
      expect(r.series[s].value, s).not.toBeNull();
      expect(r.series[s].hold, s).toContain("round 200011");
    }
  });

  it("holds a frozen supply and a count that jumps", () => {
    const frozen = computeDay(inputs({ prevSupply: { value: SUPPLY_END, source_host: HOST } }));
    expect(frozen.series.supply_cc.hold).toContain("unchanged");
    expect(frozen.series.net_supply_change_cc.hold).not.toBeNull();

    const jump = computeDay(inputs({ prevValues: { featured_apps: "100.0000000000" } }));
    expect(jump.series.featured_apps.hold).toContain("from 100 to 127");

    const zero = computeDay(inputs({ snapshot: snapshotRow(DATE, 200140, { super_validators: 0 }) }));
    expect(zero.series.super_validators.hold).toContain("is 0");
  });

  it("explains the supply edge of 2026-09-02 and warns on a negative net change", () => {
    const edge = computeDay(inputs({ date: "2026-09-02", prevSupply: null }));
    expect(edge.series.net_supply_change_cc.gap).toMatchObject({ reason_code: "source_not_available_before" });
    expect(edge.series.net_supply_change_cc.gap?.reason).toContain("2026-09-01");

    const down = computeDay(inputs({ supply: { value: SUPPLY_START, source_host: HOST }, prevSupply: { value: SUPPLY_END, source_host: HOST } }));
    expect(down.series.net_supply_change_cc.value).toBe("-8465034.2541081825");
    expect(down.series.net_supply_change_cc.hold).toBeNull();
    expect(down.warnings.join(" ")).toContain("negative");
  });

  it("reports an unread snapshot as transient", () => {
    const r = computeDay(inputs({ snapshot: null }));
    expect(r.series.super_validators.gap).toMatchObject({ reason_code: "source_unavailable", transient: true });
  });

  it("names a license count the snapshot stage gave up on, apart from one not read yet", () => {
    const snapshot = snapshotRow(DATE, 200140, { validator_licenses: null });
    const waiting = computeDay(inputs({ snapshot }));
    expect(waiting.series.validator_licenses.gap).toMatchObject({ reason_code: "source_unavailable", status: "open", transient: true });
    // The snapshot's core series are published, so the reason names the pending count, not an unread snapshot.
    expect(waiting.series.validator_licenses.gap?.reason).toContain("ValidatorLicense count");
    expect(waiting.series.validator_licenses.gap?.reason).not.toContain("snapshot at the end of this day has not been read");

    const gaveUp = computeDay(inputs({ snapshot, licensesGaveUp: true }));
    expect(gaveUp.series.validator_licenses).toMatchObject({
      value: null,
      source_host: null,
      as_of: null,
      gap: { reason_code: "source_unavailable", reason: licensesGaveUpReason(DATE), status: "backfill_planned", transient: false },
    });
    expect(licensesGaveUpReason(DATE)).toContain("2026-10-06T00:00:00Z");
    // The core series of the same snapshot are published.
    expect(gaveUp.series.featured_apps.value).toBe("127");
    expect(gaveUp.series.super_validators.value).toBe("13");

    // A day with no snapshot row has no license read to give up: it stays unread.
    const unread = computeDay(inputs({ snapshot: null, licensesGaveUp: true }));
    expect(unread.series.validator_licenses.gap?.reason).not.toBe(licensesGaveUpReason(DATE));
  });

  it("stops calling a license count pending once the snapshot stage has moved past the day", () => {
    // A row the backfill stored: it never reads ValidatorLicense, and the forward
    // stage reads only yesterday, so the daily stage does not read this count any more.
    const snapshot = snapshotRow(DATE, 200140, { validator_licenses: null });
    // From 00:00 two days after, the stage works on the next day.
    const movedOn = snapshotStageDate(Date.parse("2026-10-07T00:00:00Z"));
    const later = computeDay(inputs({ snapshot, snapshotStageDate: movedOn }));
    expect(later.series.validator_licenses).toMatchObject({
      value: null,
      source_host: null,
      as_of: null,
      gap: { reason_code: "source_unavailable", reason: licensesNotReadReason(DATE), status: "backfill_planned", transient: false },
    });
    expect(licensesNotReadReason(DATE)).toContain("2026-10-06T00:00:00Z");
    expect(later.series.featured_apps.value).toBe("127");

    // Up to the end of the day after, the stage still works on the day and may read the count.
    const waiting = computeDay(inputs({ snapshot, snapshotStageDate: snapshotStageDate(Date.parse("2026-10-06T23:59:59Z")) }));
    expect(waiting.series.validator_licenses.gap).toMatchObject({ status: "open", transient: true });

    // A count the stage gave up on keeps its own reason.
    const gaveUp = computeDay(inputs({ snapshot, licensesGaveUp: true, snapshotStageDate: movedOn }));
    expect(gaveUp.series.validator_licenses.gap?.reason).toBe(licensesGaveUpReason(DATE));

    // With no row yet, the backfill can still store the core series, never the count.
    const noRow = computeDay(inputs({ snapshot: null, snapshotStageDate: movedOn }));
    expect(noRow.series.validator_licenses.gap).toMatchObject({ reason: licensesNotReadReason(DATE), transient: false });
    expect(noRow.series.super_validators.gap).toMatchObject({ reason_code: "source_unavailable", transient: true });
  });

  it("names the rounds a backfilled day before the collector lacks, instead of calling it not collected", () => {
    const all = dayOfRounds("2026-07-10", 95001);
    const read = all.filter((r) => r.round !== 95050 && r.round !== 95051);
    const r = computeDay(inputs({
      date: "2026-07-10", roundsInRange: read, startedInDay: read,
      snapshot: snapshotRow("2026-07-10", 95140), prevSnapshot: snapshotRow("2026-07-09", 95000),
      range: { first: 95001, last: 95140, source: "snapshot" },
      supply: null, prevSupply: null,
    }));
    for (const s of [...ISSUANCE_CATEGORIES, "issuance_cc", ...COUPON_SERIES] as SeriesName[]) {
      expect(r.series[s], s).toMatchObject({
        value: null, hold: null, gap: { reason_code: "round_missed", status: "backfill_planned", transient: false },
      });
      expect(r.series[s].gap?.reason, s).toBe("Rounds not captured: 95050, 95051");
    }
  });
});

describe("computeDay provenance", () => {
  it("never emits a value, held or not, without its source host and as_of", () => {
    const rounds = dayOfRounds(DATE, 200001);
    const scenarios = [
      inputs(),
      inputs({ snapshot: null }),
      inputs({ prevValues: { featured_apps: "100.0000000000" } }),
      inputs({ snapshot: null, range: resolveRange(null, null, rounds) }),
      inputs({ snapshot: null, range: resolveRange(null, null, rounds), neighbours: { before: null, after: null } }),
      inputs({ snapshot: snapshotRow(DATE, 200140, { validator_licenses: null }), snapshotStageDate: "2026-10-06" }),
      inputs({ supply: { value: SUPPLY_START, source_host: HOST }, prevSupply: { value: SUPPLY_END, source_host: HOST } }),
    ];
    for (const inp of scenarios) {
      const r = computeDay(inp);
      for (const s of SERIES_NAMES) {
        if (r.series[s].value == null) continue;
        expect(r.series[s].source_host, s).toBeTruthy();
        expect(r.series[s].as_of, s).toBeTruthy();
      }
    }
  });

  it("gives the round counts a gap, not a value with a null host, when no source names the boundary", () => {
    const r = computeDay(inputs({
      snapshot: null, roundsInRange: [], startedInDay: [],
      range: { first: 200001, last: 200140, source: "forward" },
    }));
    for (const s of ["first_round", "last_round", "rounds"] as const) {
      expect(r.series[s]).toMatchObject({
        value: null, source_host: null, as_of: null, gap: { reason_code: "source_unavailable", transient: true },
      });
    }
  });
});
