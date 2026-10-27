/**
 * The reference RecordStore and RecordReader on plain Postgres, against
 * sql/schema.sql, and the SupplyWriter whose readings getSupplyAt reads back
 * (sql/supply.sql).
 *
 * It takes any client with `query(text, params)` that answers `{ rows }`:
 * a node-postgres Pool or Client, or an in-process Postgres such as PGlite
 * (the tests). Every write goes through the same guards as the CCTools
 * deployment's Supabase adapter, because the guards live in the schema: a
 * final value changes only through revise_network_record(), a multi-row
 * upsert is one statement, and a refusal comes back with its SQLSTATE as a
 * RecordStoreError, so finalize matches RECORD_SQLSTATE by code.
 *
 * Every value leaves the database as text and is converted here, never by a
 * driver's type parsers: numerics stay exact decimal text, dates are
 * YYYY-MM-DD, and timestamps are ISO 8601 in UTC with microseconds.
 */

import {
  CURSOR_RENDER,
  ISSUANCE_CATEGORIES,
  REVISE_RPC,
  type GapRow,
  type RevisionRow,
  type ValueRow,
} from "../open-record/contract";
import type { RecordReader } from "../open-record/publish";
import type { SupplyWriter } from "../scan-record/supply";
import {
  RecordStoreError,
  VALUE_DATE_SERIES,
  type CursorRow,
  type RecordStore,
  type RoundRow,
  type SnapshotRow,
} from "../scan-record/store";

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const MAX_ROWS = 1_000;
const UNIQUE_VIOLATION = "23505";

/** A timestamptz column as ISO 8601 text in UTC. */
const ts = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const ROUND_SELECT = [
  "round::text as round", `${ts("opens_at")} as opens_at`, `${ts("start_issuing_at")} as start_issuing_at`,
  `${ts("closed_at")} as closed_at`, "tick_duration_us::text as tick_duration_us", "issuance_config",
  "amulet_price::text as amulet_price",
  ...ISSUANCE_CATEGORIES.map((c) => `${c}::text as ${c}`),
  "split", "issuing_contract_id", "update_id", "migration_id", "source_host", "method", "repaired",
].join(", ");
const SNAPSHOT_SELECT = [
  "date::text as date", `${ts("record_time")} as record_time`, "migration_id", "source_host", "method",
  "last_round::text as last_round", "reference_round::text as reference_round",
  "reference_price_usd::text as reference_price_usd", "super_validators", "sv_voting_threshold", "featured_apps",
  "validator_licenses",
].join(", ");
const VALUE_SELECT = [
  "date::text as date", "series", "value::text as value", "status", "source_host", "method", `${ts("as_of")} as as_of`,
  `${ts("retrieved_at")} as retrieved_at`, `${ts("finalized_at")} as finalized_at`, "revision",
  `${ts("revised_at")} as revised_at`,
].join(", ");
const GAP_SELECT = [
  "date::text as date", "series", "reason_code", "reason", "status", `${ts("detected_at")} as detected_at`,
  `${ts("resolved_at")} as resolved_at`, "evidence_url",
].join(", ");
const REVISION_SELECT = [
  "date::text as date", "series", "old_value::text as old_value", "new_value::text as new_value", "kind", "reason",
  "method", `${ts("revised_at")} as revised_at`,
].join(", ");

/** The SQL type of every column a write sends, so a parameter is cast and JSON is sent as text. */
const COLUMN_TYPES: Record<string, string> = {
  round: "bigint", opens_at: "timestamptz", start_issuing_at: "timestamptz", closed_at: "timestamptz",
  tick_duration_us: "bigint", issuance_config: "jsonb", amulet_price: "numeric",
  ...Object.fromEntries(ISSUANCE_CATEGORIES.map((c) => [c, "numeric"])),
  split: "jsonb", issuing_contract_id: "text", update_id: "text", migration_id: "integer", source_host: "text",
  method: "text", repaired: "boolean", date: "date", record_time: "timestamptz", last_round: "bigint",
  reference_round: "bigint", reference_price_usd: "numeric", super_validators: "integer",
  sv_voting_threshold: "integer", featured_apps: "integer", validator_licenses: "integer", retrieved_at: "timestamptz",
  id: "text", last_date: "date", last_poll_at: "timestamptz", detail: "jsonb", updated_at: "timestamptz",
  series: "text", value: "numeric", status: "text", as_of: "timestamptz", finalized_at: "timestamptz",
};

