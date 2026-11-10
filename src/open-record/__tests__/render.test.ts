import { recordSourceHosts } from "../render";
import { describe, expect, it } from "vitest";
import { DAILY_COLUMNS, LICENSE_SCOPE, LICENSE_SCOPE_ANY_HOST, RECORD_FIRST_DATE, SERIES, addDays } from "../contract";
import {
  buildModel,
  csvCell,
  renderDailyCsv,
  renderDailyJson,
  renderGapsCsv,
  renderRevisionsCsv,
  renderValuesCsv,
} from "../render";
import { MISSING_DAY_REASON } from "../render";
import { fullDay, gapRow, revisionRow, vrow } from "./helpers/rows";

// The published range starts at RECORD_FIRST_DATE, so the fixture days are
// counted from it: D0 and D2 are stored, D1 has no row at all.
const D0 = RECORD_FIRST_DATE;
const D1 = addDays(D0, 1);
const D2 = addDays(D0, 2);
const D3 = addDays(D0, 3);

const model = () =>
  buildModel(
    [...fullDay(D0), ...fullDay(D2, "provisional", { app_rewards_cc: null })],
    [gapRow(D2, "app_rewards_cc", { status: "open" }), gapRow(D0, "supply_cc", { resolved_at: "2026-10-02T02:35:00+00:00", status: "resolved" })],
    [revisionRow(D0, "validator_licenses", "2026-10-01T00:00:00+00:00"), revisionRow(D0, "app_rewards_cc", "2026-10-20T10:00:00+00:00")],
  );

describe("daily.json's license words", () => {
  const day = fullDay(D0);
  it("stay as published while the record names only api.cantonnodes.com", () => {
    const doc = JSON.parse(renderDailyJson(buildModel(day, [], []), "g1").body);
    expect(doc.license_scope).toBe(LICENSE_SCOPE);
  });

  it("change once a value names another host", () => {
    const doc = JSON.parse(renderDailyJson(buildModel(day.map((r) => ({ ...r, source_host: "scan.sv-2.global.canton.network.digitalasset.com" })), [], []), "g1").body);
    expect(doc.license_scope).toBe(LICENSE_SCOPE_ANY_HOST);
  });
});

describe("recordSourceHosts", () => {
  it("lists each host once, also when one value names two", () => {
    const row = (source_host: string | null, value: string | null = "1") => ({ value, source_host }) as never;
    const model = {
      values: new Map([
        ["2026-11-07", new Map([["a", row("api.cantonnodes.com")], ["b", row("scan.sv-1.example, api.cantonnodes.com")], ["c", row("gone.example", null)]])],
      ]),
    } as never;
    expect(recordSourceHosts(model)).toEqual(["api.cantonnodes.com", "scan.sv-1.example"]);
  });
});

describe("csv primitives", () => {
  it("quotes only what RFC 4180 requires", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
  });
});

describe("daily.csv", () => {
  it("has the schema's header, one row per day, CRLF and no comment lines", () => {
    const { body, rows } = renderDailyCsv(model());
    const lines = body.split("\r\n");
    expect(lines[0]).toBe(DAILY_COLUMNS.join(","));
    expect(rows).toBe(3);
    expect(body.endsWith("\r\n")).toBe(true);
    expect(body.includes("#")).toBe(false);
  });

  it("prints counts as integers and amounts with 10 places, and counts only published revisions", () => {
    const line = renderDailyCsv(model()).body.split("\r\n")[1];
    expect(line).toBe(
      `${D0},final,200001,200140,140,39690000000.5000000000,8465034.2541081825,0.1192960000,` +
        "26636225.2699264274,15688736.6808733274,1873305.5784408140,5060882.8041730000,1331811.2633181160," +
        "0.0000000000,0.0000000000,2681488.9431211700,13,9,127,1400,28491906.9054931780,9366527.8922040700," +
        "scan-1,1,2026-10-20T10:00:00Z",
    );
  });

  it("keeps a day with no row as an empty provisional line, never a zero", () => {
    const line = renderDailyCsv(model()).body.split("\r\n")[2];
    expect(line).toBe([D1, "provisional", ...Array(SERIES.length).fill(""), "", "0", ""].join(","));
  });
});

