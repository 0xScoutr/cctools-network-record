/**
 * The RecordStore on Supabase (PostgREST), as the CCTools deployment runs it.
 * Numerics are read as text (`col::text`): PostgREST serialises numeric as a
 * JSON number otherwise, and supply needs about 21 significant digits. Every
 * filter is on a key or an indexed column, and no read may run into
 * PostgREST's 1,000-row response cap unnoticed.
 *
 * getSupplyAt reads the registry supply readings from the operator's own
 * asset tables (OPERATOR_SUPPLY below), which the CCTools deployment's supply
 * collector writes and which are not part of sql/schema.sql. The Postgres
 * reference adapter reads network_record_supply (sql/supply.sql) instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CURSOR_RENDER,
  ISSUANCE_CATEGORIES,
  REVISE_RPC,
} from "../open-record/contract";
import {
  RecordStoreError,
  VALUE_DATE_SERIES,
  type CursorRow,
  type RecordStore,
  type RoundRow,
  type SnapshotRow,
} from "../scan-record/store";
import type { GapRow, ValueRow } from "../open-record/contract";

type Admin = SupabaseClient;

const ROUND_SELECT = [
  "round", "opens_at", "start_issuing_at", "closed_at", "tick_duration_us", "issuance_config", "amulet_price::text",
  ...ISSUANCE_CATEGORIES.map((c) => `${c}::text`),
  "split", "issuing_contract_id", "update_id", "migration_id", "source_host", "method", "repaired",
].join(", ");
const SNAPSHOT_SELECT =
  "date, record_time, migration_id, source_host, method, last_round, reference_round, reference_price_usd::text, " +
  "super_validators, sv_voting_threshold, featured_apps, validator_licenses";
const VALUE_SELECT =
  "date, series, value::text, status, source_host, method, as_of, retrieved_at, finalized_at, revision, revised_at";
const GAP_SELECT = "date, series, reason_code, reason, status, detected_at, resolved_at, evidence_url";
const MAX_ROWS = 1_000;

const CC_REGISTRY_HOST = "api.cantonnodes.com";

/**
 * The operator's own supply tables, outside sql/schema.sql: the asset row of
 * CC's Scan registry, and the readings stored for it, one per totalSupplyAsOf
 * instant, tagged with the source they came from.
 */
const OPERATOR_SUPPLY = { assets: "assets", readings: "asset_supply_snapshots", source: "scan_registry" } as const;

function fail(what: string, error: { code?: string; message: string }): Error {
  return new RecordStoreError(what, error);
}

