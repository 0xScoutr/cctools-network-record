import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUND_TOTALS_SERIES_VERIFIED } from "../../scan-record/config";
import {
  DAY_FILE_RE,
  FRESHNESS,
  LICENSE_SCOPE,
  RECORD_FIRST_DATE,
  SERIES,
  STATIC_FILES,
  TRADEMARK_NOTICE,
  addDays,
  type Manifest,
  type StoredFile,
  type ValueRow,
} from "../contract";
import { renderMethodology } from "../methodology";
import { publishRecord, type FileCache, type RecordReader } from "../publish";
import { buildModel, sha256Hex } from "../render";
import { dataHeaders, statusDocument } from "../serve";
import { fullDay } from "./helpers/rows";

const doc = JSON.parse(renderMethodology(buildModel(fullDay("2026-10-05"), [], []), ["api.cantonnodes.com"], "g1"));
const text = JSON.stringify(doc);

describe("methodology.json, the Methodology page content source", () => {
  it("has its eleven sections, in order", () => {
    expect(doc.sections.map((s: { id: string }) => s.id)).toEqual([
      "rules", "daily-record", "sources", "data-classes", "gaps", "revisions", "downloads", "cite",
      "reproducibility", "limitations", "before-the-record",
    ]);
  });

  it("builds the field table from the contract, never from typed copy", () => {
    const table = doc.sections.find((s: { id: string }) => s.id === "daily-record").table;
    expect(table.rows).toHaveLength(SERIES.length);
    expect(table.rows[0][0]).toBe("first_round");
  });

  it("names the host, says single operator, and uses the qualified access wording", () => {
    expect(text).toContain("api.cantonnodes.com");
    expect(text).toContain("single operator");
    expect(text).toContain("observable by any onboarded validator");
    expect(text).not.toMatch(/publicly observable(?! by)/);
  });

  it("names the operator, says it publishes no terms, and scopes the license to the derived aggregates", () => {
    const sources = doc.sections.find((s: { id: string }) => s.id === "sources");
    expect(JSON.stringify(sources)).toContain("Proof Group");
    expect(JSON.stringify(sources)).toContain("no published terms of service or data license");
    const downloads = JSON.stringify(doc.sections.find((s: { id: string }) => s.id === "downloads"));
    expect(downloads).toContain(LICENSE_SCOPE);
    expect(downloads).toContain(TRADEMARK_NOTICE);
    expect(downloads).toContain("permanently free");
  });

  it("names the host it reads and its operator together, even before a value is stored", () => {
    const empty = JSON.parse(renderMethodology(buildModel([], [], []), [], "g0"));
    const sources = JSON.stringify(empty.sections.find((s: { id: string }) => s.id === "sources"));
    expect(sources).toContain("api.cantonnodes.com");
    expect(sources).toContain("Proof Group");
  });

  it("gives every field its settle window and method", () => {
    const table = doc.sections.find((s: { id: string }) => s.id === "daily-record").table;
    expect(table.columns).toEqual(["Column", "Unit", "Definition", "Scan source", "Since", "Settle window", "Method"]);
    expect(table.rows[0][5]).toBe(`Final by ${FRESHNESS.final_by}`);
    expect(table.rows[0][5]).toBe("Final by D+1 03:00 UTC");
    expect(table.rows[0][6]).toBe("scan-1");
  });

  it("states the same freshness targets as status.json", () => {
    expect(text).toContain(`provisional by ${FRESHNESS.provisional_by} and final by ${FRESHNESS.final_by}`);
    expect(text).toContain("provisional by D+1 01:00 UTC and final by D+1 03:00 UTC");
  });

  it("defines the coupon totals as the StartIssuing summary's, never collected before the collector started", () => {
    const table = doc.sections.find((s: { id: string }) => s.id === "daily-record").table;
    const row = (name: string) => table.rows.find((r: string[]) => r[0] === name);
    expect(row("app_reward_coupons")).toEqual(expect.arrayContaining([
      "coupons", "POST /v2/updates, AmuletRules_MiningRound_StartIssuing summary, totalFeaturedAppRewardCoupons",
    ]));
    expect(row("validator_reward_coupons")).toEqual(expect.arrayContaining([
      "coupons", "POST /v2/updates, AmuletRules_MiningRound_StartIssuing summary, totalValidatorRewardCoupons",
    ]));
    const classes = doc.sections.find((s: { id: string }) => s.id === "data-classes").table;
    expect(classes.rows[0][0]).toContain("reward coupon totals");
    const limitations = JSON.stringify(doc.sections.find((s: { id: string }) => s.id === "limitations"));
    expect(limitations).toContain("Reward coupon totals start with the forward collector");
  });

  it("carries the full data-classes table, with the excluded metadata-dependent row", () => {
    const table = doc.sections.find((s: { id: string }) => s.id === "data-classes").table;
    expect(table.columns).toEqual(["Series", "Data required", "Class", "Depends on involved-party or Mediator metadata", "If that metadata disappears"]);
    expect(table.rows.at(-1)).toEqual(["All synchronizer transactions, total parties", "Mediator verdicts, topology", "Metadata-dependent", "Yes", "Would break: excluded from the record"]);
  });

  it("says nothing is published under scan-rt-1, and why, as config.ts verifies no round-totals series", () => {
    const revisions = doc.sections.find((s: { id: string }) => s.id === "revisions");
    const line = revisions.paragraphs.find((p: string) => p.startsWith("Method versions"));
    expect(line).toBe(
      "Method versions: scan-1 (forward StartIssuing capture and the D+1 00:00Z ACS snapshot); scan-rt-1 (reserved for the " +
        "archived round-totals endpoint, which was checked against the StartIssuing split and matches it for neither app nor " +
        "validator rewards: its app rewards exceed the featured-app pool a round can issue, consistent with counting rewards " +
        "collected rather than issued, so nothing from it is published).",
    );
    // The line is written for this verification: changing a series in config.ts fails here until the line follows.
    expect(ROUND_TOTALS_SERIES_VERIFIED).toEqual({ app_rewards_cc: false, validator_rewards_cc: false });
  });

  it("lists the methods of a series' published values only, never the method of an empty row", () => {
    // 2026-05-01: an empty sv_rewards_cc row labelled scan-rt-1 (a gap's row)
    // beside an app_rewards_cc value labelled scan-rt-1; 2026-10-05: scan-1 values.
    const early = fullDay("2026-05-01", "final", { sv_rewards_cc: null }).map((v) =>
      v.series === "sv_rewards_cc" || v.series === "app_rewards_cc" ? { ...v, method: "scan-rt-1" as const } : v,
    );
    const d = JSON.parse(renderMethodology(buildModel([...early, ...fullDay("2026-10-05")], [], []), ["api.cantonnodes.com"], "g2"));
    const table = d.sections.find((s: { id: string }) => s.id === "daily-record").table;
    const method = (name: string) => table.rows.find((r: string[]) => r[0] === name)[6];
    expect(method("sv_rewards_cc")).toBe("scan-1");
    expect(method("app_rewards_cc")).toBe("scan-rt-1, scan-1");
  });

  it("says a withdrawal lasts until a correction restores the value (revise_network_record in sql/schema.sql)", () => {
    const revisions = JSON.stringify(doc.sections.find((s: { id: string }) => s.id === "revisions"));
    expect(revisions).toContain("A withdrawn value stays empty until a correction restores it");
  });

  it("says only a changed value is a revision (the schema: an unchanged value logs nothing and keeps its provenance)", () => {
    const revisions = JSON.stringify(doc.sections.find((s: { id: string }) => s.id === "revisions"));
    expect(revisions).not.toContain("source host or as-of time changed");
    expect(revisions).toContain("A recomputation that gives the same value is not a revision");
  });

  it("states the earlier table's defects instead of hiding them", () => {
    const before = JSON.stringify(doc.sections.find((s: { id: string }) => s.id === "before-the-record"));
    for (const d of ["2026-03-28", "2026-03-29", "2026-04-14", "2026-06-18", "2026-08-14"]) expect(before).toContain(d);
    expect(before).toContain("401");
    expect(before).toContain("429");
  });

  it("names Loop Data, formerly Lighthouse, by Five North at its first mention, and Loop Data after that", () => {
    const bridge = "Loop Data (formerly Lighthouse), by Five North";
    // The first mention in document order is the validator_licenses definition in the daily-record table.
    expect(text.split(bridge)).toHaveLength(2);
    expect(text.indexOf("Loop Data")).toBe(text.indexOf(bridge));
    expect(text.split(bridge).join("")).not.toContain("Lighthouse");
    const table = doc.sections.find((s: { id: string }) => s.id === "daily-record").table;
    expect(table.rows.find((r: string[]) => r[0] === "validator_licenses")[2]).toContain(bridge);
    const sources = JSON.stringify(doc.sections.find((s: { id: string }) => s.id === "sources"));
    expect(sources).toContain("Loop Data and market price providers are not sources of the record.");
    const before = JSON.stringify(doc.sections.find((s: { id: string }) => s.id === "before-the-record"));
    expect(before).toContain("copied from a third-party indexer (Loop Data).");
  });

  it("carries the trademark notice in the downloads section, word for word as the site footer does", () => {
    const downloads = doc.sections.find((s: { id: string }) => s.id === "downloads").paragraphs;
    expect(downloads).toContain(
      "Canton is a registered trademark of Digital Asset (Switzerland) GmbH. Digital Asset is not affiliated with, and has not sponsored or endorsed, CCTools.",
    );
  });

  it("states freshness as a target until the burn-in is measured", () => {
    expect(text).toContain("target");
    expect(text).not.toContain("commitment:");
  });
});

