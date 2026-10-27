/**
 * The verify command (`pnpm verify`, which runs this file with tsx): check
 * one published day of the CCTools daily record of the Canton Network against
 * its own files, this package's renderer and public Scan.
 *
 *   online   pnpm verify --date 2026-10-25
 *            [--base-url https://api.cctools.network/api/open/network-record/v1/]
 *            [--scan-host https://api.cantonnodes.com] [--migration-id 4]
 *            [--spacing-ms 20000] [--skip-scan] [--record DIR] [--strict] [--json]
 *   offline  pnpm verify --offline DIR [--strict] [--json]
 *
 * --record DIR keeps everything the online run read (the published files, and
 * a tape of the Scan answers) so that --offline DIR repeats the same checks
 * with no network. Exit code 0 when nothing failed (and for --help), 1 when a
 * check failed, 2 for a usage or run error.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OPEN_BASE_URL } from "../open-record/contract";
import { configureScan } from "../runtime/scan-settings";
import { liveScanApi } from "../scan-record/scan-client";
import { dirPublished, httpPublished, recordingPublished, type PublishedSource } from "./published";
import { DEFAULT_SPACING_MS, pacedFetch, readTape, recordingFetch, replayFetch, writeTape, type TapeEntry } from "./tape";
import { verifyDay, type Check, type VerifyReport } from "./verify";

const DEFAULT_SCAN_HOST = "https://api.cantonnodes.com";

interface Args {
  date?: string;
  baseUrl: string;
  scanHost: string;
  migrationId?: number;
  spacingMs: number;
  skipScan: boolean;
  record?: string;
  offline?: string;
  strict: boolean;
  json: boolean;
}

interface FixtureMeta {
  date: string;
  recorded_at: string;
  base_url: string;
  scan_host: string | null;
  migration_id: number | null;
  /** The --migration-id the recorded run was given, so the offline run asks Scan the same calls. */
  migration_id_arg: number | null;
  scan_requests: number;
  tool: string;
}

const USAGE = [
  "usage:",
  "  pnpm verify --date YYYY-MM-DD [--base-url URL] [--scan-host URL] [--migration-id N]",
  "              [--spacing-ms MS] [--skip-scan] [--record DIR] [--strict] [--json]",
  "  pnpm verify --offline DIR [--strict] [--json]",
].join("\n");

/** A usage error: the message and the usage on stderr, exit 2. */
function usage(message: string): never {
  console.error(`error: ${message}\n`);
  console.error(USAGE);
  process.exit(2);
}

/** --help: the usage on stdout, exit 0. */
function help(): never {
  console.log(USAGE);
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { baseUrl: OPEN_BASE_URL, scanHost: DEFAULT_SCAN_HOST, spacingMs: DEFAULT_SPACING_MS, skipScan: false, strict: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) usage(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--date": args.date = value(); break;
      case "--base-url": args.baseUrl = value(); break;
      case "--scan-host": args.scanHost = value(); break;
      case "--migration-id": args.migrationId = Number(value()); break;
      case "--spacing-ms": args.spacingMs = Number(value()); break;
      case "--skip-scan": args.skipScan = true; break;
      case "--record": args.record = value(); break;
      case "--offline": args.offline = value(); break;
      case "--strict": args.strict = true; break;
      case "--json": args.json = true; break;
      case "--help": case "-h": help();
      default: usage(`unknown argument ${a}`);
    }
  }
  if (!args.offline && !args.date) usage("give --date, or --offline with a recorded directory");
  if (args.offline && (args.date || args.record)) usage("--offline takes its date from the recorded directory");
  if (!args.scanHost.startsWith("https://")) usage("--scan-host must be an https URL");
  if (args.migrationId != null && !Number.isSafeInteger(args.migrationId)) usage("--migration-id must be a whole number");
  if (!Number.isFinite(args.spacingMs) || args.spacingMs < 0) usage("--spacing-ms must be a number of milliseconds");
  return args;
}

