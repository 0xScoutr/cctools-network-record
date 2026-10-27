import { describe, expect, it } from "vitest";
import { finalByMs, settleDeadlineMs, type Manifest, type StoredFile } from "../contract";
import { dataHeaders, etagMatches, healthDocument, isPublishedPath, statusDocument } from "../serve";

const manifest = (latestFinal: string | null): Manifest => ({
  schema_version: "1.0.0", generation_id: "g2", generated_at: "2026-10-06T02:40:00Z", rendered_at: "2026-10-06T02:40:00Z",
  dirty_at_rendered: "x", first_date: "2026-03-26", last_date: "2026-10-05", latest_final_date: latestFinal,
  latest_provisional_date: null, source_hosts: ["api.cantonnodes.com"],
  files: {
    "daily.csv": { sha256: "aa", content_sha256: "a", bytes: 10, rows: 194, generation_id: "g2" },
    "days/2026-10-05.json": { sha256: "bb", content_sha256: "b", bytes: 5, rows: null, generation_id: "g2" },
  },
  generations: [{ generation_id: "g2", generated_at: "2026-10-06T02:40:00Z", files: { "daily.csv": "aa" } }],
  warnings: [],
});

describe("paths", () => {
  it("serves the listed files and well-formed day files only", () => {
    expect(isPublishedPath("daily.csv")).toBe(true);
    expect(isPublishedPath("days/2026-10-05.json")).toBe(true);
    expect(isPublishedPath("days/2026-10-5.json")).toBe(false);
    expect(isPublishedPath("days/2026-02-30.json")).toBe(false);
    expect(isPublishedPath("../api_cache")).toBe(false);
    expect(isPublishedPath("status.json")).toBe(false);
  });
});

describe("dataHeaders", () => {
  const csv: StoredFile = { path: "daily.csv", body: "x", content_type: "text/csv; charset=utf-8; header=present", sha256: "aa", content_sha256: "a", generation_id: "g2", rows: 1 };

  it("sets the data cache policy, the ETag, the license link and the generation", () => {
    expect(dataHeaders(csv)).toEqual({
      "Content-Type": "text/csv; charset=utf-8; header=present",
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600, stale-if-error=86400",
      ETag: '"aa"',
      Link: '<https://creativecommons.org/licenses/by/4.0/>; rel="license", <https://api.cctools.network/api/open/network-record/v1/datapackage.json>; rel="describedby"',
      "X-Record-Generation": "g2",
      "Content-Disposition": 'attachment; filename="daily.csv"',
    });
    expect(dataHeaders({ ...csv, path: "days/2026-10-05.json", content_type: "application/json; charset=utf-8" })).not.toHaveProperty("Content-Disposition");
  });

  it("matches If-None-Match in its strong, weak, listed and wildcard forms", () => {
    expect(etagMatches('"aa"', "aa")).toBe(true);
    expect(etagMatches('W/"aa"', "aa")).toBe(true);
    expect(etagMatches('"zz", "aa"', "aa")).toBe(true);
    expect(etagMatches("*", "aa")).toBe(true);
    expect(etagMatches('"zz"', "aa")).toBe(false);
    expect(etagMatches(null, "aa")).toBe(false);
  });
});

describe("status.json and health", () => {
  const now = Date.parse("2026-10-06T03:00:00Z");

  it("is fresh when yesterday is final by 03:00, and lists the main files only", () => {
    const s = statusDocument(manifest("2026-10-05"), now);
    expect(s).toMatchObject({ stale: false, expected_final_date: "2026-10-05", lag_hours: 0, day_files: { count: 1, first: "2026-03-26", last: "2026-10-05" } });
    expect(Object.keys(s.files)).toEqual(["daily.csv"]);
    expect(s.freshness.kind).toBe("target");
    expect(healthDocument(manifest("2026-10-05"), now).status).toBe(200);
  });

  it("says Lagging, with the lag, when the due day is not final", () => {
    const later = Date.parse("2026-10-06T04:00:00Z");
    const s = statusDocument(manifest("2026-10-04"), later);
    expect(s).toMatchObject({ stale: true, lag_hours: 1 });
    expect(healthDocument(manifest("2026-10-04"), later)).toMatchObject({ status: 503, body: { status: "lagging" } });
  });

  it("is 503 warming_up before the first render", () => {
    expect(healthDocument(null, now)).toEqual({ status: 503, body: { status: "warming_up" } });
  });

  it("says Lagging, with no lag figure, when no day is final yet", () => {
    expect(statusDocument(manifest(null), now)).toMatchObject({ stale: true, lag_hours: null, latest_final_date: null });
    expect(healthDocument(manifest(null), now)).toMatchObject({ status: 503, body: { status: "lagging", lag_hours: null } });
  });

  // Finalize may mark D final from D+1 02:00 (its settle deadline) and runs at
  // :35, render runs at :40: the files show D final at about 02:40, inside the
  // promise of D+1 03:00 UTC. Nothing reads as late before 03:00, and from
  // 03:00 a day that is not final is Lagging, with the lag counted from 03:00.
  it("counts the lag from the 03:00 promise and says Lagging from it, never before", () => {
    for (const at of ["2026-10-06T01:59:59.999Z", "2026-10-06T02:00:00Z", "2026-10-06T02:40:00Z", "2026-10-06T02:59:59.999Z"]) {
      const t = Date.parse(at);
      expect(statusDocument(manifest("2026-10-04"), t), at).toMatchObject({ stale: false, expected_final_date: "2026-10-04", lag_hours: 0 });
      expect(healthDocument(manifest("2026-10-04"), t), at).toMatchObject({ status: 200, body: { status: "ok", lag_hours: 0 } });
    }

    for (const [at, lag] of [["2026-10-06T03:00:00Z", 0], ["2026-10-06T03:40:00Z", 0.7], ["2026-10-06T05:00:00Z", 2]] as const) {
      const t = Date.parse(at);
      expect(statusDocument(manifest("2026-10-04"), t), at).toMatchObject({ stale: true, expected_final_date: "2026-10-05", lag_hours: lag });
      expect(healthDocument(manifest("2026-10-04"), t), at).toMatchObject({ status: 503, body: { status: "lagging", lag_hours: lag } });
    }
  });

  it("states the freshness targets: final_by is the 03:00 promise the lag counts from, an hour after the settle deadline", () => {
    expect(statusDocument(manifest("2026-10-05"), now).freshness).toEqual({
      kind: "target",
      provisional_by: "D+1 01:00 UTC",
      final_by: "D+1 03:00 UTC",
      files_within: "1 hour",
    });
    expect(new Date(finalByMs("2026-10-05")).toISOString()).toBe("2026-10-06T03:00:00.000Z");
    expect(new Date(settleDeadlineMs("2026-10-05")).toISOString()).toBe("2026-10-06T02:00:00.000Z");
  });
});
