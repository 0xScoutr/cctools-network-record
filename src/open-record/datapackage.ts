/**
 * datapackage.json: Frictionless Data Package v2
 * (https://datapackage.org/standard/data-package/). Resources, per-field type,
 * unit and description, license, sources, version = schema version. No
 * timestamp of its own, so it changes only with the schema or the sources.
 */

import { LICENSE, SCHEMA_VERSION, SERIES, SITE_RECORD_URL, TRADEMARK_NOTICE, licenseScopeFor, namesOnlyMirror } from "./contract";
import { hostSourceTitle } from "./methodology";
import { toJson } from "./render";

type Field = { name: string; type: string; description: string; [key: string]: unknown };

const f = (name: string, type: string, description: string, extra: Record<string, unknown> = {}): Field => ({
  name, type, description, ...extra,
});

const seriesFields = (): Field[] =>
  SERIES.map((s) => f(s.name, s.kind === "count" ? "integer" : "number", s.description, { title: s.title, unit: s.unit }));

export function renderDatapackage(sourceHosts: string[], generationId: string): string {
  const csv = { format: "csv", mediatype: "text/csv", encoding: "utf-8" };
  // While it names only api.cantonnodes.com, this file stays byte for byte as published (contract.ts LICENSE_SCOPE).
  const mirror = namesOnlyMirror(sourceHosts);
  return toJson({
    $schema: "https://datapackage.org/profiles/2.0/datapackage.json",
    name: "cctools-canton-network-daily-record",
    title: "CCTools daily record of the Canton Network",
    description:
      `One row per UTC day of Canton Network state, derived from ${mirror ? "Scan data served publicly by a Super Validator" : "Canton Scan data"}: rounds, issuance by category, supply, the SV reference price, Super Validators, featured apps and validator licenses. Every missing value has a reason in gaps.csv and every change after a value became final is in revisions.csv. ${licenseScopeFor(sourceHosts)}`,
    version: SCHEMA_VERSION,
    generation_id: generationId,
    homepage: SITE_RECORD_URL,
    licenses: [LICENSE],
    // Custom properties (allowed by the standard): what the license covers, and the trademark notice.
    rights: licenseScopeFor(sourceHosts),
    trademark_notice: TRADEMARK_NOTICE,
    sources: sourceHosts.map((h) => ({ title: hostSourceTitle(h), path: `https://${h}` })),
    resources: [
      {
        name: "daily", path: "daily.csv", ...csv,
        schema: {
          fields: [
            f("date", "date", "UTC day D: the interval [D 00:00:00Z, D+1 00:00:00Z)."),
            f("status", "string", "final, or provisional until the day settles.", { constraints: { enum: ["final", "provisional"] } }),
            ...seriesFields(),
            f("method", "string", "Method versions of the row's values, joined by +."),
            f("revision", "integer", "Published revisions of the row's values since release."),
            f("revised_at", "datetime", "Time of the row's latest published revision."),
          ],
          primaryKey: ["date"],
          missingValues: [""],
        },
      },
      {
        name: "values", path: "values.csv", ...csv,
        schema: {
          fields: [
            f("date", "date", "UTC day."),
            f("series", "string", "Column name in daily.csv."),
            f("value", "number", "The value; empty when not recorded (reason in gaps.csv)."),
            f("status", "string", "final or provisional."),
            f("source_host", "string", mirror ? "Scan host the value was read from." : "Scan host the value was read from; two or more, comma separated, when the rounds of a day came from different hosts."),
            f("method", "string", "Method version (scan-1, scan-rt-1)."),
            f("as_of", "datetime", "Time the value describes."),
            f("revision", "integer", "Published revisions of this value since release."),
            f("revised_at", "datetime", "Time of its latest published revision."),
          ],
          primaryKey: ["date", "series"],
          missingValues: [""],
        },
      },
      {
        name: "gaps", path: "gaps.csv", ...csv,
        schema: {
          fields: [
            f("date", "date", "UTC day."),
            f("series", "string", "Column name, or all for a missing day."),
            f("reason_code", "string", "Why the value is missing."),
            f("reason", "string", "The reason in words."),
            f("status", "string", "open, backfill_planned, permanent or resolved."),
            f("detected_at", "datetime", "When the gap was recorded."),
            f("resolved_at", "datetime", "When it was resolved; empty while open."),
            f("evidence_url", "string", "Link to supporting evidence, when there is one."),
          ],
          missingValues: [""],
        },
      },
      {
        name: "revisions", path: "revisions.csv", ...csv,
        schema: {
          fields: [
            f("date", "date", "UTC day."),
            f("series", "string", "Column name."),
            f("old_value", "number", "Value before the change; empty for a backfill."),
            f("new_value", "number", "Value after the change; empty for a withdrawal."),
            f("kind", "string", "backfill, correction, withdrawal or method."),
            f("reason", "string", "Why it changed."),
            f("method", "string", "Method version of the new value."),
            f("revised_at", "datetime", "When it changed."),
          ],
          missingValues: [""],
        },
      },
    ],
  });
}