const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toRound(r: Record<string, unknown>): RoundRow {
  return { ...(r as unknown as RoundRow), round: Number(r.round), tick_duration_us: num(r.tick_duration_us) };
}

function toSnapshot(r: Record<string, unknown>): SnapshotRow {
  return {
    ...(r as unknown as SnapshotRow),
    last_round: num(r.last_round),
    reference_round: num(r.reference_round),
  };
}

function param(column: string, value: unknown): unknown {
  if (value == null) return null;
  return COLUMN_TYPES[column] === "jsonb" ? JSON.stringify(value) : value;
}

function fail(what: string, err: unknown): RecordStoreError {
  const e = err as { code?: unknown; message?: unknown };
  return new RecordStoreError(what, {
    code: typeof e?.code === "string" ? e.code : undefined,
    message: typeof e?.message === "string" ? e.message : String(err),
  });
}

/** INSERT ... ON CONFLICT DO UPDATE of exactly the columns the rows carry, in one statement. */
function upsertSql(table: string, rows: readonly object[], conflict: string[], extra: Record<string, string> = {}) {
  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const r = row as Record<string, unknown>;
    const cells = columns.map((c) => {
      params.push(param(c, r[c]));
      return `$${params.length}::${COLUMN_TYPES[c] ?? "text"}`;
    });
    return `(${[...cells, ...Object.values(extra)].join(", ")})`;
  });
  const all = [...columns, ...Object.keys(extra)];
  const updates = all.filter((c) => !conflict.includes(c)).map((c) => `${c} = excluded.${c}`);
  const text =
    `insert into public.${table} (${all.join(", ")}) values ${tuples.join(", ")} ` +
    `on conflict (${conflict.join(", ")}) ` +
    (updates.length > 0 ? `do update set ${updates.join(", ")}` : "do nothing");
  return { text, params };
}