/**
 * The reproducibility section against the status.json that publish.ts and serve.ts build: thirty renders that each
 * change a value, so the manifest is past its generation cap, then the methodology.json the last one left stored.
 */
async function published() {
  const d0 = RECORD_FIRST_DATE;
  const d1 = addDays(d0, 1);
  const state = { values: [] as ValueRow[], dirty: "", manifest: null as Manifest | null, stored: new Map<string, StoredFile>() };
  const reader: RecordReader = {
    values: async () => state.values,
    gaps: async () => [],
    revisions: async () => [],
    dirtyAt: async () => state.dirty,
  };
  const cache: FileCache = {
    manifest: async () => (state.manifest ? { status: "hit", value: state.manifest } : { status: "miss" }),
    putFiles: async (files) => {
      for (const f of files) state.stored.set(f.path, f);
    },
    putManifest: async (m) => {
      state.manifest = m;
    },
  };
  const start = Date.parse("2026-10-06T02:40:00Z");
  for (let i = 0; i < 30; i++) {
    state.values = [...fullDay(d0), ...fullDay(d1, "final", { featured_apps: `${130 + i}.0000000000` })];
    state.dirty = `d${i}`;
    await publishRecord({ reader, cache, now: new Date(start + i * 3_600_000) });
  }
  const status = statusDocument(state.manifest!, start + 30 * 3_600_000);
  const methodology = JSON.parse(state.stored.get("methodology.json")!.body);
  const paragraph: string = methodology.sections.find((s: { id: string }) => s.id === "reproducibility").paragraphs.join(" ");
  return { status, stored: state.stored, paragraph };
}

