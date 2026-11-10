import { describe, expect, it } from "vitest";
import { RECORD_SQLSTATE } from "../../open-record/contract";
import type { SupabaseClient } from "@supabase/supabase-js";
import { VALUE_DATE_SERIES, recordErrorCode } from "../../scan-record/store";
import { supabaseRecordStore } from "../supabase-store";

type Result = { data: unknown; error: null | { code: string; message: string } };
type Call = { table: string; op: string; args: unknown[] };

/** A PostgREST builder that records the chain and answers per table. */
function fakeAdmin(results: Record<string, Result>, rpcResult: Result = { data: 1, error: null }) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const result = results[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "eq", "neq", "gte", "lte", "lt", "order", "limit", "ilike", "is", "update", "insert"]) {
      chain[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        return chain;
      };
    }
    chain.upsert = (...args: unknown[]) => {
      calls.push({ table, op: "upsert", args });
      return Promise.resolve({ error: null });
    };
    chain.maybeSingle = () => Promise.resolve(result);
    chain.then = (resolve: (v: Result) => unknown) => resolve(result);
    return chain;
  };
  const rpc = (fn: string, args: unknown) => {
    calls.push({ table: "rpc", op: fn, args: [args] });
    return Promise.resolve(rpcResult);
  };
  return { admin: { from, rpc } as unknown as SupabaseClient, calls };
}

