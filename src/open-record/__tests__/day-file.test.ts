import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTRIBUTION, LICENSE_SCOPE, LICENSE_SCOPE_ANY_HOST, RECORD_FIRST_DATE, addDays, type DayFile, type SeriesName, type ValueRow } from "../contract";
import { citationFor, dayNotes, formatDayLong, formatDayShort, renderDayFile } from "../day-file";
import { MISSING_DAY_REASON, buildModel, type RecordModel } from "../render";
import { fullDay, gapRow, revisionRow } from "./helpers/rows";

// The published range starts at RECORD_FIRST_DATE: D0 is its first day.
const D0 = RECORD_FIRST_DATE;
const D1 = addDays(D0, 1);
const D2 = addDays(D0, 2);

const model = buildModel(
  [...fullDay(D0), ...fullDay(D2, "provisional", { app_rewards_cc: null, net_supply_change_cc: "-120.5000000000" })],
  [gapRow(D2, "app_rewards_cc", { status: "open" }), gapRow(D1, "all", { reason_code: "source_unavailable", reason: "Scan unreachable all day" })],
  [],
);
const day = (d: string, m: RecordModel = model) => JSON.parse(renderDayFile(m, d, "g1")) as DayFile;

describe("days/{date}.json", () => {
  it("carries each value with its unit, status, provenance and revision", () => {
    const f = day(D0);
    expect(f).toMatchObject({ schema_version: "1.0.0", generation_id: "g1", date: D0, status: "final", prev: null, next: D1, revision: 0 });
    expect(f.values.app_rewards_cc).toMatchObject({ value: "15688736.6808733274", unit: "CC", status: "final", method: "scan-1", source_host: "api.cantonnodes.com", as_of: `${D1}T00:00:00Z`, gap: null });
    expect(f.values.featured_apps?.value).toBe(127);
  });

  it("joins a null to its gap reason", () => {
    const f = day(D2);
    expect(f.status).toBe("provisional");
    expect(f.next).toBeNull();
    expect(f.values.app_rewards_cc).toMatchObject({ value: null, gap: { reason_code: "round_missed", status: "open" } });
    expect(f.notes.join(" ")).toContain("negative");
  });

  it("renders a day with no row as missing, with the whole-day reason", () => {
    const f = day(D1);
    expect(f.status).toBe("missing");
    expect(f.values.rounds).toBeNull();
    expect(f.gaps[0]).toMatchObject({ series: "all", reason_code: "source_unavailable" });
    expect(f.prev).toBe(D0);
  });

  it("cites the day in its published form, leaving {retrieved} to the reader", () => {
    const c = citationFor("2026-09-24", 0, "2026-09-25T01:00:00Z");
    expect(c.plain).toBe(
      'CCTools. "Daily record, 24 Sep 2026", Canton Network daily record, revision 0. As of 25 Sep 2026 01:00 UTC. https://cctools.network/network/2026-09-24. Retrieved {retrieved}. CC BY 4.0.',
    );
    expect(c.bibtex).toBe(
      "@misc{cctools_record_2026_09_24, author={{CCTools}}, title={Daily record, 24 September 2026}, year={2026}, howpublished={\\url{https://cctools.network/network/2026-09-24}}, note={Revision 0; schema 1.0.0; retrieved {retrieved}; CC BY 4.0}}",
    );
    expect(c.dataset).toBe("CCTools (2026). CCTools daily record of the Canton Network, schema 1.0.0, release 2026-10.");
    expect(formatDayShort("2026-10-04")).toBe("4 Oct 2026");
    expect(formatDayLong("2026-10-04")).toBe("4 October 2026");
  });

  it("warns without holding when net supply beats scheduled issuance", () => {
    const m = buildModel(fullDay("2026-10-06", "final", { net_supply_change_cc: "32924021.0000000000" }), [], []);
    expect(dayNotes(m, "2026-10-06").join(" ")).toContain("exceeds the day's scheduled issuance");
  });

  it("compares net supply change with issuance exactly, past double precision", () => {
    const issuance = "26636225.2699264274";
    const notes = (net: string) => dayNotes(buildModel(fullDay(D0, "final", { net_supply_change_cc: net, issuance_cc: issuance }), [], []), D0);
    // 18 significant digits: a double cannot tell these two apart.
    expect(Number("26636225.2699264275")).toBe(Number(issuance));
    expect(notes("26636225.2699264275").join(" ")).toContain("exceeds the day's scheduled issuance");
    expect(notes(issuance)).toEqual([]);
    expect(notes("26636225.2699264273")).toEqual([]);
    expect(notes("-0.0000000001").join(" ")).toContain("negative");
    expect(notes("0.0000000000")).toEqual([]);
  });

  it("gives an ordinary day no notes", () => {
    expect(day(D0).notes).toEqual([]);
  });

  it("scopes the license to the derived aggregates, as daily.json does", () => {
    const f = day(D0);
    expect(f.license.name).toBe("CC-BY-4.0");
    expect(f.license_scope).toBe(LICENSE_SCOPE);
    expect(f.attribution).toBe(ATTRIBUTION);
  });

  it("lets an open withdrawal explain a null ahead of every other open gap", () => {
    // revise_network_record can withdraw a value that is already null
    // (sql/schema.sql, v_unchanged), and finalize leaves a withdrawn series out of its gap
    // resolution, so the round_missed gap stays open beside the withdrawal.
    const gaps = [
      gapRow(D0, "all", { reason_code: "source_unavailable", reason: "Scan unreachable for 3 hours", status: "open" }),
      gapRow(D0, "app_rewards_cc"),
    ];
    const rows = fullDay(D0, "provisional", { app_rewards_cc: null });
    expect(day(D0, buildModel(rows, gaps, [])).values.app_rewards_cc?.gap).toMatchObject({ reason_code: "round_missed", status: "backfill_planned" });

    const withdrawn = gapRow(D0, "app_rewards_cc", { reason_code: "withdrawn", reason: "Wrong coupon category", status: "open" });
    expect(day(D0, buildModel(rows, [...gaps, withdrawn], [])).values.app_rewards_cc?.gap).toEqual({
      reason_code: "withdrawn", reason: "Wrong coupon category", status: "open",
    });
  });

  it("falls back to the open whole-day gap when the series has no open gap", () => {
    const m = buildModel(
      fullDay(D0, "provisional", { featured_apps: null }),
      [
        gapRow(D0, "all", { reason_code: "source_unavailable", reason: "Scan unreachable at 00:00Z", status: "open" }),
        gapRow(D0, "featured_apps", { status: "resolved", resolved_at: "2026-10-06T01:35:00+00:00" }),
      ],
      [],
    );
    expect(day(D0, m).values.featured_apps).toMatchObject({
      value: null, unit: "contracts", gap: { reason_code: "source_unavailable", reason: "Scan unreachable at 00:00Z", status: "open" },
    });
  });

  it("gives a day with no rows and no stored gap the synthesized reason", () => {
    const f = day(D1, buildModel([...fullDay(D0), ...fullDay(D2)], [], []));
    expect(f).toMatchObject({ status: "missing", prev: D0, next: D2, revision: 0 });
    expect(Object.values(f.values).every((v) => v === null)).toBe(true);
    expect(f.gaps).toEqual([
      { series: "all", reason_code: "not_collected", reason: MISSING_DAY_REASON, status: "open", detected_at: `${D2}T00:00:00Z`, resolved_at: null, evidence_url: null },
    ]);
  });

  it("gives a series with no row on a stored day the synthesized reason, and keeps the day provisional", () => {
    // Finalize writes no row for a series it cannot explain ('unexplained')
    // and alarms on it; the published null still carries a reason.
    const rows = fullDay(D0).filter((v) => v.series !== "validator_licenses");
    const f = day(D0, buildModel(rows, [], []));
    expect(f.values.validator_licenses).toBeNull();
    expect(f.values.rounds?.value).toBe(140);
    expect(f.status).toBe("provisional");
    expect(f.gaps).toEqual([
      { series: "validator_licenses", reason_code: "not_collected", reason: MISSING_DAY_REASON, status: "open", detected_at: `${D1}T00:00:00Z`, resolved_at: null, evidence_url: null },
    ]);

    // An open stored gap for the series, or for the whole day, wins; a resolved one does not.
    const own = gapRow(D0, "validator_licenses", { reason_code: "source_unavailable", reason: "ACS snapshot unreachable", status: "open" });
    expect(day(D0, buildModel(rows, [own], [])).gaps).toMatchObject([{ series: "validator_licenses", reason_code: "source_unavailable" }]);
    const whole = gapRow(D0, "all", { reason_code: "source_unavailable", reason: "Scan unreachable at 00:00Z", status: "open" });
    expect(day(D0, buildModel(rows, [whole], [])).gaps).toMatchObject([{ series: "all", reason_code: "source_unavailable" }]);
    const resolved = gapRow(D0, "validator_licenses", { status: "resolved", resolved_at: "2026-10-06T01:35:00+00:00" });
    expect(day(D0, buildModel(rows, [resolved], [])).gaps.map((g) => `${g.reason_code} ${g.status}`)).toEqual([
      "not_collected open",
      "round_missed resolved",
    ]);
  });

  it("joins a held number to the gap finalize holds it under", () => {
    // Finalize writes a held series (day-values.ts held()) as a provisional number with
    // its own open gap: the reason travels with the number, so it never reads
    // as a value still inside its settle window.
    const m = buildModel(
      fullDay(D0, "provisional"),
      [
        gapRow(D0, "featured_apps", { reason_code: "sanity_gate_failed", reason: "Featured apps moved 25% in a day", status: "open" }),
        gapRow(D0, "supply_cc", { reason_code: "sources_disagree", reason: "Registry and snapshot disagree", status: "open" }),
        gapRow(D0, "rounds", { status: "resolved", resolved_at: "2026-10-06T01:35:00+00:00" }),
        gapRow(D0, "all", { reason_code: "source_unavailable", reason: "Scan unreachable for 3 hours", status: "open" }),
      ],
      [],
    );
    const f = day(D0, m);
    expect(f.values.featured_apps).toMatchObject({
      value: 127, status: "provisional", gap: { reason_code: "sanity_gate_failed", reason: "Featured apps moved 25% in a day", status: "open" },
    });
    expect(f.values.supply_cc).toMatchObject({ value: "39690000000.5000000000", gap: { reason_code: "sources_disagree", status: "open" } });
    // A resolved gap, or the whole day's, explains no number.
    expect(f.values.rounds?.gap).toBeNull();
    expect(f.values.app_rewards_cc?.gap).toBeNull();
  });

  it("names no source for a withdrawn null and cites the as_of of published values only", () => {
    // A null row can still carry a source_host and as_of (the schema's
    // provenance check allows it): here a later as_of than every published value.
    const rows = fullDay(D0).map((v) => (v.series === "app_rewards_cc" ? { ...v, value: null, as_of: `${D1}T05:00:00+00:00` } : v));
    const withdrawn = gapRow(D0, "app_rewards_cc", { reason_code: "withdrawn", reason: "Wrong coupon category", status: "open" });
    const f = day(D0, buildModel(rows, [withdrawn], []));
    expect(f.values.app_rewards_cc).toMatchObject({
      value: null, source_host: null, as_of: null, method: "scan-1", gap: { reason_code: "withdrawn", status: "open" },
    });
    expect(f.values.rounds).toMatchObject({ source_host: "api.cantonnodes.com", as_of: `${D1}T00:00:00Z` });
    expect(f.citation.plain).toContain(`As of ${formatDayShort(D1)} 00:00 UTC.`);
  });

  it("lists the day's published revisions with their values formatted", () => {
    const m = buildModel(
      fullDay(D0),
      [],
      [
        revisionRow(D0, "rounds", "2026-10-21T08:15:00+00:00"),
        { ...revisionRow(D0, "app_rewards_cc", "2026-10-20T10:00:00+00:00"), old_value: "120", kind: "correction", reason: "Coupon total re-read" },
        revisionRow(D0, "featured_apps", "2026-10-01T00:00:00+00:00"), // release 0: never published
        revisionRow(D1, "rounds", "2026-10-22T00:00:00+00:00"), // another day
      ],
    );
    const f = day(D0, m);
    expect(f.revisions).toEqual([
      { series: "app_rewards_cc", old_value: "120.0000000000", new_value: "15688736.6808733274", kind: "correction", reason: "Coupon total re-read", method: "scan-1", revised_at: "2026-10-20T10:00:00Z" },
      { series: "rounds", old_value: null, new_value: 140, kind: "backfill", reason: "Late data", method: "scan-1", revised_at: "2026-10-21T08:15:00Z" },
    ]);
    expect(f).toMatchObject({ revision: 2, revised_at: "2026-10-21T08:15:00Z" });
    expect(f.values.rounds).toMatchObject({ revision: 1, revised_at: "2026-10-21T08:15:00Z" });
    expect(f.values.featured_apps).toMatchObject({ revision: 0, revised_at: null });
    expect(f.citation.plain).toContain("revision 2.");
  });

  it("cites the latest as_of among the day's values", () => {
    const rows = fullDay(D0).map((v) =>
      v.series === "supply_cc" ? { ...v, as_of: `${D1}T01:30:00+00:00` }
      : v.series === "validator_licenses" ? { ...v, as_of: `${D0}T23:00:00+00:00` }
      : v.series === "featured_apps" ? { ...v, as_of: null }
      : v,
    );
    expect(day(D0, buildModel(rows, [], [])).citation.plain).toContain(`As of ${formatDayShort(D1)} 01:30 UTC.`);
  });

  it("refuses a date outside the published range", () => {
    expect(() => renderDayFile(model, addDays(D2, 1), "g1")).toThrow(/outside the published range/);
    expect(() => renderDayFile(model, addDays(D0, -1), "g1")).toThrow(/outside the published range/);
  });
});

