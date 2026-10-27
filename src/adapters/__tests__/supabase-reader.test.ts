import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryCacheStore, setCacheStoreBackend } from "../../runtime/cache-store";
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
    // A resolved gap and its recurrence can share (date, series, reason_code):
    // without the id, rows tied on the order can swap between two page reads.
    for (const read of ["values", "gaps", "revisions"] as const) {
      const { admin, calls } = pagingAdmin(0);
      await supabaseRecordReader(admin)[read]();
      const order = calls.filter((c) => c.op === "order").map((c) => c.args[0]);
      const expected = { values: ["date", "series"], gaps: ["date", "series", "reason_code", "id"], revisions: ["revised_at", "id"] }[read];
      expect(order, read).toEqual(expected);
    }
  });
});

/** An api_cache table in memory: upsert on key, and select(...).eq("key", k).maybeSingle(). */
function apiCacheAdmin(opts: { readError?: { code: string; message: string } } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const upserts: Array<{ rows: Array<Record<string, unknown>>; options: unknown }> = [];
  const admin = {
    from: (table: string) => {
      if (table !== "api_cache") throw new Error(`unexpected table ${table}`);
      return {
        upsert: (value: Record<string, unknown> | Array<Record<string, unknown>>, options: unknown) => {
          const list = Array.isArray(value) ? value : [value];
          upserts.push({ rows: list, options });
          for (const r of list) rows.set(String(r.key), structuredClone(r));
          return Promise.resolve({ error: null });
        },
        select: () => ({
          eq: (_column: string, key: string) => ({
            maybeSingle: () =>
              Promise.resolve(
                opts.readError
                  ? { data: null, error: opts.readError }
                  : { data: rows.has(key) ? { value: structuredClone(rows.get(key)!.value) } : null, error: null },
              ),
          }),
        }),
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, rows, upserts };
}

describe("apiCacheFileCache", () => {
  // The runtime cache store starts empty in every test, so a manifest can only
  // come back from the api_cache table itself.
  beforeEach(() => {
    setCacheStoreBackend(memoryCacheStore());
  });

  it("stores files in chunks keyed by path", async () => {
    const { admin, upserts } = apiCacheAdmin();
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `days/2026-09-${String(i + 1).padStart(2, "0")}.json`, body: "{}", content_type: "application/json; charset=utf-8",
      sha256: "s", content_sha256: "c", generation_id: "g1", rows: null,
    }));
    await apiCacheFileCache(admin).putFiles(files);
    expect(upserts).toHaveLength(2);
    expect(upserts[0].rows[0].key).toBe("open-record:v1:file:days/2026-09-01.json");
    expect(upserts[0].rows).toHaveLength(25);
    expect(upserts[0].options).toEqual({ onConflict: "key" });
  });

  it("writes the manifest to api_cache, where a cache in another process reads it back", async () => {
    const { admin, rows } = apiCacheAdmin();
    await apiCacheFileCache(admin).putManifest({ generation_id: "g1" } as never);
    expect(rows.get("open-record:v1:manifest")).toMatchObject({ value: { generation_id: "g1" }, source: "network-record-render" });
    // A process that starts later has an empty runtime cache store.
    setCacheStoreBackend(memoryCacheStore());
    expect(await apiCacheFileCache(admin).manifest()).toEqual({ status: "hit", value: { generation_id: "g1" } });
  });

  it("reports a missing manifest as a miss, and a failed read as an error", async () => {
    expect(await apiCacheFileCache(apiCacheAdmin().admin).manifest()).toEqual({ status: "miss" });
    const failing = apiCacheAdmin({ readError: { code: "57014", message: "canceling statement due to statement timeout" } });
    expect(await apiCacheFileCache(failing.admin).manifest()).toEqual({ status: "error" });
  });
});
