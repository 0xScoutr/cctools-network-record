/**
 * days/{date}.json: what /network/[date] renders server-side,
 * byte for byte the file anyone can download, so the page, the download and
 * the API are the same numbers. A date inside the range with no stored row is
 * "missing" and carries the whole-day reason.
 */

import {
  ATTRIBUTION,
  LICENSE,
  LICENSE_SCOPE,
  OPEN_BASE_URL,
  RECORD_RELEASE_LABEL,
  SCHEMA_VERSION,
  SERIES_NAMES,
  SITE_RECORD_URL,
  seriesDef,
  type DayFile,
  type DayValue,
  type GapRow,
  type SeriesName,
} from "./contract";
import { dayRevision, dayStatus, isoZ, publishedProvenance, publishedValue, revisionOf, toJson, type RecordModel } from "./render";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

export function formatDayShort(date: string): string {
  const [y, m, d] = parts(date);
  return `${d} ${SHORT[m - 1]} ${y}`;
}

export function formatDayLong(date: string): string {
  const [y, m, d] = parts(date);
  return `${d} ${LONG[m - 1]} ${y}`;
}

function formatInstant(iso: string): string {
  const t = new Date(iso).toISOString();
  return `${formatDayShort(t.slice(0, 10))} ${t.slice(11, 16)}`;
}

interface DecimalParts {
  sign: -1 | 0 | 1;
  /** Integer digits without leading zeros. */
  int: string;
  /** Fraction digits without trailing zeros. */
  frac: string;
}

function decimalParts(text: string): DecimalParts {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`not a decimal: ${text}`);
  const int = m[2].replace(/^0+/, "");
  const frac = (m[3] ?? "").replace(/0+$/, "");
  return { sign: int === "" && frac === "" ? 0 : m[1] === "-" ? -1 : 1, int, frac };
}

/**
 * Exact order of two numeric(38,10) texts. Number() keeps about 16
 * significant digits and CC amounts of 1e7 to 1e8 at 10 places carry 18, so a
 * difference within about 1e-8 would land on the wrong side of a note.
 */
function compareDecimal(a: string, b: string): number {
  const x = decimalParts(a);
  const y = decimalParts(b);
  if (x.sign !== y.sign) return x.sign < y.sign ? -1 : 1;
  let magnitude = 0;
  if (x.int.length !== y.int.length) magnitude = x.int.length < y.int.length ? -1 : 1;
  else if (x.int !== y.int) magnitude = x.int < y.int ? -1 : 1;
  else {
    const len = Math.max(x.frac.length, y.frac.length);
    const fx = x.frac.padEnd(len, "0");
    const fy = y.frac.padEnd(len, "0");
    magnitude = fx === fy ? 0 : fx < fy ? -1 : 1;
  }
  return x.sign < 0 ? -magnitude : magnitude;
}

/** Warnings, never holds: published as measured, with a note. */
export function dayNotes(model: RecordModel, date: string): string[] {
  const day = model.values.get(date);
  const net = day?.get("net_supply_change_cc")?.value;
  const issuance = day?.get("issuance_cc")?.value;
  const notes: string[] = [];
  if (net != null && decimalParts(net).sign < 0) {
    notes.push("Net supply change is negative: supply fell over this day. Issuance is not minted supply (see Methodology, Known limitations). Published as measured.");
  }
  if (net != null && issuance != null && compareDecimal(net, issuance) > 0) {
    notes.push("Net supply change exceeds the day's scheduled issuance; issuance is not minted supply (see Methodology, Known limitations). Published as measured.");
  }
  return notes;
}

/** `{retrieved}` is replaced by whoever renders the citation, with their retrieval date. */
export function citationFor(date: string, revision: number, asOf: string | null): DayFile["citation"] {
  const permalink = `${SITE_RECORD_URL}/${date}`;
  const asOfText = asOf ? ` As of ${formatInstant(asOf)} UTC.` : "";
  return {
    plain: `CCTools. "Daily record, ${formatDayShort(date)}", Canton Network daily record, revision ${revision}.${asOfText} ${permalink}. Retrieved {retrieved}. CC BY 4.0.`,
    bibtex: `@misc{cctools_record_${date.replace(/-/g, "_")}, author={{CCTools}}, title={Daily record, ${formatDayLong(date)}}, year={${date.slice(0, 4)}}, howpublished={\\url{${permalink}}}, note={Revision ${revision}; schema ${SCHEMA_VERSION}; retrieved {retrieved}; CC BY 4.0}}`,
    permalink,
    dataset: `CCTools (${RECORD_RELEASE_LABEL.slice(0, 4)}). CCTools daily record of the Canton Network, schema ${SCHEMA_VERSION}, release ${RECORD_RELEASE_LABEL}.`,
  };
}