describe("methodology.json's reproducibility section says what status.json lists", () => {
  it("names exactly the files status.json gives a sha256 for, and the number of generations it keeps", async () => {
    const { status, paragraph } = await published();
    const hashed = [
      ...new Set([
        ...Object.entries(status.files).filter(([, f]) => typeof f.sha256 === "string").map(([path]) => path),
        ...status.generations.flatMap((g) => Object.keys(g.files)),
      ]),
    ].sort();
    expect(hashed).toEqual([...STATIC_FILES].sort());
    expect(hashed.filter((path) => DAY_FILE_RE.test(path))).toEqual([]);
    expect(status.generations).toHaveLength(24);

    expect(paragraph).not.toMatch(/every file/i);
    const listing = /status\.json lists the sha256 of (.+?) for each of the last (\d+) generations\./.exec(paragraph);
    expect(listing, paragraph).not.toBeNull();
    expect((listing![1].match(/[\w-]+\.(?:csv|json)/g) ?? []).sort()).toEqual(hashed);
    expect(Number(listing![2])).toBe(status.generations.length);
  });

  it("says the day files are counted with their first and last dates, not hashed, and that each one's ETag is its body's sha256", async () => {
    const { status, stored, paragraph } = await published();
    const days = [...stored.values()].filter((f) => DAY_FILE_RE.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
    expect(days).toHaveLength(2);
    expect(status.day_files).toEqual({
      count: days.length,
      first: DAY_FILE_RE.exec(days[0].path)![1],
      last: DAY_FILE_RE.exec(days[days.length - 1].path)![1],
    });
    // The origin's ETag is the stored body's sha256 (publish.ts), strong; the edge may weaken it when it compresses (serve.ts etagMatches).
    for (const f of days) expect(dataHeaders(f).ETag).toBe(`"${sha256Hex(f.body)}"`);

    expect(paragraph).toContain(
      "For the day files it gives their count and their first and last dates, not their sha256: each day file is served with the sha256 of its uncompressed body as its ETag, which the edge may mark weak (W/).",
    );
  });

  it("matches the recorded day files: each arrived through the edge with its decompressed body's sha256 as a weak ETag", () => {
    const dir = join(process.cwd(), "fixtures", "verify", "2026-10-25", "published");
    const headers = JSON.parse(readFileSync(join(dir, "headers.json"), "utf-8")) as Record<string, { etag: string | null }>;
    const days = Object.keys(headers).filter((path) => DAY_FILE_RE.test(path));
    expect(days.length).toBeGreaterThan(0);
    for (const path of days) expect(headers[path].etag, path).toBe(`W/"${sha256Hex(readFileSync(join(dir, path), "utf-8"))}"`);
  });
});
