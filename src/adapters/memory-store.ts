/**
 * A RecordStore in memory that keeps the database's promises (sql/schema.sql): a final value cannot change outside revise(), an identical rewrite
 * of a final row is a no-op, a withdrawal lasts until a correction and clears
 * the row's source host and as_of, a revision whose value is unchanged is a
 * no-op, a value is never stored without its source host and as_of, and
 * numerics come back as numeric(38,10) text. Refusals throw RecordStoreError
 * with the SQLSTATE the database would raise: RECORD_SQLSTATE for the two that
 * normal operation meets, 23514 for the table's provenance check, P0001 for
 * every other.
 */
import { RECORD_SQLSTATE, type GapRow, type Manifest, type RevisionRow, type StoredFile, type ValueRow } from "../open-record/contract";
import type { FileCache, RecordReader } from "../open-record/publish";
import { dec, format } from "../scan-record/decimal";
import {
  RecordStoreError,
  VALUE_DATE_SERIES,
  blankRound,
  type CursorRow,
  type RecordStore,
  type RoundRow,
  type SnapshotRow,
} from "../scan-record/store";

export interface MemoryState {
  rounds: Map<number, RoundRow>;
  snapshots: Map<string, SnapshotRow>;
  values: Map<string, ValueRow>;
  gaps: GapRow[];
  revisions: RevisionRow[];
  cursors: Map<string, CursorRow>;
  /** Keyed by the exact instant, e.g. "2026-10-06T00:00:00Z". */
  supply: Map<string, string>;
  dirtyAt: string | null;
}

const P0001 = "P0001";
const CHECK_VIOLATION = "23514";
const key = (date: string, series: string) => `${date}|${series}`;
const numeric = (v: string | null) => (v == null ? null : format(dec(v), 10));
const same = (a: string | null, b: string | null) => (a == null || b == null ? a === b : dec(a) === dec(b));
const sameInstant = (a: string | null, b: string | null) =>
  a == null || b == null ? a === b : Date.parse(a) === Date.parse(b);
const refused = (code: string, message: string) => new RecordStoreError("memory store", { code, message });

