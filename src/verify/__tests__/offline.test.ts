/**
 * The offline verify over the recorded day in fixtures/verify: the published
 * files as served, and the Scan answers the online run read, replayed through
 * the same Scan client. No network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERIES_NAMES } from "../../open-record/contract";
import { configureScan } from "../../runtime/scan-settings";
import { liveScanApi } from "../../scan-record/scan-client";
import { dirPublished, type PublishedSource } from "../published";
import { readTape, replayFetch, VERIFY_SCAN_CLASS } from "../tape";
import { verifyDay } from "../verify";

const DIR = join(process.cwd(), "fixtures", "verify", "2026-10-25");
const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as {
  date: string;
  recorded_at: string;
  scan_host: string;
  migration_id_arg: number | null;
};

async function run(published: PublishedSource) {
  const replay = replayFetch(await readTape(join(DIR, "scan-tape.jsonl")));
  configureScan({ hosts: [meta.scan_host], fetch: replay });
  const report = await verifyDay({
    date: meta.date,
    published,
    scan: liveScanApi(VERIFY_SCAN_CLASS),
    migrationId: meta.migration_id_arg ?? undefined,
    now: new Date(meta.recorded_at),
  });
  return { report, replay };
}

afterEach(() => {
  configureScan({});
});

describe("the offline verify of the recorded day", () => {
  it("passes: the files are the served ones, render back byte for byte and re-derive from the recorded Scan answers", async () => {
    const { report, replay } = await run(dirPublished(DIR));
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.passed).toBe(true);
    expect(replay.unused()).toBe(0);
    // methodology.json and datapackage.json carry prose rendered from the code, which these copies of 2026-10-27
    // predate (the Scan host operator's facts were dated on 2026-11-04): a difference in that prose alone is a
    // warning, and what they state about the data must still match, or the check above would have failed.
    const prose = ["methodology.json", "datapackage.json"];
    for (const part of ["files", "render"] as const) {
      for (const c of report.checks.filter((x) => x.part === part && !(part === "render" && prose.includes(x.name)))) expect(c.status, c.name).toBe("ok");
    }
    for (const name of prose) {
      expect(report.checks.find((x) => x.part === "files" && x.name === name)?.status, name).toBe("ok");
      expect(["ok", "warn"], name).toContain(report.checks.find((x) => x.part === "render" && x.name === name)?.status);
    }
    // Every value Scan can serve again is re-derived from it; the two supply
    // series are reported apart, as inputs (supply_cc) and arithmetic on them.
    const supply = ["supply_cc", "net_supply_change_cc"];
    const scan = report.checks.filter((x) => x.part === "scan" && (SERIES_NAMES as readonly string[]).includes(x.name));
    expect(scan.map((c) => c.name).sort()).toEqual(SERIES_NAMES.filter((s) => !supply.includes(s)).sort());
    for (const c of scan) expect(c.status, c.name).toBe("ok");
    expect(report.checks.filter((x) => x.part === "supply").map((c) => [c.name, c.status])).toEqual([
      ["supply_cc", "info"],
      ["net_supply_change_cc", "ok"],
    ]);
  });

  it("fails a day file whose value was changed after it was served", async () => {
    const real = dirPublished(DIR);
    const day = `days/${meta.date}.json`;
    const tampered: PublishedSource = {
      origin: real.origin,
      async get(path) {
        const f = await real.get(path);
        if (!f || path !== day) return f;
        const doc = JSON.parse(f.body);
        doc.values.app_rewards_cc.value = "15688736.6819201123";
        return { ...f, body: `${JSON.stringify(doc, null, 2)}\n` };
      },
    };
    const { report } = await run(tampered);
    expect(report.passed).toBe(false);
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => `${c.part}:${c.name}`);
    expect(failed).toEqual(expect.arrayContaining([`files:${day}`, `render:${day}`, "scan:app_rewards_cc"]));
  });
});
