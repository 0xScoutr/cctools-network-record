import { describe, expect, it } from "vitest";
import { RECORD_SQLSTATE } from "../../open-record/contract";
import { recordErrorCode, type SnapshotRow, type ValueWrite } from "../store";
import { snapshotRow } from "./helpers/day-builders";
import { memoryStore } from "./helpers/memory-store";

const DATE = "2026-10-05";
const SERIES = "app_rewards_cc";
const HOST = "api.cantonnodes.com";
const AS_OF = "2026-10-06T00:00:00Z";

/** A final row as finalize leaves it: a value with its provenance, or a gap's null with none. */
function withFinal(value: string | null) {
  const m = memoryStore();
  m.state.values.set(`${DATE}|${SERIES}`, {
    date: DATE, series: SERIES, value, status: "final", source_host: value == null ? null : HOST, method: "scan-1",
    as_of: value == null ? null : AS_OF, retrieved_at: "2026-10-06T02:35:00Z", finalized_at: "2026-10-06T02:35:00Z",
    revision: 0, revised_at: null,
  });
  return m;
}

function write(value: string): ValueWrite {
  return {
    date: DATE, series: SERIES, value, status: "final", source_host: HOST, method: "scan-1", as_of: AS_OF,
    retrieved_at: "2026-10-06T03:35:00Z", finalized_at: "2026-10-06T03:35:00Z",
  };
}

/** The SQLSTATE a call was refused with, or "not refused". */
function codeOf(p: Promise<unknown>): Promise<string | null> {
  return p.then(() => "not refused", (err: unknown) => recordErrorCode(err));
}

describe("memoryStore keeps the schema's refusals", () => {
  it("refuses to fill a gap's null without its source host and as_of, like the RPC", async () => {
    const m = withFinal(null);
    expect(await codeOf(m.store.revise(DATE, SERIES, "5", "backfill", "late data"))).toBe("P0001");
    expect(await m.store.revise(DATE, SERIES, "5", "backfill", "late data", HOST, AS_OF)).toBe(1);
    expect(m.state.values.get(`${DATE}|${SERIES}`)).toMatchObject({
      value: "5.0000000000", source_host: HOST, as_of: AS_OF, revision: 1,
    });
  });

  it("skips an identical rewrite of a final row and refuses a changed one with FINAL_CHANGED", async () => {
    const m = withFinal("5.0000000000");
    await m.store.upsertValues([write("5")]);
    expect(await codeOf(m.store.upsertValues([write("6")]))).toBe(RECORD_SQLSTATE.FINAL_CHANGED);
    expect(m.state.values.get(`${DATE}|${SERIES}`)?.value).toBe("5.0000000000");
  });

  it("keeps a withdrawal until a correction: backfill, direct writes and gap resolution are WITHDRAWN", async () => {
    const m = withFinal("5.0000000000");
    expect(await m.store.revise(DATE, SERIES, null, "withdrawal", "The source served a split that does not add up")).toBe(1);
    expect(await codeOf(m.store.revise(DATE, SERIES, "5", "backfill", "late data", HOST, AS_OF))).toBe(RECORD_SQLSTATE.WITHDRAWN);
    expect(await codeOf(m.store.upsertValues([write("5")]))).toBe(RECORD_SQLSTATE.WITHDRAWN);
    expect(await codeOf(m.store.resolveGaps(DATE, SERIES, "2026-10-06T03:35:00Z"))).toBe(RECORD_SQLSTATE.WITHDRAWN);
    await m.store.resolveGaps(DATE, SERIES, "2026-10-06T03:35:00Z", "withdrawn");

    expect(await m.store.revise(DATE, SERIES, "5", "correction", "Checked against a second Scan host", HOST, AS_OF)).toBe(2);
    expect(m.state.values.get(`${DATE}|${SERIES}`)).toMatchObject({ value: "5.0000000000", source_host: HOST, as_of: AS_OF });
    expect(m.state.gaps).toMatchObject([{ reason_code: "withdrawn", status: "resolved" }]);
    expect(m.state.revisions.map((r) => r.kind)).toEqual(["withdrawal", "correction"]);
  });

  it("clears the source host and as_of on a withdrawal, so a restoring correction must pass both", async () => {
    const m = withFinal("5.0000000000");
    expect(await m.store.revise(DATE, SERIES, null, "withdrawal", "The source served a split that does not add up")).toBe(1);
    expect(m.state.values.get(`${DATE}|${SERIES}`)).toMatchObject({ value: null, source_host: null, as_of: null, revision: 1 });

    expect(await codeOf(m.store.revise(DATE, SERIES, "5", "correction", "Checked against a second Scan host"))).toBe("P0001");
    expect(m.state.gaps).toMatchObject([{ reason_code: "withdrawn", status: "open", resolved_at: null }]);
    const other = "scan.sv-2.example";
    expect(await m.store.revise(DATE, SERIES, "5", "correction", "Checked against a second Scan host", other, AS_OF)).toBe(2);
    expect(m.state.values.get(`${DATE}|${SERIES}`)).toMatchObject({ value: "5.0000000000", source_host: other, as_of: AS_OF });
  });

  it.each(["correction", "method"] as const)(
    "treats a %s whose value is unchanged as a no-op: nothing logged, no bump, provenance kept",
    async (kind) => {
      const m = withFinal("5.0000000000");
      // Differs only past the 10th place, and names another host and as_of.
      expect(await m.store.revise(DATE, SERIES, "5.00000000001", kind, "same value", "scan.sv-2.example", "2026-10-06T00:05:00Z"))
        .toBe(0);
      expect(m.state.revisions).toEqual([]);
      expect(m.state.values.get(`${DATE}|${SERIES}`)).toMatchObject({
        value: "5.0000000000", source_host: HOST, as_of: AS_OF, revision: 0, revised_at: null,
      });
      expect(m.state.dirtyAt).toBeNull();
    },
  );

  it("writes the new provenance with a changed value, and never logs old = new", async () => {
    const m = withFinal("5.0000000000");
    expect(await m.store.revise(DATE, SERIES, "6", "correction", "missed round repaired", undefined, "2026-10-06T00:05:00Z")).toBe(1);
    expect(m.state.values.get(`${DATE}|${SERIES}`)).toMatchObject({
      value: "6.0000000000", source_host: HOST, as_of: "2026-10-06T00:05:00Z", revision: 1,
    });
    expect(m.state.revisions).toMatchObject([{ old_value: "5.0000000000", new_value: "6.0000000000", kind: "correction" }]);
    for (const r of m.state.revisions) expect(r.old_value).not.toBe(r.new_value);
  });

  it("refuses a value without its source host and as_of, like the table check, and writes nothing", async () => {
    const m = memoryStore();
    const provisional: ValueWrite = { ...write("5"), status: "provisional", finalized_at: null };
    for (const bad of [{ ...provisional, source_host: null }, { ...provisional, as_of: null }]) {
      const err = await m.store.upsertValues([{ ...provisional, series: "rounds" }, bad]).then(() => null, (e: unknown) => e);
      expect(recordErrorCode(err)).toBe("23514");
      expect(String((err as Error).message)).toContain("network_record_values_provenance");
      expect(m.state.values.size).toBe(0);
    }
    // A null value names no provenance (a gap's row).
    await m.store.upsertValues([{ ...provisional, value: null, source_host: null, as_of: null }]);
    expect(m.state.values.size).toBe(1);
  });
});