describe("daily.json", () => {
  it("carries amounts as strings, counts as numbers, and the generation id", () => {
    const doc = JSON.parse(renderDailyJson(model(), "g20261006T024000Z").body);
    expect(doc.generation_id).toBe("g20261006T024000Z");
    expect(doc.license.name).toBe("CC-BY-4.0");
    expect(doc.rows[0].supply_cc).toBe("39690000000.5000000000");
    expect(doc.rows[0].featured_apps).toBe(127);
    // Coupon totals are sums of decimal coupon amounts, not counts: they keep their 10 places.
    expect(doc.rows[0].app_reward_coupons).toBe("28491906.9054931780");
    expect(doc.rows[0].validator_reward_coupons).toBe("9366527.8922040700");
    expect(doc.rows[2].status).toBe("provisional");
    expect(doc.rows[2].app_rewards_cc).toBeNull();
  });

  it("scopes the license to the derived aggregates and names the source hosts", () => {
    const doc = JSON.parse(renderDailyJson(model(), "g1").body);
    expect(doc.license_scope).toBe(LICENSE_SCOPE);
    expect(doc.source_hosts).toEqual(["api.cantonnodes.com"]);

    // Distinct and sorted, and only hosts that served a published value.
    const other = { ...vrow(D1, "rounds", "140.0000000000"), source_host: "scan.sv-2.example" };
    const unused = { ...vrow(D1, "featured_apps", null), source_host: "scan.sv-3.example" };
    const mixed = JSON.parse(renderDailyJson(buildModel([...fullDay(D0), other, unused], [], []), "g1").body);
    expect(mixed.source_hosts).toEqual(["api.cantonnodes.com", "scan.sv-2.example"]);
  });
});