export function postgresRecordStore(db: SqlClient): RecordStore {
  async function run(what: string, text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    try {
      return (await db.query(text, params)).rows;
    } catch (err) {
      throw fail(what, err);
    }
  }

  async function upsert(table: string, rows: readonly object[], conflict: string[], what: string, extra?: Record<string, string>) {
    if (rows.length === 0) return;
    const { text, params } = upsertSql(table, rows, conflict, extra);
    await run(what, text, params);
  }

  async function pagedDates(what: string, text: string, params: unknown[]): Promise<string[]> {
    const out: string[] = [];
    for (let offset = 0; ; offset += MAX_ROWS) {
      const rows = await run(what, `${text} limit ${MAX_ROWS} offset ${offset}`, params);
      for (const r of rows) out.push(String(r.date));
      if (rows.length < MAX_ROWS) return out;
    }
  }

  return {
    async getCursor(id) {
      const rows = await run(
        "read cursor",
        `select id, last_round::text as last_round, last_date::text as last_date, ${ts("last_poll_at")} as last_poll_at, detail
           from public.scan_record_cursor where id = $1`,
        [id],
      );
      const r = rows[0];
      return r ? ({ ...(r as unknown as CursorRow), last_round: num(r.last_round) } as CursorRow) : null;
    },

    async setCursor(row) {
      await upsert("scan_record_cursor", [row], ["id"], "write cursor", { updated_at: "now()" });
    },

    upsertRoundMeta: (rows) => upsert("network_record_rounds", rows, ["round"], "write round meta"),
    upsertRoundCaptures: (rows) => upsert("network_record_rounds", rows, ["round"], "write round capture"),
    upsertRoundTotals: (rows) => upsert("network_record_rounds", rows, ["round"], "write round totals"),

    async getRounds(from, to) {
      if (to - from + 1 > MAX_ROWS) throw new Error(`[scan-record] getRounds ${from}..${to} exceeds the 1,000-row cap`);
      const rows = await run(
        "read rounds",
        `select ${ROUND_SELECT} from public.network_record_rounds where round >= $1 and round <= $2 order by round`,
        [from, to],
      );
      return rows.map(toRound);
    },

    async getRoundsStartedBetween(fromIso, toIso) {
      const rows = await run(
        "read rounds by start",
        `select ${ROUND_SELECT} from public.network_record_rounds
          where start_issuing_at >= $1::timestamptz and start_issuing_at < $2::timestamptz order by round limit ${MAX_ROWS}`,
        [fromIso, toIso],
      );
      if (rows.length >= MAX_ROWS) throw new Error("[scan-record] more than 1,000 rounds in one day");
      return rows.map(toRound);
    },

    async getSnapshot(date) {
      const rows = await run("read snapshot", `select ${SNAPSHOT_SELECT} from public.network_record_snapshots where date = $1::date`, [date]);
      return rows[0] ? toSnapshot(rows[0]) : null;
    },

    listSnapshotDates: (from, to) =>
      pagedDates(
        "list snapshots",
        "select date::text as date from public.network_record_snapshots where date >= $1::date and date <= $2::date order by date",
        [from, to],
      ),

    async listSnapshotsMissingLicenses(from, to) {
      const out: SnapshotRow[] = [];
      for (let offset = 0; ; offset += MAX_ROWS) {
        const rows = await run(
          "list snapshots missing licenses",
          `select ${SNAPSHOT_SELECT} from public.network_record_snapshots
            where validator_licenses is null and date >= $1::date and date <= $2::date
            order by date limit ${MAX_ROWS} offset ${offset}`,
          [from, to],
        );
        out.push(...rows.map(toSnapshot));
        if (rows.length < MAX_ROWS) return out;
      }
    },

    async upsertSnapshot(row) {
      // Only the columns sent are updated: a null count is left out, so a stored one survives.
      const { validator_licenses, ...core } = row;
      const fields = validator_licenses == null ? core : row;
      await upsert("network_record_snapshots", [fields], ["date"], "write snapshot", { retrieved_at: "now()" });
    },

    async insertSnapshot(row) {
      const columns = Object.keys(row) as Array<keyof SnapshotRow>;
      const params = columns.map((c) => param(c, row[c]));
      const cells = columns.map((c, i) => `$${i + 1}::${COLUMN_TYPES[c] ?? "text"}`);
      try {
        await db.query(
          `insert into public.network_record_snapshots (${columns.join(", ")}, retrieved_at) values (${cells.join(", ")}, now())`,
          params,
        );
        return true;
      } catch (err) {
        if ((err as { code?: unknown })?.code === UNIQUE_VIOLATION) return false;
        throw fail("insert snapshot", err);
      }
    },

    async getValues(date) {
      const rows = await run("read values", `select ${VALUE_SELECT} from public.network_record_values where date = $1::date`, [date]);
      return rows as unknown as ValueRow[];
    },

    listValueDates: (from, to) =>
      pagedDates(
        "list value dates",
        `select date::text as date from public.network_record_values
          where series = $3 and date >= $1::date and date <= $2::date order by date`,
        [from, to, VALUE_DATE_SERIES],
      ),

    upsertValues: (rows) => upsert("network_record_values", rows, ["date", "series"], "write values"),

    async revise(date, series, value, kind, reason, sourceHost, asOf, method) {
      const rows = await run(
        "revise",
        `select public.${REVISE_RPC}($1::date, $2, $3::numeric, $4, $5, $6, $7, $8::timestamptz) as revision`,
        [date, series, value, kind, reason, method ?? null, sourceHost ?? null, asOf ?? null],
      );
      return Number(rows[0]?.revision);
    },

    async getGaps(date) {
      const rows = await run("read gaps", `select ${GAP_SELECT} from public.network_record_gaps where date = $1::date`, [date]);
      return rows as unknown as GapRow[];
    },

    async upsertGap(gap) {
      // One open row per (date, series, reason_code), a partial unique index:
      // update the open row if there is one, else insert, so a resolved gap
      // that recurs keeps its resolved_at and gets a new row.
      const open = await run(
        "read gap",
        `select id from public.network_record_gaps
          where date = $1::date and series = $2 and reason_code = $3 and resolved_at is null limit 1`,
        [gap.date, gap.series, gap.reason_code],
      );
      const evidence = gap.evidence_url ?? null;
      if (open[0]) {
        await run(
          "write gap",
          "update public.network_record_gaps set reason = $2, status = $3, evidence_url = $4 where id = $1",
          [open[0].id, gap.reason, gap.status, evidence],
        );
      } else {
        await run(
          "write gap",
          `insert into public.network_record_gaps (date, series, reason_code, reason, status, evidence_url)
           values ($1::date, $2, $3, $4, $5, $6)`,
          [gap.date, gap.series, gap.reason_code, gap.reason, gap.status, evidence],
        );
      }
    },

    async resolveGaps(date, series, atIso, keep) {
      await run(
        "resolve gaps",
        `update public.network_record_gaps set status = 'resolved', resolved_at = $3::timestamptz
          where date = $1::date and series = $2 and resolved_at is null and ($4::text is null or reason_code <> $4::text)`,
        [date, series, atIso, keep ?? null],
      );
    },

    async getSupplyAt(instantIso) {
      const rows = await run(
        "read supply",
        "select total_supply::text as value, source_host from public.network_record_supply where supply_as_of = $1::timestamptz",
        [instantIso],
      );
      const r = rows[0];
      return r ? { value: String(r.value), source_host: String(r.source_host) } : null;
    },

    markDirty: (atIso) =>
      upsert("scan_record_cursor", [{ id: CURSOR_RENDER, detail: { dirty_at: atIso }, updated_at: atIso }], ["id"], "mark dirty"),
  };
}

