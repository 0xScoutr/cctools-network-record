/**
 * The open record's tables: daily.csv, daily.json, values.csv,
 * gaps.csv and revisions.csv, rendered from the database rows.
 *
 * RFC 4180, UTF-8, a header row, CRLF, "." decimals, no thousands separators,
 * no exponent, an empty cell for "not recorded" (never 0, never "N/A"), no
 * comment lines, timestamps YYYY-MM-DDTHH:MM:SSZ. In JSON, CC amounts and
 * prices are decimal strings (supply needs about 21 significant digits) and
 * counts are numbers. Revisions before RECORD_RELEASE_AT are release 0 and
 * never published.
 */

import { createHash } from "node:crypto";
import {
  ATTRIBUTION,
  DAILY_COLUMNS,
  GAPS_COLUMNS,
  LICENSE,
  licenseScopeFor,
  RECORD_FIRST_DATE,
  RECORD_RELEASE_AT,
  REVISIONS_COLUMNS,
  SCHEMA_VERSION,
  SOURCE_HOST_SEPARATOR,
  SERIES_NAMES,
  VALUES_COLUMNS,
  addDays,
  seriesDef,
  type GapRow,
  type RevisionRow,
  type SeriesName,
  type ValueRow,
} from "./contract";

export type Cell = string | number | null;