/**
 * The reason a value carries.
 *
 * A null: an open 'withdrawn' gap wins, because a withdrawal lasts until a
 * human correction and finalize leaves a withdrawn series out of its gap
 * resolution, so another open gap on it (round_missed, backfill_planned) would
 * promise a backfill that revise_network_record refuses (RN002). Then the
 * series' other open gaps, in the model's fixed order, then the open
 * whole-day gap.
 *
 * A number: only its own open gap. Finalize resolves a series' gaps when it
 * writes a number, except while it holds that number provisional
 * (day-values.ts held(): sanity_gate_failed or sources_disagree), so a held number is never
 * published as a confident one. A whole-day gap explains no
 * number.
 */
function openGap(gaps: GapRow[], series: SeriesName, isNull: boolean): GapRow | undefined {
  const open = gaps.filter((g) => g.resolved_at == null);
  if (!isNull) return open.find((g) => g.series === series);
  return (
    open.find((g) => g.series === series && g.reason_code === "withdrawn") ??
    open.find((g) => g.series === series) ??
    open.find((g) => g.series === "all")
  );
}

export function renderDayFile(model: RecordModel, date: string, generationId: string): string {
  const index = model.dates.indexOf(date);
  // Only a day inside the published range is sure of a reason for a missing
  // day, so no other day is ever published.
  if (index < 0) throw new Error(`${date} is outside the published range`);
  const day = model.values.get(date);
  const dayGaps = model.gaps.filter((g) => g.date === date);
  const values = {} as Record<SeriesName, DayValue | null>;
  let asOf: string | null = null;

  for (const s of SERIES_NAMES) {
    // No row: the value is null and its reason is in `gaps` (render.ts
    // synthesizes one when nothing stored explains it).
    const v = day?.get(s);
    if (!v) {
      values[s] = null;
      continue;
    }
    const r = revisionOf(model, date, s);
    // A null names no source, so the citation's "As of" comes from published values only.
    const { source_host, as_of } = publishedProvenance(v);
    if (as_of && (!asOf || as_of > asOf)) asOf = as_of;
    const gap = openGap(dayGaps, s, v.value == null);
    values[s] = {
      value: publishedValue(s, v.value),
      unit: seriesDef(s).unit,
      status: v.status,
      source_host,
      method: v.method,
      as_of,
      revision: r.revision,
      revised_at: r.revised_at,
      gap: gap ? { reason_code: gap.reason_code, reason: gap.reason, status: gap.status } : null,
    };
  }

  const rev = dayRevision(model, date);
  const file: DayFile = {
    schema_version: SCHEMA_VERSION,
    generation_id: generationId,
    date,
    status: dayStatus(model, date),
    revision: rev.revision,
    revised_at: rev.revised_at,
    prev: index > 0 ? model.dates[index - 1] : null,
    next: index < model.dates.length - 1 ? model.dates[index + 1] : null,
    values,
    gaps: dayGaps.map((g) => ({
      series: g.series, reason_code: g.reason_code, reason: g.reason, status: g.status,
      detected_at: isoZ(g.detected_at) ?? g.detected_at, resolved_at: isoZ(g.resolved_at), evidence_url: g.evidence_url,
    })),
    revisions: model.revisions
      .filter((r) => r.date === date)
      .map((r) => ({
        series: r.series, old_value: publishedValue(r.series, r.old_value), new_value: publishedValue(r.series, r.new_value),
        kind: r.kind, reason: r.reason, method: r.method, revised_at: isoZ(r.revised_at) ?? r.revised_at,
      })),
    notes: dayNotes(model, date),
    citation: citationFor(date, rev.revision, asOf),
    license: LICENSE,
    license_scope: LICENSE_SCOPE,
    attribution: ATTRIBUTION,
    links: {
      daily_csv: `${OPEN_BASE_URL}daily.csv`,
      daily_json: `${OPEN_BASE_URL}daily.json`,
      gaps_csv: `${OPEN_BASE_URL}gaps.csv`,
      datapackage: `${OPEN_BASE_URL}datapackage.json`,
      methodology: `${OPEN_BASE_URL}methodology.json`,
    },
  };
  return toJson(file);
}