describe("a day file already published", () => {
  // days/2026-10-25.json as served on 2026-10-27, generation g20261027T004001Z (the offline verify's copy).
  const raw = readFileSync(join(process.cwd(), "fixtures/verify/2026-10-25/published/days/2026-10-25.json"), "utf-8").replace(/\r\n/g, "\n");
  const published = JSON.parse(raw) as DayFile;
  const rowsOf = (hostOf: (series: string) => string | null): ValueRow[] =>
    Object.entries(published.values).map(([series, v]) => ({
      date: published.date,
      series: series as SeriesName,
      value: v?.value == null ? null : String(v.value),
      status: v?.status ?? "final",
      source_host: hostOf(series) ?? v?.source_host ?? null,
      method: v?.method ?? "scan-1",
      as_of: v?.as_of ?? null,
      retrieved_at: "2026-10-27T00:40:01Z",
      finalized_at: "2026-10-27T00:40:01Z",
      revision: v?.revision ?? 0,
      revised_at: v?.revised_at ?? null,
    })) as ValueRow[];
  const render = (rows: ValueRow[]) =>
    renderDayFile(
      buildModel(
        [...fullDay("2026-10-24"), ...rows, ...fullDay("2026-10-26")],
        published.gaps.map((g) => ({ ...g, date: published.date })) as never,
        [],
      ),
      published.date,
      published.generation_id,
    );

  it("renders to the same bytes while it names only api.cantonnodes.com: with no setting no published file changes", () => {
    expect(render(rowsOf(() => null))).toBe(raw);
  });

  it("keeps the words of a past day read from api.cantonnodes.com after another day reads a Super Validator", () => {
    const model = buildModel(
      [...fullDay("2026-10-24"), ...rowsOf(() => null), ...fullDay("2026-10-26").map((r) => ({ ...r, source_host: "scan.sv-2.global.canton.network.digitalasset.com" }))],
      published.gaps.map((g) => ({ ...g, date: published.date })) as never,
      [],
    );
    expect(renderDayFile(model, published.date, published.generation_id)).toBe(raw);
    expect((JSON.parse(renderDayFile(model, "2026-10-26", "g2")) as DayFile).license_scope).toBe(LICENSE_SCOPE_ANY_HOST);
  });

  it("says the words that hold once a day names a Super Validator, also when only one of its values does", () => {
    const one = JSON.parse(render(rowsOf((series) => (series === "rounds" ? "scan.sv-2.global.canton.network.digitalasset.com" : null)))) as DayFile;
    expect(one.license_scope).toBe(LICENSE_SCOPE_ANY_HOST);
    expect(one.license_scope).not.toContain("served publicly");
    expect(LICENSE_SCOPE).toContain("served publicly");
  });
});