const MARK: Record<Check["status"], string> = { ok: "ok  ", fail: "FAIL", warn: "warn", info: "    " };
const PARTS: Record<Check["part"], string> = {
  files: "1. Published files and their sha256",
  render: "2. Rendered again from the published rows",
  scan: "3. Re-derived from Scan",
  supply: "4. Supply: from the published files, which Scan cannot serve again for a past day",
};

function print(report: VerifyReport, offline: boolean): void {
  console.log(`\nCCTools daily record of the Canton Network: verify ${report.date}${offline ? " (offline, recorded answers)" : ""}`);
  console.log(`files from ${report.origin}${report.generation ? `, generation ${report.generation}` : ""}`);
  for (const part of ["files", "render", "scan", "supply"] as const) {
    const rows = report.checks.filter((c) => c.part === part);
    if (rows.length === 0) continue;
    console.log(`\n${PARTS[part]}`);
    const width = Math.max(...rows.map((c) => c.name.length));
    for (const c of rows) console.log(`  ${MARK[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const count = (s: Check["status"]) => report.checks.filter((c) => c.status === s).length;
  console.log(
    `\n${report.passed ? "PASSED" : "FAILED"}: ${count("ok")} ok, ${count("fail")} failed, ${count("warn")} warnings, ${count("info")} notes`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (line: string) => console.error(`  .. ${line}`);

  if (args.offline) {
    const dir = args.offline;
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf-8")) as FixtureMeta;
    let replay: ReturnType<typeof replayFetch> | null = null;
    if (meta.scan_host) {
      replay = replayFetch(await readTape(join(dir, "scan-tape.jsonl")));
      configureScan({ hosts: [meta.scan_host], fetch: replay });
    }
    const report = await verifyDay({
      date: meta.date,
      published: dirPublished(dir),
      scan: meta.scan_host ? liveScanApi("user") : undefined,
      migrationId: meta.migration_id_arg ?? undefined,
      now: new Date(meta.recorded_at),
      strict: args.strict,
      log,
    });
    if (replay && replay.unused() > 0) {
      report.checks.push({ part: "scan", name: "tape", status: "fail", detail: `${replay.unused()} recorded answers were not asked for: the run did not repeat the recorded one` });
      report.passed = false;
    }
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else print(report, true);
    process.exit(report.passed ? 0 : 1);
  }

  const date = args.date as string;
  let published: PublishedSource = httpPublished(args.baseUrl);
  const recorder = args.record ? recordingPublished(published, args.record) : null;
  if (recorder) published = recorder;
  const tape: TapeEntry[] = [];
  if (!args.skipScan) {
    const paced = pacedFetch({ spacingMs: args.spacingMs, retries: 6, backoffMs: 30_000, log });
    configureScan({ hosts: [args.scanHost], fetch: args.record ? recordingFetch(paced, tape) : paced });
  }
  const report = await verifyDay({
    date,
    published,
    scan: args.skipScan ? undefined : liveScanApi("user"),
    migrationId: args.migrationId,
    now: new Date(),
    strict: args.strict,
    log,
  });
  if (args.record && recorder) {
    await mkdir(args.record, { recursive: true });
    await recorder.save();
    if (!args.skipScan) await writeTape(join(args.record, "scan-tape.jsonl"), tape);
    const meta: FixtureMeta = {
      date,
      recorded_at: new Date().toISOString(),
      base_url: args.baseUrl,
      scan_host: args.skipScan ? null : args.scanHost,
      migration_id: report.derived?.migrationId ?? args.migrationId ?? null,
      migration_id_arg: args.migrationId ?? null,
      scan_requests: tape.length,
      tool: "cctools-network-record verify",
    };
    await writeFile(join(args.record, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
    log(`recorded to ${args.record}: published files, ${tape.length} Scan answers, meta.json`);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else print(report, false);
  process.exit(report.passed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