export function supabaseRecordStore(admin: Admin): RecordStore {
  let ccAssetId: string | null | undefined;

  async function upsert(table: string, rows: readonly object[], onConflict: string, what: string): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await admin.from(table).upsert(rows as unknown as Record<string, unknown>[], { onConflict });
    if (error) throw fail(what, error);
  }

  return {
    async getCursor(id) {
      const { data, error } = await admin
        .from("scan_record_cursor").select("id, last_round, last_date, last_poll_at, detail").eq("id", id).maybeSingle();
      if (error) throw fail("read cursor", error);
      return (data as CursorRow | null) ?? null;
    },

    async setCursor(row) {
      await upsert("scan_record_cursor", [{ ...row, updated_at: new Date().toISOString() }], "id", "write cursor");
    },

    upsertRoundMeta: (rows) => upsert("network_record_rounds", rows, "round", "write round meta"),
    upsertRoundCaptures: (rows) => upsert("network_record_rounds", rows, "round", "write round capture"),
    upsertRoundTotals: (rows) => upsert("network_record_rounds", rows, "round", "write round totals"),

    async getRounds(from, to) {
      if (to - from + 1 > MAX_ROWS) throw new Error(`[scan-record] getRounds ${from}..${to} exceeds the 1,000-row cap`);
      const { data, error } = await admin
        .from("network_record_rounds").select(ROUND_SELECT).gte("round", from).lte("round", to).order("round");
      if (error) throw fail("read rounds", error);
      return (data ?? []) as unknown as RoundRow[];
    },

    async getRoundsStartedBetween(fromIso, toIso) {
      const { data, error } = await admin
        .from("network_record_rounds").select(ROUND_SELECT)
        .gte("start_issuing_at", fromIso).lt("start_issuing_at", toIso).order("round");
      if (error) throw fail("read rounds by start", error);
      const rows = (data ?? []) as unknown as RoundRow[];
      if (rows.length >= MAX_ROWS) throw new Error("[scan-record] more than 1,000 rounds in one day");
      return rows;
    },

    async getSnapshot(date) {
      const { data, error } = await admin
        .from("network_record_snapshots").select(SNAPSHOT_SELECT).eq("date", date).maybeSingle();
      if (error) throw fail("read snapshot", error);
      return (data as unknown as SnapshotRow | null) ?? null;
    },

    async listSnapshotDates(from, to) {
      const dates: string[] = [];
      // Paged on the primary key, like listValueDates: the backfill lists the
      // whole record span, which passes 1,000 days.
      for (let offset = 0; ; ) {
        const { data, error } = await admin
          .from("network_record_snapshots").select("date").gte("date", from).lte("date", to)
          .order("date").range(offset, offset + MAX_ROWS - 1);
        if (error) throw fail("list snapshots", error);
        const rows = (data ?? []) as Array<{ date: string }>;
        if (rows.length === 0) break;
        for (const r of rows) dates.push(r.date);
        offset += rows.length;
      }
      return dates;
    },

    async listSnapshotsMissingLicenses(from, to) {
      const rows: SnapshotRow[] = [];
      for (let offset = 0; ; ) {
        const { data, error } = await admin
          .from("network_record_snapshots").select(SNAPSHOT_SELECT).is("validator_licenses", null)
          .gte("date", from).lte("date", to).order("date").range(offset, offset + MAX_ROWS - 1);
        if (error) throw fail("list snapshots missing licenses", error);
        const page = (data ?? []) as unknown as SnapshotRow[];
        if (page.length === 0) break;
        rows.push(...page);
        offset += page.length;
      }
      return rows;
    },

    async upsertSnapshot(row) {
      // PostgREST's upsert sets only the columns it is sent; an insert leaves the count null.
      const { validator_licenses, ...core } = row;
      const fields = validator_licenses == null ? core : row;
      await upsert("network_record_snapshots", [{ ...fields, retrieved_at: new Date().toISOString() }], "date", "write snapshot");
    },

    async insertSnapshot(row) {
      const { error } = await admin
        .from("network_record_snapshots")
        .insert({ ...row, retrieved_at: new Date().toISOString() } as unknown as Record<string, unknown>);
      if (!error) return true;
      if (error.code === "23505") return false;
      throw fail("insert snapshot", error);
    },

    async getValues(date) {
      const { data, error } = await admin.from("network_record_values").select(VALUE_SELECT).eq("date", date);
      if (error) throw fail("read values", error);
      return (data ?? []) as unknown as ValueRow[];
    },

    async listValueDates(from, to) {
      const dates = new Set<string>();
      // One series, so one row per day. Ordered on the primary key so the
      // pages neither skip nor repeat a row; it stops on an empty page, so a
      // server row cap below MAX_ROWS cannot end it early.
      for (let offset = 0; ; ) {
        const { data, error } = await admin
          .from("network_record_values").select("date").eq("series", VALUE_DATE_SERIES).gte("date", from).lte("date", to)
          .order("date").range(offset, offset + MAX_ROWS - 1);
        if (error) throw fail("list value dates", error);
        const rows = (data ?? []) as Array<{ date: string }>;
        if (rows.length === 0) break;
        for (const r of rows) dates.add(r.date);
        offset += rows.length;
      }
      return [...dates].sort();
    },

    upsertValues: (rows) => upsert("network_record_values", rows, "date,series", "write values"),

    async revise(date, series, value, kind, reason, sourceHost, asOf, method) {
      // A null leaves each to the RPC: the row's own (a withdrawal clears the host and as_of).
      const { data, error } = await admin.rpc(REVISE_RPC, {
        p_date: date, p_series: series, p_value: value, p_kind: kind, p_reason: reason,
        p_method: method ?? null, p_source_host: sourceHost ?? null, p_as_of: asOf ?? null,
      });
      if (error) throw fail("revise", error);
      return Number(data);
    },

    async getGaps(date) {
      const { data, error } = await admin.from("network_record_gaps").select(GAP_SELECT).eq("date", date);
      if (error) throw fail("read gaps", error);
      return (data ?? []) as unknown as GapRow[];
    },

    async upsertGap(gap) {
      // One open row per (date, series, reason_code): a partial unique index
      // that PostgREST's on_conflict cannot target. Update
      // the open row if there is one; otherwise insert, so a resolved gap that
      // recurs keeps its resolved_at and gets a new row.
      const { data, error } = await admin
        .from("network_record_gaps").select("id").eq("date", gap.date).eq("series", gap.series)
        .eq("reason_code", gap.reason_code).is("resolved_at", null).limit(1);
      if (error) throw fail("read gap", error);
      const open = (data as Array<{ id: number }> | null)?.[0];
      const fields = { reason: gap.reason, status: gap.status, evidence_url: gap.evidence_url ?? null };
      const res = open
        ? await admin.from("network_record_gaps").update(fields).eq("id", open.id)
        : await admin.from("network_record_gaps").insert({ date: gap.date, series: gap.series, reason_code: gap.reason_code, ...fields });
      if (res.error) throw fail("write gap", res.error);
    },

    async resolveGaps(date, series, atIso, keep) {
      let q = admin
        .from("network_record_gaps").update({ status: "resolved", resolved_at: atIso })
        .eq("date", date).eq("series", series).is("resolved_at", null);
      if (keep) q = q.neq("reason_code", keep);
      const { error } = await q;
      if (error) throw fail("resolve gaps", error);
    },

    async getSupplyAt(instantIso) {
      if (ccAssetId === undefined) {
        const { data, error } = await admin
          .from(OPERATOR_SUPPLY.assets).select("id").eq("instrument_id", "Amulet")
          .ilike("registry_base_url", `%${CC_REGISTRY_HOST}%`).limit(1).maybeSingle();
        if (error) throw fail("read CC asset", error);
        ccAssetId = (data as { id: string } | null)?.id ?? null;
      }
      if (!ccAssetId) return null;
      const { data, error } = await admin
        .from(OPERATOR_SUPPLY.readings).select("total_supply::text")
        .eq("asset_id", ccAssetId).eq("source", OPERATOR_SUPPLY.source).eq("supply_as_of", instantIso).maybeSingle();
      if (error) throw fail("read supply", error);
      const row = data as { total_supply: string } | null;
      return row ? { value: row.total_supply, source_host: CC_REGISTRY_HOST } : null;
    },

    markDirty: (atIso) =>
      upsert(
        "scan_record_cursor",
        [{ id: CURSOR_RENDER, detail: { dirty_at: atIso }, updated_at: atIso }],
        "id",
        "mark dirty",
      ),
  };
}