describe("supabaseRecordStore", () => {
  it("reads values with the numeric cast to text, so 21 digits survive", async () => {
    const { admin, calls } = fakeAdmin({ network_record_values: { data: [], error: null } });
    await supabaseRecordStore(admin).getValues("2026-10-05");
    const select = calls.find((c) => c.op === "select");
    expect(String(select?.args[0])).toContain("value::text");
    expect(calls).toContainEqual({ table: "network_record_values", op: "eq", args: ["date", "2026-10-05"] });
  });

  it("upserts values on (date, series)", async () => {
    const { admin, calls } = fakeAdmin({});
    await supabaseRecordStore(admin).upsertValues([
      {
        date: "2026-10-05", series: "rounds", value: "140", status: "provisional", source_host: "api.cantonnodes.com",
        method: "scan-1", as_of: "2026-10-06T00:00:00Z", retrieved_at: "2026-10-06T00:35:00Z", finalized_at: null,
      },
    ]);
    const upsert = calls.find((c) => c.op === "upsert");
    expect(upsert?.args[1]).toEqual({ onConflict: "date,series" });
  });

  it("refuses a round span that PostgREST would silently truncate", async () => {
    const { admin } = fakeAdmin({});
    await expect(supabaseRecordStore(admin).getRounds(1, 1_500)).rejects.toThrow("1,000-row");
  });

  it("reads supply from the exact 00:00Z Scan registry reading of the CC asset", async () => {
    const { admin, calls } = fakeAdmin({
      assets: { data: { id: "96076ba0" }, error: null },
      asset_supply_snapshots: { data: { total_supply: "39681534966.2458918175" }, error: null },
    });
    const supply = await supabaseRecordStore(admin).getSupplyAt("2026-09-25T00:00:00Z");
    expect(supply).toEqual({ value: "39681534966.2458918175", source_host: "api.cantonnodes.com" });
    expect(calls).toContainEqual({ table: "asset_supply_snapshots", op: "eq", args: ["source", "scan_registry"] });
    expect(calls).toContainEqual({ table: "asset_supply_snapshots", op: "eq", args: ["supply_as_of", "2026-09-25T00:00:00Z"] });
  });

  it("credits a supply reading to the host that served it, and an older reading with none to api.cantonnodes.com", async () => {
    const { admin } = fakeAdmin({
      assets: { data: { id: "cc" }, error: null },
      asset_supply_snapshots: { data: { total_supply: "1.5", source_host: "scan.sv-1.global.canton.network.example.invalid" }, error: null },
    });
    expect(await supabaseRecordStore(admin).getSupplyAt("2026-11-08T00:00:00Z")).toEqual({
      value: "1.5",
      source_host: "scan.sv-1.global.canton.network.example.invalid",
    });
    const older = fakeAdmin({
      assets: { data: { id: "cc" }, error: null },
      asset_supply_snapshots: { data: { total_supply: "1.5", source_host: null }, error: null },
    });
    expect(await supabaseRecordStore(older.admin).getSupplyAt("2026-09-25T00:00:00Z")).toEqual({ value: "1.5", source_host: "api.cantonnodes.com" });
  });

  it("changes a final value only through the RPC, passing the source host, as_of and method a backfill needs", async () => {
    const { admin, calls } = fakeAdmin({});
    const store = supabaseRecordStore(admin);
    await store.revise(
      "2026-10-05", "app_rewards_cc", "15690000.1", "backfill", "late data", "api.cantonnodes.com", "2026-10-06T00:00:00Z", "scan-rt-1",
    );
    expect(calls).toContainEqual({
      table: "rpc",
      op: "revise_network_record",
      args: [{
        p_date: "2026-10-05", p_series: "app_rewards_cc", p_value: "15690000.1", p_kind: "backfill", p_reason: "late data",
        p_method: "scan-rt-1", p_source_host: "api.cantonnodes.com", p_as_of: "2026-10-06T00:00:00Z",
      }],
    });

    // Left out, each goes as null, the RPC's default: keep the row's own.
    await store.revise("2026-10-05", "app_rewards_cc", "15690000.2", "correction", "recounted");
    expect(calls[calls.length - 1].args[0]).toMatchObject({ p_method: null, p_source_host: null, p_as_of: null });
  });

  it("keeps the SQLSTATE of a refused revision, so finalize can skip WITHDRAWN by code", async () => {
    const { admin } = fakeAdmin({}, { data: null, error: { code: "RN002", message: "2026-10-05 app_rewards_cc was withdrawn" } });
    const err = await supabaseRecordStore(admin)
      .revise("2026-10-05", "app_rewards_cc", "1", "backfill", "late data", "api.cantonnodes.com", "2026-10-06T00:00:00Z")
      .catch((e: unknown) => e);
    expect(recordErrorCode(err)).toBe(RECORD_SQLSTATE.WITHDRAWN);
    expect(recordErrorCode(new Error("not from the store"))).toBeNull();
  });

  it("updates the open gap row, and inserts a new row instead of reopening a resolved one", async () => {
    const gap = { date: "2026-10-05", series: "app_rewards_cc" as const, reason_code: "round_missed" as const, reason: "r", status: "open" as const };
    const open = fakeAdmin({ network_record_gaps: { data: [{ id: 7 }], error: null } });
    await supabaseRecordStore(open.admin).upsertGap(gap);
    expect(open.calls).toContainEqual({ table: "network_record_gaps", op: "is", args: ["resolved_at", null] });
    expect(open.calls).toContainEqual({ table: "network_record_gaps", op: "eq", args: ["id", 7] });
    expect(open.calls.some((c) => c.op === "insert")).toBe(false);

    const none = fakeAdmin({ network_record_gaps: { data: [], error: null } });
    await supabaseRecordStore(none.admin).upsertGap(gap);
    expect(none.calls.find((c) => c.op === "insert")?.args[0]).toMatchObject({ date: "2026-10-05", reason_code: "round_missed", status: "open" });
    expect(none.calls.some((c) => c.op === "upsert")).toBe(false);
  });

  it("stamps retrieved_at on every snapshot write, so licenses added later carry the time they were read", async () => {
    const { admin, calls } = fakeAdmin({});
    const before = Date.now();
    await supabaseRecordStore(admin).upsertSnapshot({
      date: "2026-10-05", record_time: "2026-10-06T00:00:00Z", migration_id: 4, source_host: "api.cantonnodes.com",
      method: "scan-1", last_round: 98370, reference_round: 98373, reference_price_usd: "0.1560",
      super_validators: 4, sv_voting_threshold: 3, featured_apps: 3, validator_licenses: 2,
    });
    const upsert = calls.find((c) => c.table === "network_record_snapshots" && c.op === "upsert");
    const [row] = upsert?.args[0] as Array<{ retrieved_at: string; validator_licenses: number }>;
    expect(row.validator_licenses).toBe(2);
    expect(Date.parse(row.retrieved_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row.retrieved_at)).toBeLessThanOrEqual(Date.now());
    expect(upsert?.args[1]).toEqual({ onConflict: "date" });
  });

  it("leaves a null validator_licenses out of the snapshot write, so a writer that did not read them never erases a stored count", async () => {
    const { admin, calls } = fakeAdmin({});
    await supabaseRecordStore(admin).upsertSnapshot({
      date: "2026-10-05", record_time: "2026-10-06T00:00:00Z", migration_id: 4, source_host: "api.cantonnodes.com",
      method: "scan-1", last_round: 98370, reference_round: 98373, reference_price_usd: "0.1560",
      super_validators: 4, sv_voting_threshold: 3, featured_apps: 3, validator_licenses: null,
    });
    const upsert = calls.find((c) => c.table === "network_record_snapshots" && c.op === "upsert");
    const [row] = upsert?.args[0] as Array<Record<string, unknown>>;
    expect(row).not.toHaveProperty("validator_licenses");
    expect(row).toMatchObject({ date: "2026-10-05", featured_apps: 3, super_validators: 4, last_round: 98370 });
    expect(typeof row.retrieved_at).toBe("string");
    expect(upsert?.args[1]).toEqual({ onConflict: "date" });
  });

  it("throws with the Postgres code when a read fails", async () => {
    const { admin } = fakeAdmin({ network_record_snapshots: { data: null, error: { code: "42P01", message: "missing" } } });
    await expect(supabaseRecordStore(admin).getSnapshot("2026-10-05")).rejects.toThrow("42P01");
  });

  it("lists the dates that have value rows, one series per day, paging past the 1,000-row cap until an empty page", async () => {
    // 2,100 rows of VALUE_DATE_SERIES, one per date, served in pages of at most 1,000.
    const rows = Array.from({ length: 2_100 }, (_, i) => ({ date: `d${String(i).padStart(4, "0")}` }));
    const ranges: Array<[number, number]> = [];
    const filters: unknown[][] = [];
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "eq", "gte", "lte", "order"]) {
      chain[op] = (...args: unknown[]) => {
        filters.push([op, ...args]);
        return chain;
      };
    }
    chain.range = (lo: number, hi: number) => {
      ranges.push([lo, hi]);
      return Promise.resolve({ data: rows.slice(lo, hi + 1), error: null });
    };
    const admin = { from: () => chain } as unknown as SupabaseClient;
    const dates = await supabaseRecordStore(admin).listValueDates("2026-03-26", "2026-09-20");
    expect(dates).toHaveLength(2_100);
    expect(dates[0]).toBe("d0000");
    expect(dates[dates.length - 1]).toBe("d2099");
    expect(ranges).toEqual([[0, 999], [1_000, 1_999], [2_000, 2_999], [2_100, 3_099]]);
    expect(filters).toEqual(
      expect.arrayContaining([["eq", "series", VALUE_DATE_SERIES], ["gte", "date", "2026-03-26"], ["lte", "date", "2026-09-20"], ["order", "date"]]),
    );
    expect(filters).not.toContainEqual(["order", "series"]);
  });

  it("lists the snapshot dates paging past the 1,000-row cap until an empty page, so a span over 1,000 days never throws", async () => {
    const rows = Array.from({ length: 1_200 }, (_, i) => ({ date: `d${String(i).padStart(4, "0")}` }));
    const ranges: Array<[number, number]> = [];
    const filters: unknown[][] = [];
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "gte", "lte", "order"]) {
      chain[op] = (...args: unknown[]) => {
        filters.push([op, ...args]);
        return chain;
      };
    }
    chain.range = (lo: number, hi: number) => {
      ranges.push([lo, hi]);
      return Promise.resolve({ data: rows.slice(lo, hi + 1), error: null });
    };
    const admin = { from: () => chain } as unknown as SupabaseClient;
    const dates = await supabaseRecordStore(admin).listSnapshotDates("2026-03-25", "2029-09-20");
    expect(dates).toEqual(rows.map((r) => r.date));
    expect(ranges).toEqual([[0, 999], [1_000, 1_999], [1_200, 2_199]]);
    expect(filters).toEqual(expect.arrayContaining([["gte", "date", "2026-03-25"], ["lte", "date", "2029-09-20"], ["order", "date"]]));
  });

  it("inserts a snapshot with a plain insert, and answers false when the date already has a row", async () => {
    const row = {
      date: "2026-10-05", record_time: "2026-10-06T00:00:00Z", migration_id: 4, source_host: "api.cantonnodes.com",
      method: "scan-1" as const, last_round: 98370, reference_round: 98373, reference_price_usd: "0.1560",
      super_validators: 4, sv_voting_threshold: 3, featured_apps: 3, validator_licenses: null,
    };
    const fresh = fakeAdmin({});
    const before = Date.now();
    expect(await supabaseRecordStore(fresh.admin).insertSnapshot(row)).toBe(true);
    const insert = fresh.calls.find((c) => c.table === "network_record_snapshots" && c.op === "insert");
    expect(insert?.args[0]).toMatchObject({ date: "2026-10-05", source_host: "api.cantonnodes.com", featured_apps: 3 });
    expect(Date.parse((insert?.args[0] as { retrieved_at: string }).retrieved_at)).toBeGreaterThanOrEqual(before);
    expect(fresh.calls.some((c) => c.op === "upsert")).toBe(false);

    const taken = fakeAdmin({
      network_record_snapshots: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    });
    expect(await supabaseRecordStore(taken.admin).insertSnapshot(row)).toBe(false);

    const down = fakeAdmin({
      network_record_snapshots: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
    });
    await expect(supabaseRecordStore(down.admin).insertSnapshot(row)).rejects.toMatchObject({ code: "57014" });
  });
});