export interface Rendered {
  body: string;
  rows: number | null;
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function csvCell(value: Cell | undefined): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, Cell>>): string {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isoZ(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** numeric(38,10) text to its published form: counts as integers, amounts as 10-place decimals. */
export function publishedValue(series: SeriesName, text: string | null): Cell {
  if (text == null) return null;
  if (seriesDef(series).kind === "count") return Math.round(Number(text));
  return text.includes(".") ? text : `${text}.0000000000`;
}

export interface RecordModel {
  /**
   * Every date from RECORD_FIRST_DATE to the last stored day, contiguous;
   * empty until a day is stored. A day the backfill has not reached, or gave
   * up on, stays in the range with a whole-day reason.
   */
  dates: string[];
  values: Map<string, Map<SeriesName, ValueRow>>;
  gaps: GapRow[];
  /** Published revisions only (after RECORD_RELEASE_AT), oldest first. */
  revisions: RevisionRow[];
  revisionsByKey: Map<string, RevisionRow[]>;
}

/**
 * The reason of a synthesized gap. It claims no plan: a whole day may wait
 * for the backfill, have been given up on by it, or lie past finalize's 7-day
 * window with its snapshot on hand, which the backfill does not repair; a
 * single series with no row on a stored day is a state finalize alarms on
 * ('unexplained') and writes no row for.
 */
export const MISSING_DAY_REASON = "Not processed yet";

/** Code point order, a null last: the same on every machine, unlike localeCompare. */
function compareText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

/** Timestamps as instants (so +00:00 and Z agree), a null last. */
function compareTime(a: string | null, b: string | null): number {
  const x = a == null ? Infinity : Date.parse(a);
  const y = b == null ? Infinity : Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return compareText(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A resolved gap and its recurrence can share (date, series, reason_code),
 * and the database breaks no ties between reads, so
 * every rendered field is a sort key: the same rows always render the same
 * bytes, and change detection sees no change that is not in the data.
 */
function compareGaps(a: GapRow, b: GapRow): number {
  return (
    a.date.localeCompare(b.date) ||
    a.series.localeCompare(b.series) ||
    a.reason_code.localeCompare(b.reason_code) ||
    compareTime(a.detected_at, b.detected_at) ||
    compareTime(a.resolved_at, b.resolved_at) ||
    compareText(a.status, b.status) ||
    compareText(a.reason, b.reason) ||
    compareText(a.evidence_url, b.evidence_url)
  );
}

/**
 * Oldest first. Two revisions can share revised_at (one transaction, or the
 * same millisecond), so ties are broken on every rendered field, as in
 * compareGaps: a read order change must not change the bytes.
 */
function compareRevisions(a: RevisionRow, b: RevisionRow): number {
  return (
    compareTime(a.revised_at, b.revised_at) ||
    compareText(a.date, b.date) ||
    compareText(a.series, b.series) ||
    compareText(a.kind, b.kind) ||
    compareText(a.old_value, b.old_value) ||
    compareText(a.new_value, b.new_value) ||
    compareText(a.reason, b.reason) ||
    compareText(a.method, b.method)
  );
}

export function buildModel(values: ValueRow[], gaps: GapRow[], revisions: RevisionRow[]): RecordModel {
  const byDate = new Map<string, Map<SeriesName, ValueRow>>();
  for (const v of values) {
    if (v.date < RECORD_FIRST_DATE) continue;
    let day = byDate.get(v.date);
    if (!day) {
      day = new Map();
      byDate.set(v.date, day);
    }
    day.set(v.series, v);
  }
  // Gaps and revisions of days before the published range stay out too, so
  // moving RECORD_FIRST_DATE later takes those days out of every file.
  const inRange = gaps.filter((g) => g.date >= RECORD_FIRST_DATE);
  // The range starts at RECORD_FIRST_DATE, not at the first stored day, and
  // ends at the last day with a stored value or gap, so daily.csv lists every
  // day that gaps.csv describes.
  const stored = [...byDate.keys(), ...inRange.map((g) => g.date)].sort();
  const dates: string[] = [];
  if (stored.length > 0) {
    for (let d = RECORD_FIRST_DATE; d <= stored[stored.length - 1]; d = addDays(d, 1)) dates.push(d);
  }
  const release = Date.parse(RECORD_RELEASE_AT);
  const published = revisions
    .filter((r) => r.date >= RECORD_FIRST_DATE && Date.parse(r.revised_at) >= release)
    .sort(compareRevisions);
  const revisionsByKey = new Map<string, RevisionRow[]>();
  for (const r of published) {
    const key = `${r.date}|${r.series}`;
    revisionsByKey.set(key, [...(revisionsByKey.get(key) ?? []), r]);
  }
  // A day inside the range with no rows at all (not reached
  // or given up on by the backfill, or a finalize outage longer than its
  // window) still gets a reason, open because no plan is promised for it.
  // So does a series with no row on a stored day: finalize stores a row for
  // every series it can explain and alarms on the rest, so nothing else would
  // say why that cell is empty. Synthesized here, never stored;
  // an open stored gap for the series, or for the whole day, wins.
  const withReasons = [...inRange];
  const hasOpen = (d: string, series: GapRow["series"]) =>
    inRange.some((g) => g.date === d && g.series === series && g.resolved_at == null);
  const synthesized = (d: string, series: GapRow["series"]): GapRow => ({
    date: d, series, reason_code: "not_collected", reason: MISSING_DAY_REASON, status: "open",
    detected_at: `${addDays(d, 1)}T00:00:00Z`, resolved_at: null, evidence_url: null,
  });
  for (const d of dates) {
    if (hasOpen(d, "all")) continue;
    const day = byDate.get(d);
    if (!day) {
      withReasons.push(synthesized(d, "all"));
      continue;
    }
    for (const s of SERIES_NAMES) {
      if (!day.has(s) && !hasOpen(d, s)) withReasons.push(synthesized(d, s));
    }
  }
  const sortedGaps = withReasons.sort(compareGaps);
  return { dates, values: byDate, gaps: sortedGaps, revisions: published, revisionsByKey };
}

/**
 * Distinct hosts that served a published value, sorted: the files name the
 * host of what CCTools derives from (LICENSE_SCOPE).
 */
export function recordSourceHosts(model: RecordModel): string[] {
  const hosts = new Set<string>();
  for (const day of model.values.values()) for (const host of valueHosts(day.values())) hosts.add(host);
  return [...hosts].sort();
}

/** The hosts these values name: only of published values, and each host of a value that names two. */
export function valueHosts(values: Iterable<ValueRow>): string[] {
  const hosts = new Set<string>();
  for (const v of values) {
    if (v.value == null || !v.source_host) continue;
    for (const host of v.source_host.split(SOURCE_HOST_SEPARATOR)) hosts.add(host);
  }
  return [...hosts];
}

/**
 * Where a published value came from. A null names no source. The schema
 * already clears source_host and as_of on a withdrawal
 * (revise_network_record), and its provenance CHECK lets any null row name
 * neither; this rule is a second guard, so no null row, withdrawn or not, can
 * credit a host with a figure CCTools does not publish.
 */
export function publishedProvenance(v: ValueRow): { source_host: string | null; as_of: string | null } {
  return v.value == null ? { source_host: null, as_of: null } : { source_host: v.source_host, as_of: isoZ(v.as_of) };
}

export function dayStatus(model: RecordModel, date: string): "final" | "provisional" | "missing" {
  const row = model.values.get(date);
  if (!row || row.size === 0) return "missing";
  return SERIES_NAMES.every((s) => row.get(s)?.status === "final") ? "final" : "provisional";
}

export function revisionOf(model: RecordModel, date: string, series: SeriesName): { revision: number; revised_at: string | null } {
  const list = model.revisionsByKey.get(`${date}|${series}`) ?? [];
  return { revision: list.length, revised_at: isoZ(list[list.length - 1]?.revised_at) };
}

export function dayRevision(model: RecordModel, date: string): { revision: number; revised_at: string | null } {
  let revision = 0;
  let revisedAt: string | null = null;
  for (const s of SERIES_NAMES) {
    const r = revisionOf(model, date, s);
    revision += r.revision;
    if (r.revised_at && (!revisedAt || r.revised_at > revisedAt)) revisedAt = r.revised_at;
  }
  return { revision, revised_at: revisedAt };
}

export function dailyRow(model: RecordModel, date: string): Record<string, Cell> {
  const day = model.values.get(date) ?? new Map<SeriesName, ValueRow>();
  const out: Record<string, Cell> = { date, status: dayStatus(model, date) === "final" ? "final" : "provisional" };
  const methods = new Set<string>();
  for (const s of SERIES_NAMES) {
    const v = day.get(s);
    out[s] = publishedValue(s, v?.value ?? null);
    if (v?.value != null) methods.add(v.method);
  }
  const rev = dayRevision(model, date);
  out.method = methods.size > 0 ? [...methods].sort().join("+") : null;
  out.revision = rev.revision;
  out.revised_at = rev.revised_at;
  return out;
}

export function renderDailyCsv(model: RecordModel): Rendered {
  const rows = model.dates.map((d) => dailyRow(model, d));
  return { body: toCsv(DAILY_COLUMNS, rows), rows: rows.length };
}

export function renderDailyJson(model: RecordModel, generationId: string): Rendered {
  const rows = model.dates.map((d) => dailyRow(model, d));
  return {
    body: toJson({
      schema_version: SCHEMA_VERSION,
      generation_id: generationId,
      license: LICENSE,
      license_scope: licenseScopeFor(recordSourceHosts(model)),
      attribution: ATTRIBUTION,
      source_hosts: recordSourceHosts(model),
      columns: DAILY_COLUMNS,
      rows,
    }),
    rows: rows.length,
  };
}

export function renderValuesCsv(model: RecordModel): Rendered {
  const rows: Array<Record<string, Cell>> = [];
  for (const date of model.dates) {
    const day = model.values.get(date);
    if (!day) continue;
    for (const s of SERIES_NAMES) {
      const v = day.get(s);
      if (!v) continue;
      const r = revisionOf(model, date, s);
      rows.push({
        date, series: s, value: publishedValue(s, v.value), status: v.status, ...publishedProvenance(v),
        method: v.method, revision: r.revision, revised_at: r.revised_at,
      });
    }
  }
  return { body: toCsv(VALUES_COLUMNS, rows), rows: rows.length };
}

export function renderGapsCsv(model: RecordModel): Rendered {
  const rows = model.gaps.map((g) => ({
    date: g.date, series: g.series, reason_code: g.reason_code, reason: g.reason, status: g.status,
    detected_at: isoZ(g.detected_at), resolved_at: isoZ(g.resolved_at), evidence_url: g.evidence_url,
  }));
  return { body: toCsv(GAPS_COLUMNS, rows), rows: rows.length };
}

export function renderRevisionsCsv(model: RecordModel): Rendered {
  const rows = model.revisions.map((r) => ({
    date: r.date, series: r.series, old_value: publishedValue(r.series, r.old_value),
    new_value: publishedValue(r.series, r.new_value), kind: r.kind, reason: r.reason, method: r.method,
    revised_at: isoZ(r.revised_at),
  }));
  return { body: toCsv(REVISIONS_COLUMNS, rows), rows: rows.length };
}
