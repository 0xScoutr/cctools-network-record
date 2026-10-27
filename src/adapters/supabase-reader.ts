/**
 * The RecordReader and FileCache on Supabase (PostgREST), as the CCTools
 * deployment runs them: reads the record tables for rendering, and stores the
 * rendered files in its api_cache table. Numerics are read as text (PostgREST
 * would send a double) and every read pages past PostgREST's 1,000-row
 * response cap, which truncates silently. Rendering reads everything a few
 * times a day at most: publish.ts skips clean runs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCacheEntry, setCached } from "../runtime/cache-store";
import {
  CURSOR_RENDER,
  MANIFEST_KEY,
  fileCacheKey,
  type GapRow,
  type Manifest,
  type RevisionRow,
  type ValueRow,
} from "../open-record/contract";
import type { FileCache, RecordReader } from "../open-record/publish";

type Admin = SupabaseClient;

const PAGE = 1_000;
const FILE_CHUNK = 25;
const SOURCE = "network-record-render";

/**
 * `order` must be unique over the table: rows tied on it can swap between two
 * page reads, so one row would repeat and another drop.
 */
async function readAll<T>(admin: Admin, table: string, select: string, order: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = admin.from(table).select(select);
    for (const column of order) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(`[open-record] read ${table}: ${error.code} ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export function supabaseRecordReader(admin: Admin): RecordReader {
  return {
    values: () =>
      readAll<ValueRow>(
        admin,
        "network_record_values",
        "date, series, value::text, status, source_host, method, as_of, retrieved_at, finalized_at, revision, revised_at",
        ["date", "series"],
      ),
    // A resolved gap and its recurrence can share (date, series, reason_code),
    // so the id breaks the tie.
    gaps: () =>
      readAll<GapRow>(
        admin,
        "network_record_gaps",
        "date, series, reason_code, reason, status, detected_at, resolved_at, evidence_url",
        ["date", "series", "reason_code", "id"],
      ),
    revisions: () =>
      readAll<RevisionRow>(
        admin,
        "network_record_revisions",
        "date, series, old_value::text, new_value::text, kind, reason, method, revised_at",
        ["revised_at", "id"],
      ),
    async dirtyAt() {
      const { data, error } = await admin.from("scan_record_cursor").select("detail").eq("id", CURSOR_RENDER).maybeSingle();
      if (error) throw new Error(`[open-record] read render cursor: ${error.code} ${error.message}`);
      const dirty = (data as { detail?: { dirty_at?: unknown } } | null)?.detail?.dirty_at;
      return typeof dirty === "string" ? dirty : null;
    },
  };
}

export function apiCacheFileCache(admin: Admin): FileCache {
  return {
    async manifest() {
      const entry = await getCacheEntry<Manifest>(MANIFEST_KEY);
      if (entry.status === "hit") return { status: "hit", value: entry.value };
      return entry;
    },
    async putFiles(files) {
      for (let i = 0; i < files.length; i += FILE_CHUNK) {
        const rows = files.slice(i, i + FILE_CHUNK).map((f) => ({ key: fileCacheKey(f.path), value: f, source: SOURCE, expires_at: null }));
        const { error } = await admin.from("api_cache").upsert(rows, { onConflict: "key" });
        if (error) throw new Error(`[open-record] write files: ${error.code} ${error.message}`);
      }
    },
    putManifest: (manifest) => setCached(MANIFEST_KEY, manifest, { source: SOURCE }),
  };
}
