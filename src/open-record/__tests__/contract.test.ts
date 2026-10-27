import { describe, expect, it } from "vitest";
import {
  COUPON_SERIES,
  CURSOR_BACKFILL,
  CURSOR_FORWARD,
  CURSOR_OVERRIDES,
  CURSOR_RENDER,
  CURSOR_SNAPSHOT,
  DAILY_COLUMNS,
  GAP_STATUSES,
  ISSUANCE_CATEGORIES,
  REASON_CODES,
  RECORD_SQLSTATE,
  REVISION_KINDS,
  SERIES,
  SERIES_NAMES,
  TRADEMARK_NOTICE,
  addDays,
  dayFilePath,
  DAY_FILE_RE,
  endOfDay,
  expectedFinalDate,
  finalByMs,
  isValidDate,
  sameFinalValue,
  settleDeadlineMs,
  settledDueDate,
} from "../contract";

describe("open record contract, schema 1.0.0", () => {
  it("publishes daily.csv columns in their published order", () => {
    expect(DAILY_COLUMNS).toEqual([
      "date", "status", "first_round", "last_round", "rounds", "supply_cc", "net_supply_change_cc",
      "reference_price_usd", "issuance_cc", "app_rewards_cc", "validator_rewards_cc", "sv_rewards_cc",
      "dev_fund_cc", "faucet_rewards_cc", "unfeatured_app_rewards_cc", "unclaimed_rewards_cc",
      "super_validators", "sv_voting_threshold", "featured_apps", "validator_licenses",
      "app_reward_coupons", "validator_reward_coupons",
      "method", "revision", "revised_at",
    ]);
  });

  it("publishes the StartIssuing coupon totals as decimals, apart from the issuance categories", () => {
    expect([...COUPON_SERIES]).toEqual(["app_reward_coupons", "validator_reward_coupons"]);
    for (const name of COUPON_SERIES) {
      const def = SERIES.find((s) => s.name === name);
      // Scan sums coupon amounts, which carry 10 decimal places: a count kind would round them away.
      expect(def?.kind, name).toBe("decimal");
      expect(def?.unit, name).toBe("coupons");
      expect(ISSUANCE_CATEGORIES as readonly string[], name).not.toContain(name);
    }
    expect(SERIES.find((s) => s.name === "app_reward_coupons")?.description).toContain("totalFeaturedAppRewardCoupons");
    expect(SERIES.find((s) => s.name === "validator_reward_coupons")?.description).toContain("totalValidatorRewardCoupons");
  });

  it("never reuses a column name of the earlier third-party tables", () => {
    for (const legacy of ["total_cc", "cc_price", "minted_cc", "validator_count", "total_parties"]) {
      expect(SERIES_NAMES).not.toContain(legacy);
    }
  });

  // Digital Asset's own two-sentence template, as the site footer states it. The open record states the same
  // words in datapackage.json and methodology.json, so a copy here is pinned.
  it("carries the trademark notice, word for word as the site footer does", () => {
    expect(TRADEMARK_NOTICE).toBe(
      "Canton is a registered trademark of Digital Asset (Switzerland) GmbH. Digital Asset is not affiliated with, and has not sponsored or endorsed, CCTools.",
    );
  });

  it("names the validator_licenses comparison by the provider's current name, Loop Data (formerly Lighthouse), by Five North", () => {
    const def = SERIES.find((s) => s.name === "validator_licenses");
    expect(def?.description).toContain("not the validator_count of Loop Data (formerly Lighthouse), by Five North");
    for (const s of SERIES) {
      expect(s.description.replace("Loop Data (formerly Lighthouse), by Five North", ""), s.name).not.toContain("Lighthouse");
    }
  });

  it("names the seven issuance categories that sum to issuance_cc", () => {
    expect([...ISSUANCE_CATEGORIES].sort()).toEqual(
      ["app_rewards_cc", "dev_fund_cc", "faucet_rewards_cc", "sv_rewards_cc",
        "unclaimed_rewards_cc", "unfeatured_app_rewards_cc", "validator_rewards_cc"].sort(),
    );
    for (const c of ISSUANCE_CATEGORIES) expect(SERIES_NAMES).toContain(c);
  });

  it("gives every series a unit and a description", () => {
    for (const s of SERIES) {
      expect(s.unit.length, s.name).toBeGreaterThan(0);
      expect(s.description.length, s.name).toBeGreaterThan(20);
    }
  });

  it("carries the published reason codes, gap statuses and revision kinds", () => {
    expect(REASON_CODES).toEqual([
      "not_collected", "source_unavailable", "source_not_available_before", "pending_past_deadline",
      "withdrawn", "not_derivable", "sources_disagree", "sanity_gate_failed", "round_missed",
    ]);
    expect(GAP_STATUSES).toEqual(["open", "backfill_planned", "permanent", "resolved"]);
    expect(REVISION_KINDS).toEqual(["backfill", "correction", "withdrawal", "method"]);
  });

  it("gives the two expected refusals valid SQLSTATEs of their own, never P0001", () => {
    const codes = Object.values(RECORD_SQLSTATE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      // Five digits or upper-case letters (Postgres rejects lower case), in a
      // class the SQL standard leaves to implementations (I to Z), not a class
      // code (ending 000), and not a class Postgres or PostgREST gives meaning:
      // P0 is PL/pgSQL, PT sets PostgREST's HTTP status, PG is PostgREST's own, XX internal.
      expect(code).toMatch(/^[I-Z][0-9A-Z]{4}$/);
      expect(code.endsWith("000")).toBe(false);
      expect(["P0", "PT", "PG", "XX"]).not.toContain(code.slice(0, 2));
    }
  });

  it("computes UTC day boundaries and the settle deadline", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(endOfDay("2026-10-05")).toBe("2026-10-06T00:00:00Z");
    expect(new Date(settleDeadlineMs("2026-10-05")).toISOString()).toBe("2026-10-06T02:00:00.000Z");
  });

  // Finalize may mark D final from the settle deadline, D+1 02:00, but the
  // public promise is final by D+1 03:00 UTC.
  it("promises a day final by D+1 03:00 UTC, one hour after its settle deadline", () => {
    expect(new Date(finalByMs("2026-10-05")).toISOString()).toBe("2026-10-06T03:00:00.000Z");
    expect(finalByMs("2026-10-05") - settleDeadlineMs("2026-10-05")).toBe(3_600_000);
    expect(expectedFinalDate(Date.parse("2026-10-06T03:00:00Z"))).toBe("2026-10-05");
    expect(expectedFinalDate(Date.parse("2026-10-06T02:59:59Z"))).toBe("2026-10-04");
    expect(expectedFinalDate(Date.parse("2026-10-06T02:00:00Z"))).toBe("2026-10-04");
  });

  // Finalize judges its due day at the settle cut, not at the public promise:
  // the 02:35 run settles D and pages before the 03:00 promise is broken.
  it("names the day finalize must have settled at D+1 02:00 UTC, an hour before the promise", () => {
    expect(settledDueDate(Date.parse("2026-10-06T02:00:00Z"))).toBe("2026-10-05");
    expect(settledDueDate(Date.parse("2026-10-06T02:35:00Z"))).toBe("2026-10-05");
    expect(settledDueDate(Date.parse("2026-10-06T01:59:59Z"))).toBe("2026-10-04");
    expect(settledDueDate(Date.parse("2026-10-06T02:35:00Z"))).not.toBe(expectedFinalDate(Date.parse("2026-10-06T02:35:00Z")));
    expect(settledDueDate(Date.parse("2026-10-06T03:35:00Z"))).toBe(expectedFinalDate(Date.parse("2026-10-06T03:35:00Z")));
  });

  // The ids name rows of scan_record_cursor: a renamed id orphans its row, and
  // two jobs sharing an id would overwrite each other's state.
  it("pins the scan_record_cursor ids, one row per writer", () => {
    const ids = [CURSOR_FORWARD, CURSOR_SNAPSHOT, CURSOR_RENDER, CURSOR_OVERRIDES, CURSOR_BACKFILL];
    expect(ids).toEqual(["forward", "snapshot", "render", "overrides", "backfill"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps a day to its file path and back", () => {
    expect(dayFilePath("2026-09-24")).toBe("days/2026-09-24.json");
    expect(DAY_FILE_RE.exec("days/2026-09-24.json")?.[1]).toBe("2026-09-24");
    expect(DAY_FILE_RE.test("days/2026-9-24.json")).toBe(false);
    expect(DAY_FILE_RE.test("days/../status.json")).toBe(false);
  });

  it("rejects impossible dates that DAY_FILE_RE lets through", () => {
    expect(DAY_FILE_RE.test("days/2026-02-30.json")).toBe(true);
    expect(isValidDate("2026-09-24")).toBe(true);
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-13-45")).toBe(false);
    expect(isValidDate("2026-9-24")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });

  it("compares final values as the revise RPC does: numerics at 10 places, null only equal to null", () => {
    expect(sameFinalValue(null, null)).toBe(true);
    expect(sameFinalValue(null, "0")).toBe(false);
    expect(sameFinalValue("0", null)).toBe(false);
    expect(sameFinalValue("1.50", "1.5")).toBe(true);
    expect(sameFinalValue("1.5000000000", "1.5")).toBe(true);
    expect(sameFinalValue("2", "2.0")).toBe(true);
    expect(sameFinalValue("0", "-0.0")).toBe(true);
    expect(sameFinalValue("-3.25", "-3.250")).toBe(true);
    expect(sameFinalValue("1.5", "1.6")).toBe(false);
    expect(sameFinalValue("-1.5", "1.5")).toBe(false);
    expect(sameFinalValue("1.0000000001", "1")).toBe(false);
    // Beyond double precision: string equality would fail, a double would merge them.
    expect(sameFinalValue("123456789012345678.1234567890", "123456789012345678.123456789")).toBe(true);
    expect(sameFinalValue("123456789012345678.1234567890", "123456789012345678.1234567891")).toBe(false);
  });

  it("rounds a computed value to the column's 10 places, half away from zero, before comparing", () => {
    expect(sameFinalValue("1.0000000000", "1.00000000004999")).toBe(true);
    expect(sameFinalValue("1.0000000001", "1.00000000005")).toBe(true);
    expect(sameFinalValue("-1.0000000001", "-1.00000000005")).toBe(true);
    expect(sameFinalValue("1.0000000000", "1.00000000005")).toBe(false);
  });

  it("refuses text that is not a plain decimal", () => {
    expect(() => sameFinalValue("abc", "1")).toThrow(/not a numeric value/);
    expect(() => sameFinalValue("1", "")).toThrow(/not a numeric value/);
    expect(() => sameFinalValue("1e3", "1000")).toThrow(/not a numeric value/);
  });
});