describe("values.csv, gaps.csv, revisions.csv", () => {
  it("lists every stored value with its provenance, and names no source for a null", () => {
    // A null row can still carry a source_host and as_of (the schema's
    // provenance check allows it): a null must not credit the host with a
    // figure CCTools does not publish.
    const { body, rows } = renderValuesCsv(model());
    expect(rows).toBe(2 * SERIES.length);
    expect(body).toContain(`${D2},app_rewards_cc,,provisional,,scan-1,,0,`);
    expect(body).toContain(`${D2},rounds,140,provisional,api.cantonnodes.com,scan-1,${D3}T00:00:00Z,0,`);
  });

  it("gives a series with no row on a stored day its own reason in gaps.csv", () => {
    const m = buildModel(fullDay(D0).filter((v) => v.series !== "featured_apps"), [], []);
    const { body, rows } = renderGapsCsv(m);
    expect(rows).toBe(1);
    expect(body).toContain(`${D0},featured_apps,not_collected,${MISSING_DAY_REASON},open,${D1}T00:00:00Z,,`);
  });

  it("keeps resolved gaps with their resolution time", () => {
    const { body, rows } = renderGapsCsv(model());
    expect(rows).toBe(3);
    expect(body).toContain(`${D0},supply_cc,round_missed,Rounds not captured: 200070,resolved,2026-10-06T00:35:00Z,2026-10-02T02:35:00Z,`);
  });

  it("gives a day with no rows a whole-day reason, unless one is stored", () => {
    // D1 sits between two stored days and has no row at all.
    expect(renderGapsCsv(model()).body).toContain(`${D1},all,not_collected,${MISSING_DAY_REASON},open,${D2}T00:00:00Z,,`);
    const stored = buildModel(
      [...fullDay(D0), ...fullDay(D2)],
      [gapRow(D1, "all", { reason_code: "source_unavailable", reason: "Scan unreachable all day" })],
      [],
    );
    expect(stored.gaps.filter((g) => g.date === D1)).toHaveLength(1);
  });

  it("starts the range at RECORD_FIRST_DATE, so days before the first stored day keep a reason", () => {
    // The backfill runs oldest first and can give up on a day: the head of the
    // range must still be published, each day with a row or a reason.
    const first = addDays(D0, 10);
    const m = buildModel(fullDay(first), [gapRow(addDays(D0, 8), "supply_cc", { status: "resolved", resolved_at: "2026-10-02T02:35:00+00:00" })], []);
    expect(m.dates[0]).toBe(RECORD_FIRST_DATE);
    expect(m.dates).toHaveLength(11);
    expect(renderDailyCsv(m).rows).toBe(11);
    expect(renderDailyCsv(m).body.split("\r\n")[1]).toBe([D0, "provisional", ...Array(SERIES.length).fill(""), "", "0", ""].join(","));
    for (const d of m.dates) {
      if (m.values.has(d)) continue;
      expect(m.gaps.filter((g) => g.date === d && g.series === "all" && g.resolved_at == null)).toMatchObject([
        { reason_code: "not_collected", reason: MISSING_DAY_REASON, status: "open" },
      ]);
    }
    // gaps.csv describes no day that daily.csv leaves out.
    expect(m.gaps.every((g) => m.dates.includes(g.date))).toBe(true);
    // A stored day with gaps only still ends the range.
    const tail = buildModel(fullDay(D0), [gapRow(D2, "all", { reason_code: "source_unavailable", reason: "Scan unreachable all day" })], []);
    expect(tail.dates).toEqual([D0, D1, D2]);
  });

  it("renders gaps that share (date, series, reason_code) in the same order whatever order they are read in", () => {
    // A resolved gap and its recurrence share the key.
    const resolved = gapRow(D0, "supply_cc", { status: "resolved", detected_at: "2026-10-06T00:35:00+00:00", resolved_at: "2026-10-06T02:35:00+00:00" });
    const early = gapRow(D0, "supply_cc", { status: "resolved", detected_at: "2026-10-07T00:35:00+00:00", resolved_at: "2026-10-07T01:35:00+00:00" });
    const sameTimes = { ...early, reason: "Rounds not captured: 200069" };
    const late = gapRow(D0, "supply_cc", { status: "resolved", detected_at: "2026-10-07T00:35:00Z", resolved_at: "2026-10-07T03:35:00+00:00" });
    const recurrence = gapRow(D0, "supply_cc", { status: "open", detected_at: "2026-10-08T00:35:00+00:00" });
    const rows = [recurrence, late, resolved, early, sameTimes];
    const a = renderGapsCsv(buildModel(fullDay(D0), rows, [])).body;
    const b = renderGapsCsv(buildModel(fullDay(D0), [...rows].reverse(), [])).body;
    expect(b).toBe(a);
    expect(a.split("\r\n").slice(1, 6).map((l) => l.split(",").slice(3, 7).join(","))).toEqual([
      "Rounds not captured: 200070,resolved,2026-10-06T00:35:00Z,2026-10-06T02:35:00Z",
      "Rounds not captured: 200069,resolved,2026-10-07T00:35:00Z,2026-10-07T01:35:00Z",
      "Rounds not captured: 200070,resolved,2026-10-07T00:35:00Z,2026-10-07T01:35:00Z",
      "Rounds not captured: 200070,resolved,2026-10-07T00:35:00Z,2026-10-07T03:35:00Z",
      "Rounds not captured: 200070,open,2026-10-08T00:35:00Z,",
    ]);
  });

  it("publishes only revisions made after the release", () => {
    const { body, rows } = renderRevisionsCsv(model());
    expect(rows).toBe(1);
    expect(body).toContain(`${D0},app_rewards_cc,,15688736.6808733274,backfill,Late data,scan-1,2026-10-20T10:00:00Z`);
    expect(body).not.toContain("validator_licenses");
  });

  it("renders revisions that share revised_at in the same order whatever order they are read in", () => {
    // One transaction, or the same millisecond: the read order must not reach the bytes.
    const at = "2026-10-20T10:00:00+00:00";
    const rows = [
      revisionRow(D2, "rounds", at),
      { ...revisionRow(D0, "app_rewards_cc", at), kind: "correction" as const, old_value: "120" },
      revisionRow(D0, "app_rewards_cc", "2026-10-20T10:00:00Z"),
      revisionRow(D0, "supply_cc", at),
      revisionRow(D0, "app_rewards_cc", "2026-10-19T10:00:00+00:00"),
    ];
    const a = buildModel(fullDay(D0), [], rows);
    const b = buildModel(fullDay(D0), [], [...rows].reverse());
    expect(renderRevisionsCsv(b).body).toBe(renderRevisionsCsv(a).body);
    expect(a.revisions.map((r) => `${r.date} ${r.series} ${r.kind} ${r.revised_at.slice(0, 10)}`)).toEqual([
      `${D0} app_rewards_cc backfill 2026-10-19`,
      `${D0} app_rewards_cc backfill 2026-10-20`,
      `${D0} app_rewards_cc correction 2026-10-20`,
      `${D0} supply_cc backfill 2026-10-20`,
      `${D2} rounds backfill 2026-10-20`,
    ]);
  });

  it("ignores stray rows before the first published date", () => {
    expect(buildModel([vrow("2026-03-20", "rounds", "140")], [], []).dates).toEqual([]);
  });

  it("keeps gaps and revisions of days before the first published date out of the files", () => {
    // When RECORD_FIRST_DATE moves forward, the backfilled rows of the
    // earlier days stay in the tables: their gaps and
    // revisions must not describe days daily.csv does not publish.
    const m = buildModel(
      fullDay(D0),
      [gapRow("2026-03-20", "supply_cc"), gapRow(D0, "supply_cc")],
      [revisionRow("2026-03-20", "rounds", "2026-10-20T10:00:00+00:00")],
    );
    expect(m.gaps.map((g) => g.date)).toEqual([D0]);
    expect(renderRevisionsCsv(m).rows).toBe(0);
  });
});
