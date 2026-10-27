import { describe, expect, it } from "vitest";
import { CURSOR_FORWARD, CURSOR_OVERRIDES, CURSOR_SNAPSHOT, RECORD_SQLSTATE, SERIES_NAMES } from "../../open-record/contract";
import { licensesGaveUpReason, licensesNotReadReason } from "../day-values";
import { finalizeDate, runFinalize } from "../finalize";
import { SNAPSHOT_RETRY } from "../snapshot";
import { RecordStoreError, type ValueWrite } from "../store";
import {
  ALL_ROUND_TOTALS,
  HOST,
  NO_ROUND_TOTALS,
  SUPPLY_END,
  SUPPLY_START,
  dayOfRounds,
  neighboursOf,
  snapshotRow,
} from "./helpers/day-builders";
import { memoryStore } from "./helpers/memory-store";

const DATE = "2026-10-05";

function seeded() {
  const m = memoryStore();
  for (const r of dayOfRounds(DATE, 200001)) m.state.rounds.set(r.round, r);
  m.state.snapshots.set("2026-10-04", snapshotRow("2026-10-04", 200000));
  m.state.snapshots.set(DATE, snapshotRow(DATE, 200140));
  m.state.supply.set("2026-10-05T00:00:00Z", SUPPLY_START);
  m.state.supply.set("2026-10-06T00:00:00Z", SUPPLY_END);
  m.state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 200140, last_date: null, last_poll_at: null, detail: { started_at: "2026-10-01T12:00:00Z" } });
  return m;
}
const ctx = {
  roundTotalsVerified: NO_ROUND_TOTALS,
  collectorStartDate: "2026-10-02",
  releasedHolds: new Map<string, string[]>(),
  keptFinals: new Set<string>(),
};
/** release_holds as loaded: DATE|series to the one value a human checked. */
const releasing = (series: string, checked: string) => new Map([[`${DATE}|${series}`, [checked]]]);
const at = (iso: string) => new Date(iso);
const value = (m: ReturnType<typeof memoryStore>, s: string) => m.state.values.get(`${DATE}|${s}`);

