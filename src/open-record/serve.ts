/**
 * Serving rules for the keyless files.
 *
 * Data files: public, 5 minutes in browsers, an hour at the edge, served stale
 * for a day if the origin fails, with an ETag (their sha256) for 304s.
 * status.json and health: never cached anywhere, so an origin outage shows as
 * "Lagging" or a failed health check instead of an old 200.
 */

import {
  DAY_FILE_RE,
  EDGE_TTL_SECONDS,
  FRESHNESS,
  FRESHNESS_COMMITTED,
  LICENSE,
  OPEN_BASE_URL,
  STATIC_FILES,
  addDays,
  expectedFinalDate,
  finalByMs,
  isValidDate,
  type Manifest,
  type StoredFile,
} from "./contract";

export const DATA_CACHE_CONTROL =
  `public, max-age=300, s-maxage=${EDGE_TTL_SECONDS}, stale-while-revalidate=3600, stale-if-error=86400`;
export const NOT_FOUND_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
export const NO_STORE = "no-store";

export function isPublishedPath(path: string): boolean {
  if ((STATIC_FILES as readonly string[]).includes(path)) return true;
  const day = DAY_FILE_RE.exec(path);
  return day !== null && isValidDate(day[1]);
}

export function linkHeader(): string {
  return `<${LICENSE.path}>; rel="license", <${OPEN_BASE_URL}datapackage.json>; rel="describedby"`;
}

export function dataHeaders(file: StoredFile): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": file.content_type,
    "Cache-Control": DATA_CACHE_CONTROL,
    ETag: `"${file.sha256}"`,
    Link: linkHeader(),
    "X-Record-Generation": file.generation_id,
  };
  if (file.path.endsWith(".csv")) headers["Content-Disposition"] = `attachment; filename="${file.path}"`;
  return headers;
}

/** Weak comparison (RFC 9110 13.1.2): the edge may turn a strong ETag weak when it compresses. */
export function etagMatches(ifNoneMatch: string | null, sha256: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === `"${sha256}"`);
}

/**
 * expected_final_date: the newest day the stated final_by says is final by now.
 * lag_hours: hours past the final_by (D+1 03:00 UTC) of the first day that is
 * not final yet, 0 when none is due.
 * stale ("Lagging", health 503): no day is final yet, or the due day is not
 *. No grace on top: the
 * promise already holds the publish cycle after the 02:00 settle deadline.
 */
export function statusDocument(m: Manifest, nowMs: number) {
  const expected = expectedFinalDate(nowMs);
  const lagMs = m.latest_final_date == null ? null : nowMs - finalByMs(addDays(m.latest_final_date, 1));
  const stale = m.latest_final_date == null || m.latest_final_date < expected;
  return {
    schema_version: m.schema_version,
    generation_id: m.generation_id,
    generated_at: m.generated_at,
    latest_final_date: m.latest_final_date,
    latest_provisional_date: m.latest_provisional_date,
    expected_final_date: expected,
    stale,
    lag_hours: lagMs == null ? null : Math.max(0, Math.round(lagMs / 360_000) / 10),
    freshness: { kind: FRESHNESS_COMMITTED ? "commitment" : "target", ...FRESHNESS },
    files: Object.fromEntries(
      STATIC_FILES.filter((p) => m.files[p]).map((p) => [p, { rows: m.files[p].rows, bytes: m.files[p].bytes, sha256: m.files[p].sha256 }]),
    ),
    day_files: {
      count: Object.keys(m.files).filter((p) => DAY_FILE_RE.test(p)).length,
      first: m.first_date,
      last: m.last_date,
    },
    generations: m.generations,
    license: LICENSE,
    source_hosts: m.source_hosts,
    warnings: m.warnings,
  };
}

export function healthDocument(m: Manifest | null, nowMs: number): { status: 200 | 503; body: Record<string, unknown> } {
  if (!m) return { status: 503, body: { status: "warming_up" } };
  const s = statusDocument(m, nowMs);
  return {
    status: s.stale ? 503 : 200,
    body: {
      status: s.stale ? "lagging" : "ok",
      latest_final_date: s.latest_final_date,
      expected_final_date: s.expected_final_date,
      lag_hours: s.lag_hours,
      generation_id: s.generation_id,
    },
  };
}
