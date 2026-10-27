import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const setCached = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../runtime/cache-store", () => ({
  setCached: (...a: unknown[]) => setCached(...a),
  getCacheEntry: async () => ({ status: "miss" }),
}));

import { apiCacheFileCache, supabaseRecordReader } from "../supabase-reader";

function pagingAdmin(total: number) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
  const admin = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "order", "eq"]) {
        chain[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return chain;
        };
      }
      chain.range = (from: number, to: number) => {
        calls.push({ table, op: "range", args: [from, to] });
        const n = Math.max(0, Math.min(to, total - 1) - from + 1);
        return Promise.resolve({ data: Array.from({ length: n }, (_, i) => ({ i: from + i })), error: null });
      };
      chain.upsert = (...args: unknown[]) => {
        calls.push({ table, op: "upsert", args });
        return Promise.resolve({ error: null });
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

describe("supabaseRecordReader", () => {
  it("pages past the 1,000-row cap and reads numerics as text", async () => {
    const { admin, calls } = pagingAdmin(1003);
    const rows = await supabaseRecordReader(admin).values();
    expect(rows).toHaveLength(1003);
    expect(calls.filter((c) => c.op === "range").map((c) => c.args)).toEqual([[0, 999], [1000, 1999]]);
    expect(String(calls.find((c) => c.op === "select")?.args[0])).toContain("value::text");
  });

  it("stops after a short first page", async () => {
    const { admin, calls } = pagingAdmin(3);
    expect(await supabaseRecordReader(admin).revisions()).toHaveLength(3);
    expect(calls.filter((c) => c.op === "range")).toHaveLength(1);
    const select = String(calls.find((c) => c.op === "select")?.args[0]);
    expect(select).toContain("old_value::text");
    expect(select).toContain("new_value::text");
  });

  it("pages every table on a unique order, so no row repeats or drops between pages", async () => {
    // A resolved gap and its recurrence share (date, series, reason_code)
    //: without the id, rows tied on the order can swap
    // between two page reads.
    for (const read of ["values", "gaps", "revisions"] as const) {
      const { admin, calls } = pagingAdmin(0);
      await supabaseRecordReader(admin)[read]();
      const order = calls.filter((c) => c.op === "order").map((c) => c.args[0]);
      const expected = { values: ["date", "series"], gaps: ["date", "series", "reason_code", "id"], revisions: ["revised_at", "id"] }[read];
      expect(order, read).toEqual(expected);
    }
  });
});

describe("apiCacheFileCache", () => {
  it("stores files in chunks keyed by path, and the manifest through setCached", async () => {
    const { admin, calls } = pagingAdmin(0);
    const cache = apiCacheFileCache(admin);
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `days/2026-09-${String(i + 1).padStart(2, "0")}.json`, body: "{}", content_type: "application/json; charset=utf-8",
      sha256: "s", content_sha256: "c", generation_id: "g1", rows: null,
    }));
    await cache.putFiles(files);
    const upserts = calls.filter((c) => c.op === "upsert");
    expect(upserts).toHaveLength(2);
    expect(upserts.every((u) => u.table === "api_cache")).toBe(true);
    expect((upserts[0].args[0] as Array<{ key: string }>)[0].key).toBe("open-record:v1:file:days/2026-09-01.json");
    expect((upserts[0].args[0] as unknown[]).length).toBe(25);
    expect(upserts[0].args[1]).toEqual({ onConflict: "key" });
    await cache.putManifest({ generation_id: "g1" } as never);
    expect(setCached).toHaveBeenCalledWith("open-record:v1:manifest", { generation_id: "g1" }, { source: "network-record-render" });
  });

  it("reports a missing manifest as a miss", async () => {
    const { admin } = pagingAdmin(0);
    expect(await apiCacheFileCache(admin).manifest()).toEqual({ status: "miss" });
  });
});
