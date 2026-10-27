/**
 * What methodology.json and datapackage.json state as facts, apart from their
 * prose. verify renders both files again and, when the bytes differ, compares
 * these facts strictly: a difference in them is a difference in what the
 * files say about the data, and fails. A difference only in the prose is a
 * warning, since a published copy can predate a wording change of the code
 * until the next render.
 *
 *   datapackage.json  everything except its free text (every `title`,
 *                     `description`, `rights` and `trademark_notice`): the
 *                     version, the license name and path, the source hosts
 *                     (`sources[].path`), and every resource with its fields,
 *                     types, units, keys and missing values.
 *   methodology.json  its schema version and generation, the ids of its
 *                     sections, the field table's column, unit, first date
 *                     ("Since") and method versions of every series, the
 *                     reason codes of the gaps table, and the host names its
 *                     sources section names.
 */

/** The free text of datapackage.json: keys whose value is prose, wherever they sit. */
const DATAPACKAGE_PROSE = new Set(["title", "description", "rights", "trademark_notice"]);

/** A dotted host name, e.g. api.cantonnodes.com; file names of the record (.json, .csv) are not hosts. */
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
const FILE_NAME_RE = /\.(?:json|csv)$/i;

interface Section {
  id?: unknown;
  paragraphs?: unknown;
  table?: { columns?: unknown; rows?: unknown };
}

function withoutProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProse);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !DATAPACKAGE_PROSE.has(key))
        .map(([key, v]) => [key, withoutProse(v)]),
    );
  }
  return value;
}

function hostsIn(paragraphs: unknown): string[] {
  const text = Array.isArray(paragraphs) ? paragraphs.filter((p) => typeof p === "string").join("\n") : "";
  const hosts = (text.match(HOST_RE) ?? []).map((h) => h.toLowerCase()).filter((h) => !FILE_NAME_RE.test(h));
  return [...new Set(hosts)].sort();
}

function methodologyFacts(doc: { schema_version?: unknown; generation_id?: unknown; sections?: unknown }) {
  const sections = (Array.isArray(doc.sections) ? doc.sections : []) as Section[];
  const byId = new Map(sections.map((s) => [s.id, s]));
  const fieldTable = byId.get("daily-record")?.table;
  const columns = Array.isArray(fieldTable?.columns) ? (fieldTable.columns as unknown[]) : [];
  const rows = Array.isArray(fieldTable?.rows) ? (fieldTable.rows as unknown[][]) : [];
  const cell = (row: unknown[], column: string) => {
    const i = columns.indexOf(column);
    return i < 0 ? null : (row[i] ?? null);
  };
  const gapRows = byId.get("gaps")?.table?.rows;
  return {
    schema_version: doc.schema_version ?? null,
    generation_id: doc.generation_id ?? null,
    sections: sections.map((s) => s.id ?? null),
    fields: rows.map((r) => ({
      column: cell(r, "Column"),
      unit: cell(r, "Unit"),
      since: cell(r, "Since"),
      method: cell(r, "Method"),
    })),
    reason_codes: Array.isArray(gapRows) ? (gapRows as unknown[][]).map((r) => r[0] ?? null) : null,
    source_hosts: hostsIn(byId.get("sources")?.paragraphs),
  };
}

/** The facts of a documentation file (see the header); throws if the body is not JSON. */
export function documentationFacts(path: string, body: string): unknown {
  const doc = JSON.parse(body) as Record<string, unknown>;
  if (path === "datapackage.json") return withoutProse(doc);
  if (path === "methodology.json") return methodologyFacts(doc);
  throw new Error(`${path} is not a documentation file`);
}

/** The first place where two JSON values differ, as `path: published X | rendered Y`, or null when they agree. */
export function firstFactDifference(published: unknown, rendered: unknown, at = ""): string | null {
  const show = (v: unknown) => {
    const text = JSON.stringify(v) ?? "(none)";
    return text.length > 120 ? `${text.slice(0, 120)}...` : text;
  };
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(published) && Array.isArray(rendered)) {
    for (let i = 0; i < Math.max(published.length, rendered.length); i++) {
      const d = firstFactDifference(published[i], rendered[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (isObject(published) && isObject(rendered)) {
    for (const key of [...new Set([...Object.keys(published), ...Object.keys(rendered)])].sort()) {
      const d = firstFactDifference(published[key], rendered[key], at ? `${at}.${key}` : key);
      if (d) return d;
    }
    return null;
  }
  return JSON.stringify(published) === JSON.stringify(rendered)
    ? null
    : `${at || "(the file)"}: published ${show(published)} | rendered ${show(rendered)}`;
}

/** Null when the two bodies state the same facts, else where they first differ. */
export function documentationFactsDiffer(path: string, publishedBody: string, renderedBody: string): string | null {
  let published: unknown;
  try {
    published = documentationFacts(path, publishedBody);
  } catch {
    return "the published file is not JSON";
  }
  return firstFactDifference(published, documentationFacts(path, renderedBody));
}