/**
 * The supply collector's writer (scan-record/supply.ts): one row per
 * totalSupplyAsOf instant in network_record_supply. A reading of an instant
 * already stored is left as it is (a replica repeating it), as the CCTools
 * deployment keeps its own readings.
 */
export function postgresSupplyWriter(db: SqlClient): SupplyWriter {
  return {
    async recordSupplyReading(r) {
      let rows: Record<string, unknown>[];
      try {
        rows = (
          await db.query(
            `insert into public.network_record_supply (supply_as_of, total_supply, source_host)
              values ($1::timestamptz, $2::numeric, $3::text)
              on conflict (supply_as_of) do nothing
              returning 1 as inserted`,
            [r.supply_as_of, r.total_supply, r.source_host],
          )
        ).rows;
      } catch (err) {
        throw fail("write supply", err);
      }
      return rows.length > 0;
    },
  };
}

/** The rows publish.ts renders from, read in an order unique over each table. */
export function postgresRecordReader(db: SqlClient): RecordReader {
  const read = async <T>(what: string, text: string): Promise<T[]> => {
    try {
      return (await db.query(text)).rows as unknown as T[];
    } catch (err) {
      throw fail(what, err);
    }
  };
  return {
    values: () => read<ValueRow>("read values", `select ${VALUE_SELECT} from public.network_record_values order by date, series`),
    gaps: () =>
      read<GapRow>("read gaps", `select ${GAP_SELECT} from public.network_record_gaps order by date, series, reason_code, id`),
    revisions: () =>
      read<RevisionRow>("read revisions", `select ${REVISION_SELECT} from public.network_record_revisions order by revised_at, id`),
    async dirtyAt() {
      const rows = await read<{ detail: { dirty_at?: unknown } | null }>(
        "read render cursor",
        `select detail from public.scan_record_cursor where id = '${CURSOR_RENDER}'`,
      );
      const dirty = rows[0]?.detail?.dirty_at;
      return typeof dirty === "string" ? dirty : null;
    },
  };
}