describe("finalizeDate", () => {
  it("writes a provisional row by 01:00 and marks the record dirty", async () => {
    const m = seeded();
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T00:35:00Z"), ...ctx });
    expect(r.series.app_rewards_cc.state).toBe("provisional");
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: "15688736.6808733274", status: "provisional", finalized_at: null });
    expect(m.state.dirtyAt).toBe("2026-10-06T00:35:00.000Z");
  });

  it("finalizes after 02:00, then a repeat run changes nothing", async () => {
    const m = seeded();
    const first = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    expect(first.series.issuance_cc.state).toBe("final");
    expect(value(m, "issuance_cc")).toMatchObject({ status: "final", finalized_at: "2026-10-06T02:35:00.000Z" });
    m.state.dirtyAt = null;
    const again = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    expect(again.wrote).toBe(0);
    expect(m.state.dirtyAt).toBeNull();
  });

  it("keeps a missed round provisional until the deadline, then finalizes the null with its reason", async () => {
    const m = seeded();
    m.state.rounds.delete(200070);
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T00:35:00Z"), ...ctx });
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: null, status: "provisional" });
    expect(m.state.gaps.find((g) => g.series === "app_rewards_cc")).toMatchObject({ reason_code: "round_missed", status: "open" });

    const late = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    expect(late.series.app_rewards_cc).toMatchObject({ state: "final_null", gap_code: "round_missed" });
    expect(value(m, "app_rewards_cc")?.status).toBe("final");
    expect(m.state.gaps.find((g) => g.series === "app_rewards_cc")?.status).toBe("backfill_planned");
  });

  it("fills a final null through a logged backfill revision when the data arrives", async () => {
    const m = seeded();
    const missing = m.state.rounds.get(200070)!;
    m.state.rounds.delete(200070);
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    m.state.rounds.set(200070, missing);

    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    expect(r.series.app_rewards_cc.state).toBe("revised");
    // The gap's row had no provenance: the backfill publishes the computed host and as_of.
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: "15688736.6808733274", revision: 1, source_host: HOST });
    expect(value(m, "app_rewards_cc")?.as_of).not.toBeNull();
    // The seven categories, issuance_cc and the two coupon totals: every series summed over the rounds.
    expect(m.state.revisions.filter((x) => x.kind === "backfill")).toHaveLength(10);
    expect(m.state.gaps.find((g) => g.series === "app_rewards_cc")?.resolved_at).not.toBeNull();
  });

  it("leaves a withdrawn series alone: no value write, no backfill, no gap resolution", async () => {
    const m = seeded();
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    await m.store.revise(DATE, "app_rewards_cc", null, "withdrawal", "The source served a split that does not add up");
    m.state.dirtyAt = null;

    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    expect(r.series.app_rewards_cc).toMatchObject({ state: "final_null", gap_code: "withdrawn" });
    expect(r.wrote).toBe(0);
    expect(m.state.dirtyAt).toBeNull();
    // A withdrawn row carries no provenance, like a gap's row.
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: null, status: "final", revision: 1, source_host: null, as_of: null });
    expect(m.state.revisions.map((x) => x.kind)).toEqual(["withdrawal"]);
    expect(m.state.gaps.filter((g) => g.series === "app_rewards_cc")).toMatchObject([
      { reason_code: "withdrawn", status: "open", resolved_at: null },
    ]);
  });

  it("restores a withdrawn value only through a correction that names its source host and as_of", async () => {
    const m = seeded();
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    const published = value(m, "app_rewards_cc")!;
    await m.store.revise(DATE, "app_rewards_cc", null, "withdrawal", "The split is under review");

    // The withdrawn row has no provenance to keep, so a correction without it is refused.
    await expect(m.store.revise(DATE, "app_rewards_cc", published.value, "correction", "Split checked")).rejects.toMatchObject({
      code: "P0001",
    });
    await m.store.revise(DATE, "app_rewards_cc", published.value, "correction", "Split checked", HOST, published.as_of);
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: published.value, revision: 2, source_host: HOST, as_of: published.as_of });

    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    expect(r.series.app_rewards_cc.state).toBe("final");
    expect(m.state.revisions.map((x) => x.kind)).toEqual(["withdrawal", "correction"]);
    expect(m.state.gaps.find((g) => g.series === "app_rewards_cc" && g.reason_code === "withdrawn")?.resolved_at).not.toBeNull();
  });

  it("settles a final value whose value is unchanged when only its method would change, and logs no revision", async () => {
    // Finalized from the verified round-totals archive (scan-rt-1), then the
    // StartIssuing captures arrive (scan-1) with the same app and validator sums.
    const m = seeded();
    const scan1 = dayOfRounds(DATE, 200001);
    for (const r of scan1) {
      m.state.rounds.set(r.round, {
        ...r, method: "scan-rt-1", start_issuing_at: null, closed_at: "2026-10-05T12:00:00Z", split: null,
        sv_rewards_cc: null, dev_fund_cc: null, faucet_rewards_cc: null, unfeatured_app_rewards_cc: null, unclaimed_rewards_cc: null,
      });
    }
    const verified = { ...ctx, roundTotalsVerified: ALL_ROUND_TOTALS };
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...verified });
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: "15688736.6808733274", status: "final", method: "scan-rt-1" });

    for (const r of scan1) m.state.rounds.set(r.round, r);
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...verified });
    expect(r.series.app_rewards_cc.state).toBe("final");
    expect(r.series.validator_rewards_cc.state).toBe("final");
    expect(value(m, "app_rewards_cc")).toMatchObject({ method: "scan-rt-1", revision: 0 });
    expect(m.state.revisions.filter((x) => x.series === "app_rewards_cc" || x.series === "validator_rewards_cc")).toEqual([]);
    // The series the archive could not carry were final nulls labelled
    // scan-rt-1, and are filled by backfills labelled with the method of the
    // value they publish, on the row and in the log.
    expect(r.series.sv_rewards_cc.state).toBe("revised");
    expect(value(m, "sv_rewards_cc")).toMatchObject({ method: "scan-1", revision: 1 });
    const backfills = m.state.revisions.filter((x) => x.kind === "backfill");
    expect(backfills.map((x) => x.series).sort()).toEqual(
      ["app_reward_coupons", "dev_fund_cc", "faucet_rewards_cc", "issuance_cc", "sv_rewards_cc", "unclaimed_rewards_cc",
        "unfeatured_app_rewards_cc", "validator_reward_coupons"],
    );
    for (const x of backfills) {
      expect(x.method, x.series).toBe("scan-1");
      expect(value(m, x.series)?.method, x.series).toBe("scan-1");
    }
  });

  it("labels a backfill of round-totals sums scan-rt-1, not with the method of the null it fills", async () => {
    // A day before the collector: finalized as not_collected nulls (scan-1).
    // Then the verified round-totals archive carries its app and
    // validator sums.
    const m = seeded();
    m.state.rounds.clear();
    const early = { ...ctx, roundTotalsVerified: ALL_ROUND_TOTALS, collectorStartDate: "2026-10-06" };
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...early });
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: null, status: "final", method: "scan-1" });

    for (const r of dayOfRounds(DATE, 200001)) {
      m.state.rounds.set(r.round, {
        ...r, method: "scan-rt-1", start_issuing_at: null, closed_at: "2026-10-05T12:00:00Z", split: null,
        sv_rewards_cc: null, dev_fund_cc: null, faucet_rewards_cc: null, unfeatured_app_rewards_cc: null, unclaimed_rewards_cc: null,
      });
    }
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...early });
    expect(r.series.app_rewards_cc.state).toBe("revised");
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: "15688736.6808733274", method: "scan-rt-1", revision: 1 });
    expect(value(m, "validator_rewards_cc")).toMatchObject({ method: "scan-rt-1", revision: 1 });
    expect(m.state.revisions.map((x) => [x.series, x.kind, x.method])).toEqual([
      ["app_rewards_cc", "backfill", "scan-rt-1"],
      ["validator_rewards_cc", "backfill", "scan-rt-1"],
    ]);
    // The archive carries no coupon totals: they stay final nulls, not collected, never zero.
    for (const series of ["app_reward_coupons", "validator_reward_coupons"] as const) {
      expect(value(m, series), series).toMatchObject({ value: null, status: "final", revision: 0 });
      expect(m.state.gaps.filter((g) => g.series === series && g.resolved_at == null), series).toMatchObject([
        { reason_code: "not_collected", status: "backfill_planned" },
      ]);
    }
  });

  it("finalizes an archive day from its verified series only: validator rewards a final null with their reason", async () => {
    // A day before the collector whose rounds an import stored with app
    // rewards only, under a hypothetical config verifying app rewards alone
    // (config.ts verifies neither).
    const m = seeded();
    m.state.rounds.clear();
    for (const r of dayOfRounds(DATE, 200001)) {
      m.state.rounds.set(r.round, {
        ...r, method: "scan-rt-1", start_issuing_at: null, closed_at: "2026-10-05T12:00:00Z", split: null, validator_rewards_cc: null,
        sv_rewards_cc: null, dev_fund_cc: null, faucet_rewards_cc: null, unfeatured_app_rewards_cc: null, unclaimed_rewards_cc: null,
      });
    }
    const appOnly = { ...ctx, roundTotalsVerified: { app_rewards_cc: true, validator_rewards_cc: false }, collectorStartDate: "2026-10-06" };
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...appOnly });
    expect(r.series.app_rewards_cc.state).toBe("final");
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: "15688736.6808733274", status: "final", method: "scan-rt-1", source_host: HOST });
    expect(r.series.validator_rewards_cc).toMatchObject({ state: "final_null", gap_code: "not_collected" });
    expect(value(m, "validator_rewards_cc")).toMatchObject({ value: null, status: "final", method: "scan-1", source_host: null, as_of: null });
    const open = m.state.gaps.filter((g) => g.series === "validator_rewards_cc" && g.resolved_at == null);
    expect(open).toMatchObject([{ reason_code: "not_collected", status: "backfill_planned" }]);
    expect(open[0].reason).toContain("did not match the StartIssuing split when checked, so it is not published");
    expect(m.state.revisions).toEqual([]);
  });

  it("settles a final value whose value is unchanged when only its source host or as_of would change", async () => {
    const m = seeded();
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    const before = { featured_apps: value(m, "featured_apps")!, app_rewards_cc: value(m, "app_rewards_cc")! };

    // The snapshot re-read from another host with the same counts, and the
    // last round's StartIssuing captured 90 s later: every value is the same.
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { source_host: "scan.other.example" }));
    const last = m.state.rounds.get(200140)!;
    m.state.rounds.set(200140, { ...last, start_issuing_at: new Date(Date.parse(last.start_issuing_at!) + 90_000).toISOString() });
    m.state.dirtyAt = null;

    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    for (const s of ["featured_apps", "super_validators", "validator_licenses", "reference_price_usd", "rounds", "app_rewards_cc", "issuance_cc"] as const) {
      expect(r.series[s].state, s).toBe("final");
    }
    expect(r.wrote).toBe(0);
    expect(m.state.dirtyAt).toBeNull();
    expect(m.state.revisions).toEqual([]);
    // The stored provenance stays as first recorded.
    expect(value(m, "featured_apps")).toMatchObject({ source_host: HOST, as_of: before.featured_apps.as_of, revision: 0 });
    expect(value(m, "app_rewards_cc")).toMatchObject({ source_host: HOST, as_of: before.app_rewards_cc.as_of, revision: 0 });
  });

  it("publishes a license count the snapshot stage gave up on with its own reason, and keeps it after the stage moves on", async () => {
    const m = seeded();
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { validator_licenses: null }));
    const openLicenseGaps = () => m.state.gaps.filter((g) => g.series === "validator_licenses" && g.resolved_at == null);

    // Past the deadline and not read yet: a final null with the generic reason.
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    expect(value(m, "validator_licenses")).toMatchObject({ value: null, status: "final" });
    expect(openLicenseGaps()).toMatchObject([{ reason_code: "source_unavailable", status: "open" }]);

    // The stage spent its attempts on the day's license count.
    m.state.cursors.set(CURSOR_SNAPSHOT, {
      id: CURSOR_SNAPSHOT, last_round: null, last_date: DATE, last_poll_at: "2026-10-06T03:45:00Z",
      detail: { attempts: SNAPSHOT_RETRY.maxAttempts, next_try_at: "2026-10-06T04:15:00Z", last_error: "Scan answered 503" },
    });
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T04:35:00Z"), ...ctx });
    expect(r.series.validator_licenses).toMatchObject({ state: "final_null", gap_code: "source_unavailable" });
    expect(openLicenseGaps()).toMatchObject([
      { reason_code: "source_unavailable", reason: licensesGaveUpReason(DATE), status: "backfill_planned" },
    ]);
    expect(m.state.revisions).toEqual([]);

    // The next day's stage takes CURSOR_SNAPSHOT over at 00:15: the published reason stays.
    m.state.cursors.set(CURSOR_SNAPSHOT, {
      id: CURSOR_SNAPSHOT, last_round: null, last_date: "2026-10-06", last_poll_at: "2026-10-07T00:15:00Z", detail: {},
    });
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-07T00:35:00Z"), ...ctx });
    expect(openLicenseGaps()).toMatchObject([{ reason: licensesGaveUpReason(DATE), status: "backfill_planned" }]);
  });

  it("stops calling a license count pending once the snapshot stage has moved past the day", async () => {
    const m = seeded();
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { validator_licenses: null }));
    const openLicenseGaps = () => m.state.gaps.filter((g) => g.series === "validator_licenses" && g.resolved_at == null);

    // Until the end of the day after, the stage works on the day and may still read the count.
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T23:35:00Z"), ...ctx });
    expect(value(m, "validator_licenses")).toMatchObject({ value: null, status: "final" });
    expect(openLicenseGaps()).toMatchObject([{ reason_code: "source_unavailable", status: "open" }]);

    // From 00:00 two days after, the stage works on the next day: nothing reads this count again.
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-07T00:35:00Z"), ...ctx });
    expect(r.series.validator_licenses).toMatchObject({ state: "final_null", gap_code: "source_unavailable" });
    expect(openLicenseGaps()).toMatchObject([
      { reason_code: "source_unavailable", reason: licensesNotReadReason(DATE), status: "backfill_planned" },
    ]);
    expect(m.state.revisions).toEqual([]);
  });

  it("reads the rounds beside a forward range, so a day without its opening ACS reading confirms its edges", async () => {
    // No ACS reading at the start of the day: the range is the lowest and
    // highest round whose StartIssuing was captured in it (resolveRange).
    const m = seeded();
    m.state.snapshots.delete("2026-10-04");
    const roundSeries = ["first_round", "last_round", "rounds", "app_rewards_cc", "issuance_cc"] as const;

    const unconfirmed = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T00:35:00Z"), ...ctx });
    for (const s of roundSeries) {
      expect(unconfirmed.series[s], s).toMatchObject({ state: "provisional", gap_code: "round_missed" });
    }

    // Rounds 200000 and 200141, captured just outside the day, confirm both edges.
    const { before, after } = neighboursOf(DATE, 200001);
    m.state.rounds.set(before.round, before);
    m.state.rounds.set(after.round, after);
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T01:35:00Z"), ...ctx });
    for (const s of roundSeries) expect(r.series[s].state, s).toBe("provisional");
    expect(value(m, "rounds")).toMatchObject({ value: "140.0000000000", status: "provisional" });
    expect(value(m, "issuance_cc")?.value).toBe("26636225.2699264274");
    expect(m.state.gaps.filter((g) => g.series === "rounds" && g.resolved_at == null)).toEqual([]);
  });

  it("skips a withdrawal made after its reads by code, and fails on any other refusal", async () => {
    // Settled with a missed round, then the round arrives: the next run calls
    // revise() for the backfill, and this store refuses it with `code`.
    const refusing = async (code: string) => {
      const m = seeded();
      const missing = m.state.rounds.get(200070)!;
      m.state.rounds.delete(200070);
      await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
      m.state.rounds.set(200070, missing);
      const store = {
        ...m.store,
        revise: async () => {
          throw new RecordStoreError("revise", { code, message: "refused" });
        },
      };
      return { m, run: () => finalizeDate(DATE, { store, now: at("2026-10-06T03:35:00Z"), ...ctx }) };
    };

    const w = await refusing(RECORD_SQLSTATE.WITHDRAWN);
    const r = await w.run();
    expect(r.series.app_rewards_cc).toMatchObject({ state: "final_null", gap_code: "withdrawn" });
    expect(value(w.m, "app_rewards_cc")?.value).toBeNull();
    expect(w.m.state.gaps.find((g) => g.series === "app_rewards_cc")?.resolved_at).toBeNull();

    const f = await refusing(RECORD_SQLSTATE.FINAL_CHANGED);
    await expect(f.run()).rejects.toThrow("RN001");
  });

  it("writes the batch once more without a series withdrawn between its reads and the write, and fails on a second refusal", async () => {
    // The batch is one statement: a withdrawal that lands after the reads
    // refuses all of it with RECORD_SQLSTATE.WITHDRAWN.
    const racing = (second: Error | null) => {
      const m = seeded();
      const calls: string[][] = [];
      const store = {
        ...m.store,
        upsertValues: async (rows: ValueWrite[]) => {
          calls.push(rows.map((w) => w.series));
          if (calls.length === 1) {
            m.state.gaps.push({
              date: DATE, series: "app_rewards_cc", reason_code: "withdrawn", reason: "The split is under review", status: "open",
              detected_at: "2026-10-06T02:35:01Z", resolved_at: null, evidence_url: null,
            });
            throw new RecordStoreError("write values", { code: RECORD_SQLSTATE.WITHDRAWN, message: "app_rewards_cc was withdrawn" });
          }
          if (second) throw second;
          return m.store.upsertValues(rows);
        },
      };
      return { m, calls, run: () => finalizeDate(DATE, { store, now: at("2026-10-06T02:35:00Z"), ...ctx }) };
    };

    const w = racing(null);
    const r = await w.run();
    expect(w.calls).toHaveLength(2);
    expect(w.calls[0]).toContain("app_rewards_cc");
    expect(w.calls[1]).toEqual(w.calls[0].filter((s) => s !== "app_rewards_cc"));
    expect(r.series.app_rewards_cc).toMatchObject({ state: "final_null", gap_code: "withdrawn" });
    expect(value(w.m, "app_rewards_cc")).toBeUndefined();
    expect(value(w.m, "validator_rewards_cc")).toMatchObject({ status: "final" });
    expect(r.wrote).toBe(w.calls[1].length);
    expect(w.m.state.dirtyAt).toBe("2026-10-06T02:35:00.000Z");

    const f = racing(new RecordStoreError("write values", { code: RECORD_SQLSTATE.FINAL_CHANGED, message: "is final" }));
    await expect(f.run()).rejects.toThrow("RN001");
    expect(f.calls).toHaveLength(2);
  });

  it("resolves a gap only after the value that explains it is written: a failed batch leaves the gap open", async () => {
    const m = seeded();
    const missing = m.state.rounds.get(200070)!;
    m.state.rounds.delete(200070);
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T00:35:00Z"), ...ctx });
    const openMissed = () => m.state.gaps.filter((g) => g.reason_code === "round_missed" && g.resolved_at == null);
    expect(openMissed()).toHaveLength(10);
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: null, status: "provisional" });

    // The round arrives, but the batch that would publish its values times out.
    m.state.rounds.set(200070, missing);
    m.state.dirtyAt = null;
    const store = {
      ...m.store,
      upsertValues: async () => {
        throw new RecordStoreError("write values", { code: "57014", message: "canceling statement due to statement timeout" });
      },
    };
    await expect(finalizeDate(DATE, { store, now: at("2026-10-06T01:35:00Z"), ...ctx })).rejects.toThrow("57014");
    // The nulls are still published, so the gaps that explain them stay open.
    expect(openMissed()).toHaveLength(10);
    expect(value(m, "app_rewards_cc")?.value).toBeNull();
    expect(m.state.dirtyAt).toBeNull();
  });

  it("opens the gap of a new null before its value is written: a failed gap write commits no value row", async () => {
    const m = seeded();
    m.state.rounds.delete(200070);
    const store = {
      ...m.store,
      upsertGap: async () => {
        throw new RecordStoreError("write gap", { code: "57014", message: "canceling statement due to statement timeout" });
      },
    };
    await expect(finalizeDate(DATE, { store, now: at("2026-10-06T00:35:00Z"), ...ctx })).rejects.toThrow("57014");
    // No null was published without its reason: nothing was written at all.
    expect([...m.state.values.keys()].filter((k) => k.startsWith(`${DATE}|`))).toEqual([]);
    expect(m.state.gaps).toEqual([]);
    expect(m.state.dirtyAt).toBeNull();
  });

  it("keeps the gap of a new null open when resolving the reason it replaced fails after the batch", async () => {
    // A day before the collector, first read with no snapshots: provisional
    // nulls, source_unavailable. After the deadline the snapshots are in, so
    // the nulls become final for not_collected.
    const m = memoryStore();
    const early = { ...ctx, collectorStartDate: "2026-10-06" };
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T00:35:00Z"), ...early });
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: null, status: "provisional" });
    const open = () => m.state.gaps.filter((g) => g.series === "app_rewards_cc" && g.resolved_at == null);
    expect(open()).toMatchObject([{ reason_code: "source_unavailable" }]);

    m.state.snapshots.set("2026-10-04", snapshotRow("2026-10-04", 200000));
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140));
    m.state.dirtyAt = null;
    const store = {
      ...m.store,
      resolveGaps: async (...args: Parameters<typeof m.store.resolveGaps>) => {
        if (args[1] !== "app_rewards_cc") return m.store.resolveGaps(...args);
        throw new RecordStoreError("resolve gaps", { code: "57014", message: "canceling statement due to statement timeout" });
      },
    };
    await expect(finalizeDate(DATE, { store, now: at("2026-10-06T02:35:00Z"), ...early })).rejects.toThrow("57014");
    // The final null was published with its new reason open; only the stale one is left behind.
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: null, status: "final" });
    expect(open().map((g) => g.reason_code).sort()).toEqual(["not_collected", "source_unavailable"]);
    expect(m.state.dirtyAt).toBe("2026-10-06T02:35:00.000Z");

    // The next run finds the value settled and resolves the stale reason.
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...early });
    expect(open()).toMatchObject([{ reason_code: "not_collected", status: "backfill_planned" }]);
  });

  it("keeps a final null's published reason current when the reason changes and the value stays empty", async () => {
    // A day before the collector: finalized with no snapshots, so the flows
    // are final nulls with source_unavailable. Then the backfill writes the
    // snapshots: the flows are still null, now for not_collected.
    const m = memoryStore();
    const early = { ...ctx, collectorStartDate: "2026-10-06" };
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...early });
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: null, status: "final" });
    expect(m.state.gaps.filter((g) => g.series === "app_rewards_cc")).toMatchObject([{ reason_code: "source_unavailable", resolved_at: null }]);

    m.state.snapshots.set("2026-10-04", snapshotRow("2026-10-04", 200000));
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140));
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...early });
    const gaps = m.state.gaps.filter((g) => g.series === "app_rewards_cc");
    expect(gaps.filter((g) => g.resolved_at == null)).toMatchObject([{ reason_code: "not_collected", status: "backfill_planned" }]);
    expect(gaps.find((g) => g.reason_code === "source_unavailable")?.resolved_at).not.toBeNull();
    expect(value(m, "app_rewards_cc")?.value).toBeNull();
  });

  it("never overwrites a final value that would change: it reports a conflict", async () => {
    const m = seeded();
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { featured_apps: 128 }));
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    expect(r.series.featured_apps.state).toBe("conflict");
    expect(value(m, "featured_apps")?.value).toBe("127.0000000000");
  });

  it("keeps a final value a human corrected once its date|series is in keep_final, and reports a conflict until then", async () => {
    const m = seeded();
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    // The source served 127 featured apps; a second Scan host counted 125.
    await m.store.revise(DATE, "featured_apps", "125", "correction", "Counted 125 on a second Scan host");
    m.state.dirtyAt = null;

    // The raw rows still give 127, so the correction cannot be recomputed.
    const unaccepted = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    expect(unaccepted.series.featured_apps.state).toBe("conflict");

    const kept = new Set([`${DATE}|featured_apps`]);
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T04:35:00Z"), ...ctx, keptFinals: kept });
    expect(r.series.featured_apps).toEqual({ state: "final", reason: "accepted: final value kept" });
    expect(r.wrote).toBe(0);
    expect(m.state.dirtyAt).toBeNull();
    expect(value(m, "featured_apps")).toMatchObject({ value: "125.0000000000", status: "final", revision: 1 });
    expect(m.state.revisions.map((x) => x.kind)).toEqual(["correction"]);
    expect(m.state.gaps.filter((g) => g.series === "featured_apps")).toEqual([]);
  });

  it("keeps a null a human filled once it is in keep_final, and resolves the gap that said it was missing", async () => {
    const m = seeded();
    m.state.rounds.delete(200070);
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    const openGaps = (s: string) => m.state.gaps.filter((g) => g.series === s && g.resolved_at == null);
    expect(openGaps("app_rewards_cc")).toMatchObject([{ reason_code: "round_missed", status: "backfill_planned" }]);

    // Round 200070 is still missing; a human reads the day's sum on a second Scan host and fills the null.
    await m.store.revise(
      DATE, "app_rewards_cc", "15688736.6808733274", "backfill", "Round 200070 read on a second Scan host",
      "scan.other.example", "2026-10-06T00:00:00Z",
    );
    const kept = new Set([`${DATE}|app_rewards_cc`]);
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx, keptFinals: kept });
    expect(r.series.app_rewards_cc).toEqual({ state: "final", reason: "accepted: final value kept" });
    expect(value(m, "app_rewards_cc")).toMatchObject({ value: "15688736.6808733274", source_host: "scan.other.example", revision: 1 });
    expect(openGaps("app_rewards_cc")).toEqual([]);
    // The series nobody filled keep their reason.
    expect(r.series.validator_rewards_cc).toMatchObject({ state: "final_null", gap_code: "round_missed" });
    expect(openGaps("validator_rewards_cc")).toMatchObject([{ reason_code: "round_missed", status: "backfill_planned" }]);

    m.state.dirtyAt = null;
    const again = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T04:35:00Z"), ...ctx, keptFinals: kept });
    expect(again.series.app_rewards_cc.state).toBe("final");
    expect(again.wrote).toBe(0);
    expect(m.state.dirtyAt).toBeNull();
  });

  it("holds late data that fails a gate on a final null: the null stays, its gap names the gate, and releasing the hold fills the null", async () => {
    const m = seeded();
    m.state.values.set("2026-10-04|featured_apps", {
      date: "2026-10-04", series: "featured_apps", value: "100.0000000000", status: "final", source_host: HOST,
      method: "scan-1", as_of: "2026-10-05T00:00:00Z", retrieved_at: "2026-10-05T02:35:00Z", finalized_at: "2026-10-05T02:35:00Z", revision: 0, revised_at: null,
    });
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { featured_apps: null }));
    const openGaps = () => m.state.gaps.filter((g) => g.series === "featured_apps" && g.resolved_at == null);
    await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    expect(value(m, "featured_apps")).toMatchObject({ value: null, status: "final" });
    expect(openGaps()).toMatchObject([{ reason_code: "source_unavailable" }]);

    // The count arrives late, 27% above the day before.
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140));
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx });
    expect(r.series.featured_apps).toMatchObject({ state: "held", gap_code: "sanity_gate_failed" });
    expect(r.series.featured_apps.reason).toContain("featured_apps moved from 100 to 127");
    expect(value(m, "featured_apps")).toMatchObject({ value: null, status: "final", revision: 0 });
    expect(openGaps()).toMatchObject([{ reason_code: "sanity_gate_failed", reason: r.series.featured_apps.reason, status: "open" }]);
    expect(m.state.revisions).toEqual([]);

    const ok = await finalizeDate(DATE, {
      store: m.store, now: at("2026-10-06T04:35:00Z"), ...ctx, releasedHolds: releasing("featured_apps", "127"),
    });
    expect(ok.series.featured_apps.state).toBe("revised");
    expect(value(m, "featured_apps")).toMatchObject({ value: "127.0000000000", status: "final", revision: 1 });
    expect(openGaps()).toEqual([]);
  });

  it("holds a failing gate as provisional, and releases it once a human lists it in release_holds", async () => {
    const m = seeded();
    m.state.values.set("2026-10-04|featured_apps", {
      date: "2026-10-04", series: "featured_apps", value: "100.0000000000", status: "final", source_host: "api.cantonnodes.com",
      method: "scan-1", as_of: "2026-10-05T00:00:00Z", retrieved_at: "2026-10-05T02:35:00Z", finalized_at: "2026-10-05T02:35:00Z", revision: 0, revised_at: null,
    });
    const held = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx });
    expect(held.series.featured_apps.state).toBe("held");
    expect(value(m, "featured_apps")?.status).toBe("provisional");
    expect(m.state.gaps.find((g) => g.series === "featured_apps")?.reason_code).toBe("sanity_gate_failed");

    const ok = await finalizeDate(DATE, {
      store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx, releasedHolds: releasing("featured_apps", "127"),
    });
    expect(ok.series.featured_apps.state).toBe("final");
    expect(m.state.gaps.find((g) => g.series === "featured_apps")?.resolved_at).not.toBeNull();
  });

  it("still reports a conflict when the raw rows of a released hold change after it was finalized", async () => {
    const m = seeded();
    m.state.values.set("2026-10-04|featured_apps", {
      date: "2026-10-04", series: "featured_apps", value: "100.0000000000", status: "final", source_host: HOST,
      method: "scan-1", as_of: "2026-10-05T00:00:00Z", retrieved_at: "2026-10-05T02:35:00Z", finalized_at: "2026-10-05T02:35:00Z", revision: 0, revised_at: null,
    });
    const released = releasing("featured_apps", "127");
    const ok = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx, releasedHolds: released });
    expect(ok.series.featured_apps.state).toBe("final");
    expect(value(m, "featured_apps")).toMatchObject({ value: "127.0000000000", status: "final" });

    // Releasing the hold vouched for 127, not for whatever the raw rows say next.
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { featured_apps: 128 }));
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T04:35:00Z"), ...ctx, releasedHolds: released });
    expect(r.series.featured_apps.state).toBe("conflict");
    expect(value(m, "featured_apps")).toMatchObject({ value: "127.0000000000", revision: 0 });
  });

  it("releases only the value a human checked: a different reading before the deadline is held again", async () => {
    const m = seeded();
    m.state.values.set("2026-10-04|featured_apps", {
      date: "2026-10-04", series: "featured_apps", value: "100.0000000000", status: "final", source_host: HOST,
      method: "scan-1", as_of: "2026-10-05T00:00:00Z", retrieved_at: "2026-10-05T02:35:00Z", finalized_at: "2026-10-05T02:35:00Z", revision: 0, revised_at: null,
    });
    const released = releasing("featured_apps", "127");
    const early = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T01:10:00Z"), ...ctx, releasedHolds: released });
    expect(early.series.featured_apps.state).toBe("provisional");
    expect(value(m, "featured_apps")).toMatchObject({ value: "127.0000000000", status: "provisional" });

    // Rows arriving before the settle deadline make it 128, which still fails the gate.
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { featured_apps: 128 }));
    const r = await finalizeDate(DATE, { store: m.store, now: at("2026-10-06T02:35:00Z"), ...ctx, releasedHolds: released });
    expect(r.series.featured_apps).toMatchObject({ state: "held", gap_code: "sanity_gate_failed" });
    expect(value(m, "featured_apps")).toMatchObject({ value: "128.0000000000", status: "provisional" });
    expect(m.state.gaps.filter((g) => g.series === "featured_apps" && g.resolved_at == null)).toMatchObject([
      { reason_code: "sanity_gate_failed" },
    ]);

    // The same value written with more places is the value the human checked.
    const same = await finalizeDate(DATE, {
      store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx, releasedHolds: releasing("featured_apps", "128.00000000001"),
    });
    expect(same.series.featured_apps.state).toBe("final");
  });

  it("keeps a failing gate held when its date|series is only in keep_final", async () => {
    const m = seeded();
    m.state.values.set("2026-10-04|featured_apps", {
      date: "2026-10-04", series: "featured_apps", value: "100.0000000000", status: "final", source_host: HOST,
      method: "scan-1", as_of: "2026-10-05T00:00:00Z", retrieved_at: "2026-10-05T02:35:00Z", finalized_at: "2026-10-05T02:35:00Z", revision: 0, revised_at: null,
    });
    const r = await finalizeDate(DATE, {
      store: m.store, now: at("2026-10-06T03:35:00Z"), ...ctx, keptFinals: new Set([`${DATE}|featured_apps`]),
    });
    expect(r.series.featured_apps.state).toBe("held");
    expect(value(m, "featured_apps")?.status).toBe("provisional");
  });
});