export function memoryStore(): { store: RecordStore; state: MemoryState } {
  const state: MemoryState = {
    rounds: new Map(), snapshots: new Map(), values: new Map(), gaps: [], revisions: [],
    cursors: new Map(), supply: new Map(), dirtyAt: null,
  };
  const merge = <T extends { round: number; source_host: string }>(rows: T[]) => {
    for (const r of rows) state.rounds.set(r.round, { ...(state.rounds.get(r.round) ?? blankRound(r.round, r.source_host)), ...r });
  };
  const isOpenWithdrawn = (g: GapRow) => g.reason_code === "withdrawn" && g.resolved_at == null;
  const withdrawn = (date: string, series: string) =>
    state.gaps.some((g) => g.date === date && g.series === series && isOpenWithdrawn(g));

  const store: RecordStore = {
    async getCursor(id) { return state.cursors.get(id) ?? null; },
    async setCursor(row) { state.cursors.set(row.id, row); },
    async upsertRoundMeta(rows) { merge(rows); },
    async upsertRoundCaptures(rows) { merge(rows); },
    async upsertRoundTotals(rows) { merge(rows); },
    async getRounds(from, to) {
      return [...state.rounds.values()].filter((r) => r.round >= from && r.round <= to).sort((a, b) => a.round - b.round);
    },
    async getRoundsStartedBetween(fromIso, toIso) {
      const f = Date.parse(fromIso);
      const t = Date.parse(toIso);
      return [...state.rounds.values()]
        .filter((r) => r.start_issuing_at != null && Date.parse(r.start_issuing_at) >= f && Date.parse(r.start_issuing_at) < t)
        .sort((a, b) => a.round - b.round);
    },
    async getSnapshot(date) { return state.snapshots.get(date) ?? null; },
    async listSnapshotDates(from, to) { return [...state.snapshots.keys()].filter((d) => d >= from && d <= to).sort(); },
    async listSnapshotsMissingLicenses(from, to) {
      return [...state.snapshots.values()]
        .filter((s) => s.validator_licenses == null && s.date >= from && s.date <= to)
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((s) => ({ ...s }));
    },
    async upsertSnapshot(row) {
      // Like the database stores, which leave a null count out of the write: it never erases a stored one.
      const stored = state.snapshots.get(row.date)?.validator_licenses ?? null;
      state.snapshots.set(row.date, { ...row, validator_licenses: row.validator_licenses ?? stored });
    },
    async insertSnapshot(row) {
      // Like the plain insert the primary key refuses: a stored day is never written over.
      if (state.snapshots.has(row.date)) return false;
      state.snapshots.set(row.date, { ...row });
      return true;
    },
    async getValues(date) { return [...state.values.values()].filter((v) => v.date === date).map((v) => ({ ...v })); },
    async listValueDates(from, to) {
      // Like the database stores, which read one series per day.
      return [...state.values.values()]
        .filter((v) => v.series === VALUE_DATE_SERIES && v.date >= from && v.date <= to)
        .map((v) => v.date)
        .sort();
    },
    async upsertValues(rows) {
      // One statement, like the database upsert: a refused row writes nothing.
      const apply: ValueRow[] = [];
      for (const w of rows) {
        const old = state.values.get(key(w.date, w.series));
        const value = numeric(w.value);
        if (old?.status === "final") {
          // The guard's `is not distinct from` on four columns; as_of is a timestamptz.
          const identical = w.status === "final" && same(old.value, value) && old.method === w.method
            && old.source_host === w.source_host && sameInstant(old.as_of, w.as_of);
          if (identical) continue;
          throw withdrawn(w.date, w.series)
            ? refused(RECORD_SQLSTATE.WITHDRAWN,
                `network_record_values ${w.date} ${w.series} was withdrawn; only a correction through revise_network_record() restores it`)
            : refused(RECORD_SQLSTATE.FINAL_CHANGED,
                `network_record_values ${w.date} ${w.series} is final; change it through revise_network_record()`);
        }
        if (value != null && (w.source_host == null || w.as_of == null)) {
          // The table check, checked after the BEFORE trigger, as check_violation (23514).
          throw refused(CHECK_VIOLATION,
            `new row for relation "network_record_values" violates check constraint "network_record_values_provenance": `
              + `${w.date} ${w.series} has a value without its source host and as_of`);
        }
        apply.push({ ...w, value, revision: old?.revision ?? 0, revised_at: old?.revised_at ?? null });
      }
      for (const row of apply) state.values.set(key(row.date, row.series), row);
    },
    async revise(date, series, value, kind, reason, sourceHost, asOf, method) {
      // The checks of revise_network_record(), in its order, with its SQLSTATEs.
      const k = key(date, series);
      const old = state.values.get(k);
      const next = numeric(value);
      if (reason.trim() === "") throw refused(P0001, "a revision needs a reason");
      if (!old) throw refused(P0001, `no value for ${date} ${series}`);
      if (old.status !== "final") throw refused(P0001, `${date} ${series} is provisional; write it directly`);
      if (kind === "withdrawal" && next != null) throw refused(P0001, "a withdrawal sets the value to null");
      if (next == null && kind !== "withdrawal") throw refused(P0001, "only a withdrawal sets a value to null");
      if (kind === "backfill" && old.value != null) throw refused(P0001, "a backfill fills a null");
      if (kind !== "correction" && next != null && withdrawn(date, series)) {
        throw refused(RECORD_SQLSTATE.WITHDRAWN, `${date} ${series} was withdrawn; only a correction can restore it`);
      }
      // A withdrawn row names no host and no as_of, so a restoring correction must pass both.
      const host = kind === "withdrawal" ? null : sourceHost ?? old.source_host;
      const instant = kind === "withdrawal" ? null : asOf ?? old.as_of;
      if (next != null && (host == null || instant == null)) {
        throw refused(P0001,
          `${date} ${series} would publish a value without its source host and as_of; pass p_source_host and p_as_of`);
      }
      // coalesce(p_method, v_old.method): the value row and its logged revision both carry it.
      const label = method ?? old.method;
      // The value alone decides: an unchanged value logs nothing and keeps the stored provenance.
      const unchanged = same(old.value, next);
      if (unchanged && (kind !== "withdrawal" || withdrawn(date, series))) return old.revision;

      const at = new Date().toISOString();
      let revision = old.revision;
      if (!unchanged) {
        revision = old.revision + 1;
        state.revisions.push({ date, series, old_value: old.value, new_value: next, kind, reason, method: label, revised_at: at });
        state.values.set(k, { ...old, value: next, method: label, source_host: host, as_of: instant, revision, revised_at: at, retrieved_at: at });
      }
      if (kind === "withdrawal") {
        const open = state.gaps.find((g) => g.date === date && g.series === series && isOpenWithdrawn(g));
        if (open) {
          open.reason = reason;
          open.status = "open";
        } else {
          state.gaps.push({
            date, series, reason_code: "withdrawn", reason, status: "open", detected_at: at, resolved_at: null, evidence_url: null,
          });
        }
      }
      if (kind === "correction" && next != null) {
        for (const g of state.gaps) {
          if (g.date === date && g.series === series && isOpenWithdrawn(g)) {
            g.status = "resolved";
            g.resolved_at = at;
          }
        }
      }
      // The RPC marks the record dirty itself.
      state.dirtyAt = at;
      return revision;
    },
    async getGaps(date) { return state.gaps.filter((g) => g.date === date).map((g) => ({ ...g })); },
    async upsertGap(g) {
      // Like the partial unique index: only an open row is updated in place.
      const i = state.gaps.findIndex(
        (x) => x.date === g.date && x.series === g.series && x.reason_code === g.reason_code && x.resolved_at == null,
      );
      if (i >= 0 && isOpenWithdrawn(state.gaps[i])) {
        throw refused(RECORD_SQLSTATE.WITHDRAWN,
          `network_record_gaps ${g.date} ${g.series} was withdrawn; only a correction through revise_network_record() lifts it`);
      }
      const row: GapRow = {
        date: g.date, series: g.series, reason_code: g.reason_code, reason: g.reason, status: g.status,
        detected_at: i >= 0 ? state.gaps[i].detected_at : new Date().toISOString(),
        resolved_at: null, evidence_url: g.evidence_url ?? null,
      };
      if (i >= 0) state.gaps[i] = row;
      else state.gaps.push(row);
    },
    async resolveGaps(date, series, atIso, keep) {
      // One UPDATE statement: an open withdrawn gap among its rows refuses all of it.
      const hit = state.gaps.filter(
        (g) => g.date === date && g.series === series && g.resolved_at == null && g.reason_code !== keep,
      );
      if (hit.some(isOpenWithdrawn)) {
        throw refused(RECORD_SQLSTATE.WITHDRAWN,
          `network_record_gaps ${date} ${series} was withdrawn; only a correction through revise_network_record() lifts it`);
      }
      for (const g of hit) {
        g.resolved_at = atIso;
        g.status = "resolved";
      }
    },
    async getSupplyAt(instantIso) {
      const v = state.supply.get(instantIso);
      return v == null ? null : { value: v, source_host: "api.cantonnodes.com" };
    },
    async markDirty(atIso) { state.dirtyAt = atIso; },
  };
  return { store, state };
}

/** The rows publish.ts renders from, read from a memoryStore's state. */
export function memoryRecordReader(state: MemoryState): RecordReader {
  return {
    values: async () => [...state.values.values()].map((v) => ({ ...v })),
    gaps: async () => state.gaps.map((g) => ({ ...g })),
    revisions: async () => state.revisions.map((r) => ({ ...r })),
    dirtyAt: async () => state.dirtyAt,
  };
}

/** A FileCache in memory: the rendered files by path, and the manifest. */
export function memoryFileCache(): FileCache & { files: Map<string, StoredFile>; current: () => Manifest | null } {
  const files = new Map<string, StoredFile>();
  let manifest: Manifest | null = null;
  return {
    files,
    current: () => manifest,
    async manifest() {
      return manifest ? { status: "hit", value: structuredClone(manifest) } : { status: "miss" };
    },
    async putFiles(changed) {
      for (const f of changed) files.set(f.path, { ...f });
    },
    async putManifest(next) {
      manifest = structuredClone(next);
    },
  };
}