describe("memoryStore mirrors the database store's snapshot writes", () => {
  it("keeps a stored validator license count when a later write has none, like the upsert that leaves the column out", async () => {
    const m = memoryStore();
    const row: SnapshotRow = {
      date: DATE, record_time: AS_OF, migration_id: 4, source_host: HOST, method: "scan-1", last_round: 98370,
      reference_round: 98373, reference_price_usd: "0.1560", super_validators: 4, sv_voting_threshold: 3,
      featured_apps: 3, validator_licenses: 2,
    };
    await m.store.upsertSnapshot(row);
    await m.store.upsertSnapshot({ ...row, featured_apps: 4, validator_licenses: null });
    expect(m.state.snapshots.get(DATE)).toEqual({ ...row, featured_apps: 4, validator_licenses: 2 });

    await m.store.upsertSnapshot({ ...row, date: "2026-10-06", validator_licenses: null });
    expect(m.state.snapshots.get("2026-10-06")?.validator_licenses).toBeNull();
  });

  it("inserts a snapshot only for a date without one, like the insert the primary key refuses", async () => {
    const m = memoryStore();
    const row: SnapshotRow = {
      date: DATE, record_time: AS_OF, migration_id: 4, source_host: HOST, method: "scan-1", last_round: 98370,
      reference_round: 98373, reference_price_usd: "0.1560", super_validators: 4, sv_voting_threshold: 3,
      featured_apps: 3, validator_licenses: null,
    };
    expect(await m.store.insertSnapshot(row)).toBe(true);
    await m.store.upsertSnapshot({ ...row, validator_licenses: 2 });
    expect(await m.store.insertSnapshot({ ...row, source_host: "scan.other.example", featured_apps: 9 })).toBe(false);
    expect(m.state.snapshots.get(DATE)).toEqual({ ...row, validator_licenses: 2 });
  });

  it("lists stored snapshots that lack their license count, oldest first", async () => {
    const { store } = memoryStore();
    await store.upsertSnapshot(snapshotRow("2026-04-02", 90000, { validator_licenses: null }));
    await store.upsertSnapshot(snapshotRow("2026-04-01", 89860, { validator_licenses: null }));
    await store.upsertSnapshot(snapshotRow("2026-04-03", 90140));
    expect((await store.listSnapshotsMissingLicenses("2026-03-26", "2026-04-30")).map((s) => s.date)).toEqual(["2026-04-01", "2026-04-02"]);
    expect((await store.listSnapshotsMissingLicenses("2026-04-02", "2026-04-30")).map((s) => s.date)).toEqual(["2026-04-02"]);
  });
});