// Most runs below start at 03:35 or later; the due day is judged at the
// D+1 02:00 settle cut (SETTLE_HOURS), so the 02:35 run already judges DATE.
describe("runFinalize", () => {
  const failingGaps = (m: ReturnType<typeof memoryStore>, broken: string) => ({
    ...m.store,
    getGaps: async (date: string) => {
      if (date === broken) throw new RecordStoreError("read gaps", { code: "57014", message: "canceling statement due to statement timeout" });
      return m.store.getGaps(date);
    },
  });

  it("is ok only when the due day is fully settled, and reads the collector start from the cursor", async () => {
    const m = seeded();
    const good = await runFinalize({ store: m.store, now: at("2026-10-06T03:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(good.date).toBe(DATE);
    expect(good.ok).toBe(true);
    expect(good.days.map((d) => d.date)).toEqual([
      "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", DATE,
    ]);

    // 2026-10-04 settles at 100 featured apps, so 127 on the due day is a 27% jump.
    const m2 = seeded();
    m2.state.snapshots.set("2026-10-04", snapshotRow("2026-10-04", 200000, { featured_apps: 100 }));
    const bad = await runFinalize({ store: m2.store, now: at("2026-10-06T03:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(bad.ok).toBe(false);
    expect(bad.series.featured_apps?.state).toBe("held");

    m2.state.cursors.set(CURSOR_OVERRIDES, { id: CURSOR_OVERRIDES, last_round: null, last_date: null, last_poll_at: null, detail: { release_holds: [`${DATE}|featured_apps|127`] } });
    const accepted = await runFinalize({ store: m2.store, now: at("2026-10-06T04:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(accepted.ok).toBe(true);
    expect(accepted.errors).toEqual([]);
  });

  it("judges the due day at the 02:00 settle cut, so the 02:35 run pages before the 03:00 promise", async () => {
    const settled = await runFinalize({ store: seeded().store, now: at("2026-10-06T02:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(settled.date).toBe(DATE);
    expect(settled.ok).toBe(true);
    expect(settled.series.issuance_cc?.state).toBe("final");

    const m = seeded();
    m.state.snapshots.set("2026-10-04", snapshotRow("2026-10-04", 200000, { featured_apps: 100 }));
    const held = await runFinalize({ store: m.store, now: at("2026-10-06T02:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(held.date).toBe(DATE);
    expect(held.ok).toBe(false);
    expect(held.series.featured_apps?.state).toBe("held");
  });

  it("is ok again after a human correction once its date|series is in keep_final", async () => {
    const m = seeded();
    const settled = await runFinalize({ store: m.store, now: at("2026-10-06T03:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(settled.ok).toBe(true);
    await m.store.revise(DATE, "featured_apps", "125", "correction", "Counted 125 on a second Scan host");

    const paging = await runFinalize({ store: m.store, now: at("2026-10-06T04:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(paging.ok).toBe(false);
    expect(paging.series.featured_apps?.state).toBe("conflict");

    m.state.cursors.set(CURSOR_OVERRIDES, { id: CURSOR_OVERRIDES, last_round: null, last_date: null, last_poll_at: null, detail: { keep_final: [`${DATE}|featured_apps`] } });
    const kept = await runFinalize({ store: m.store, now: at("2026-10-06T05:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(kept.ok).toBe(true);
    expect(kept.series.featured_apps).toEqual({ state: "final", reason: "accepted: final value kept" });
    expect(kept.errors).toEqual([]);
  });

  it("reads release_holds and keep_final as two lists, and no longer reads the single `accept` list", async () => {
    const m = seeded();
    m.state.snapshots.set("2026-10-04", snapshotRow("2026-10-04", 200000, { featured_apps: 100 }));
    const overrides = (detail: Record<string, unknown>) =>
      m.state.cursors.set(CURSOR_OVERRIDES, { id: CURSOR_OVERRIDES, last_round: null, last_date: null, last_poll_at: null, detail });

    overrides({ accept: [`${DATE}|featured_apps`] });
    const legacy = await runFinalize({ store: m.store, now: at("2026-10-06T03:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(legacy.series.featured_apps?.state).toBe("held");

    overrides({ keep_final: [`${DATE}|featured_apps`] });
    const keptOnly = await runFinalize({ store: m.store, now: at("2026-10-06T03:40:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(keptOnly.series.featured_apps?.state).toBe("held");

    // A release names the value the human checked: without it, it releases nothing.
    overrides({ release_holds: [`${DATE}|featured_apps`] });
    const unnamed = await runFinalize({ store: m.store, now: at("2026-10-06T03:42:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(unnamed.series.featured_apps?.state).toBe("held");

    overrides({ release_holds: [`${DATE}|featured_apps|127`] });
    const released = await runFinalize({ store: m.store, now: at("2026-10-06T03:45:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(released.series.featured_apps?.state).toBe("final");

    // A later change of the raw rows is a conflict: releasing the hold kept nothing.
    m.state.snapshots.set(DATE, snapshotRow(DATE, 200140, { featured_apps: 128 }));
    const changed = await runFinalize({ store: m.store, now: at("2026-10-06T04:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(changed.ok).toBe(false);
    expect(changed.series.featured_apps?.state).toBe("conflict");
  });

  it("still settles and reports the due day when an older day throws, and is not ok", async () => {
    const m = seeded();
    const broken = "2026-09-30";
    const r = await runFinalize({ store: failingGaps(m, broken), now: at("2026-10-06T03:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ date: broken, error: expect.stringContaining("57014") }]);
    expect(r.days.map((d) => d.date)).toEqual(["2026-09-29", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", DATE]);
    // The due day was evaluated in full: `error` stays unset, so its
    // per-series outcomes still count, and the older day's failure shows
    // through `errors` and `ok` alone.
    expect(r.error).toBeUndefined();
    expect(Object.keys(r.series).sort()).toEqual([...SERIES_NAMES].sort());
    expect(r.series.issuance_cc?.state).toBe("final");
    expect(value(m, "issuance_cc")).toMatchObject({ status: "final" });
  });

  it("names the due day in `error`, with no series, when the due day itself throws", async () => {
    const m = seeded();
    const r = await runFinalize({ store: failingGaps(m, DATE), now: at("2026-10-06T03:35:00Z"), roundTotalsVerified: NO_ROUND_TOTALS });
    expect(r.ok).toBe(false);
    expect(r.date).toBe(DATE);
    expect(r.series).toEqual({});
    expect(r.errors).toEqual([{ date: DATE, error: expect.stringContaining("57014") }]);
    expect(r.error).toBe(`${DATE}: ${r.errors[0].error}`);
    expect(r.days.map((d) => d.date)).not.toContain(DATE);
  });
});
