/**
 * Verify one published day of the record, in three parts:
 *
 *   files      every file read has the sha256 status.json lists for it (a
 *              static file, in some listed generation) or the ETag it was
 *              served with (a day file), so what was checked is what is served;
 *   render     the files rendered again with this package's code from the
 *              published rows (values.csv, gaps.csv, revisions.csv) are byte
 *              for byte the published ones, so the published bytes come from
 *              this code and those rows. methodology.json and
 *              datapackage.json are also compared on what they state about
 *              the data (documentation.ts): a difference there fails, and a
 *              difference only in their prose is a warning;
 *   scan       the day's values re-derived from Scan (derive.ts) equal the
 *              published ones, value by value;
 *   supply     what Scan cannot serve again for a past day: supply_cc, taken
 *              from the published file as an input, and net_supply_change_cc,
 *              recomputed from the published supply_cc of D and D-1. Both
 *              are reported apart from the Scan part, so its count is only
 *              of values re-derived from Scan.
 *
 * A check is `ok`, `fail`, `warn` (a difference that is not in the data: the
 * prose of a documentation file rendered by another text version, a file an
 * edge still serves from an older generation, a value held by a gate) or
 * `info`. A run passes when nothing fails; strict also fails warnings.
 */

import { createHash } from "node:crypto";
import {
  DAY_FILE_RE,
  SERIES_NAMES,
  STATIC_FILES,
  addDays,
  dayFilePath,
  isValidDate,
  sameFinalValue,
  type DayFile,
  type SeriesName,
} from "../open-record/contract";
import { renderDatapackage } from "../open-record/datapackage";
import { renderDayFile } from "../open-record/day-file";
import { renderMethodology } from "../open-record/methodology";
import {
  buildModel,
  isoZ,
  recordSourceHosts,
  renderDailyCsv,
  renderDailyJson,
  renderGapsCsv,
  renderRevisionsCsv,
  renderValuesCsv,
} from "../open-record/render";
import type { ScanApi } from "../scan-record/scan-client";
import { deriveDay, type DerivedDay } from "./derive";
import { documentationFactsDiffer } from "./documentation";
import { gapRows, revisionRows, valueRows, type PublishedFile, type PublishedSource } from "./published";

export type CheckStatus = "ok" | "fail" | "warn" | "info";

export interface Check {
  part: "files" | "render" | "scan" | "supply";
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface VerifyReport {
  date: string;
  origin: string;
  generation: string | null;
  checks: Check[];
  derived: Omit<DerivedDay, "series" | "rounds" | "snapshot"> | null;
  passed: boolean;
}

/** Files whose prose is documentation rendered from the code; what they state about the data is compared strictly. */
const DOCUMENTATION_FILES = new Set(["methodology.json", "datapackage.json"]);
/** Series Scan cannot serve again for a past day: the registry serves only the current supply. */
const INPUT_SERIES = new Set<SeriesName>(["supply_cc"]);
/** Series recomputed from published inputs only (supply_cc of D and D-1), never read from Scan. */
const FROM_INPUTS = new Set<SeriesName>(["net_supply_change_cc"]);

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const short = (hex: string) => hex.slice(0, 12);

interface StatusDoc {
  generation_id: string;
  files: Record<string, { sha256: string }>;
  generations: Array<{ generation_id: string; files: Record<string, string> }>;
}

function etagHash(etag: string | null): string | null {
  if (!etag) return null;
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** The first line where two texts differ, for the report. */
function firstDifference(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      const cut = (s: string | undefined) => (s == null ? "(no line)" : s.length > 160 ? `${s.slice(0, 160)}...` : s);
      return `line ${i + 1}: published ${cut(x[i])} | rendered ${cut(y[i])}`;
    }
  }
  return "same lines, different bytes";
}

export async function verifyDay(opts: {
  date: string;
  published: PublishedSource;
  /** Absent: the scan part is skipped. */
  scan?: ScanApi;
  migrationId?: number;
  now: Date;
  strict?: boolean;
  log?: (line: string) => void;
}): Promise<VerifyReport> {
  const { date, published } = opts;
  if (!isValidDate(date)) throw new Error(`${date} is not a date (YYYY-MM-DD)`);
  const log = opts.log ?? (() => {});
  const checks: Check[] = [];
  const add = (part: Check["part"], name: string, status: CheckStatus, detail: string) => checks.push({ part, name, status, detail });

  // 1. The files, and their hashes.
  log(`reading the published files from ${published.origin}`);
  const need = async (path: string): Promise<PublishedFile> => {
    const f = await published.get(path);
    if (!f) throw new Error(`${path} is not published`);
    return f;
  };
  const status = JSON.parse((await need("status.json")).body) as StatusDoc;
  const files = new Map<string, PublishedFile>();
  for (const p of STATIC_FILES) files.set(p, await need(p));
  const dayPath = dayFilePath(date);
  const dayFile = await need(dayPath);
  const prevDayPath = dayFilePath(addDays(date, -1));
  const prevDayFile = await published.get(prevDayPath);

  const generationsOf = (path: string, hash: string) =>
    status.generations.filter((g) => g.files[path] === hash).map((g) => g.generation_id);
  for (const [path, f] of files) {
    const hash = sha256(f.body);
    const current = status.files[path]?.sha256;
    if (current === hash) add("files", path, "ok", `sha256 ${short(hash)} is status.json's (generation ${status.generation_id})`);
    else {
      const older = generationsOf(path, hash);
      if (older.length > 0) add("files", path, "warn", `sha256 ${short(hash)} is generation ${older[0]}'s, not the current one (an edge copy still cached)`);
      else add("files", path, "fail", `sha256 ${short(hash)} is not in status.json`);
    }
  }
  for (const f of [dayFile, ...(prevDayFile ? [prevDayFile] : [])]) {
    const hash = sha256(f.body);
    const served = etagHash(f.etag);
    if (served == null) add("files", f.path, "info", `sha256 ${short(hash)}; served without an ETag`);
    else if (served === hash) add("files", f.path, "ok", `sha256 ${short(hash)} is the ETag it was served with`);
    else add("files", f.path, "fail", `sha256 ${short(hash)} is not its ETag ${short(served)}`);
  }
  const consistent = status.generations.find((g) => STATIC_FILES.every((p) => g.files[p] === sha256(files.get(p)!.body)));
  const generation = consistent?.generation_id ?? null;
  if (!consistent) add("files", "one generation", "warn", "the static files do not all belong to one listed generation; the render check may differ for that reason");

  // 2. Render again from the published rows.
  const values = valueRows(files.get("values.csv")!.body);
  const gaps = gapRows(files.get("gaps.csv")!.body);
  const revisions = revisionRows(files.get("revisions.csv")!.body);
  const model = buildModel(values, gaps, revisions);
  const hosts = recordSourceHosts(model);
  const genOf = (body: string) => (JSON.parse(body) as { generation_id: string }).generation_id;
  const rendered: Array<[string, string]> = [
    ["daily.csv", renderDailyCsv(model).body],
    ["daily.json", renderDailyJson(model, genOf(files.get("daily.json")!.body)).body],
    ["values.csv", renderValuesCsv(model).body],
    ["gaps.csv", renderGapsCsv(model).body],
    ["revisions.csv", renderRevisionsCsv(model).body],
    ["datapackage.json", renderDatapackage(hosts, genOf(files.get("datapackage.json")!.body))],
    ["methodology.json", renderMethodology(model, hosts, genOf(files.get("methodology.json")!.body))],
    [dayPath, renderDayFile(model, date, genOf(dayFile.body))],
  ];
  if (prevDayFile && DAY_FILE_RE.test(prevDayPath)) rendered.push([prevDayPath, renderDayFile(model, addDays(date, -1), genOf(prevDayFile.body))]);
  for (const [path, body] of rendered) {
    const publishedBody = path === dayPath ? dayFile.body : path === prevDayPath ? prevDayFile!.body : files.get(path)!.body;
    if (body === publishedBody) {
      add("render", path, "ok", `identical, ${Buffer.byteLength(body, "utf8")} bytes`);
    } else if (!DOCUMENTATION_FILES.has(path)) {
      add("render", path, "fail", `differs: ${firstDifference(publishedBody, body)}`);
    } else {
      const facts = documentationFactsDiffer(path, publishedBody, body);
      if (facts) add("render", path, "fail", `differs in what it states about the data: ${facts}`);
      else add("render", path, "warn", `only its prose differs (rendered by a different text version): ${firstDifference(publishedBody, body)}`);
    }
  }

  // 3. Re-derive from Scan.
  let derived: DerivedDay | null = null;
  if (opts.scan) {
    const day = JSON.parse(dayFile.body) as DayFile;
    const prevDate = addDays(date, -1);
    const prevValues = Object.fromEntries(values.filter((v) => v.date === prevDate).map((v) => [v.series, v.value]));
    const supplyOf = (d: string) => {
      const v = values.find((x) => x.date === d && x.series === "supply_cc");
      return v?.value != null && v.source_host != null ? { value: v.value, source_host: v.source_host } : null;
    };
    derived = await deriveDay({
      scan: opts.scan, date, migrationId: opts.migrationId, prevValues,
      supply: supplyOf(date), prevSupply: supplyOf(prevDate), now: opts.now, log,
    });
    add("scan", "source", "info", `${derived.host}, migration ${derived.migrationId}; ${derived.rounds.length} StartIssuing exercises located in ${derived.pages} /v2/updates pages`);
    if (derived.notFound.length > 0) add("scan", "rounds located", "fail", `no StartIssuing found for rounds ${derived.notFound.join(", ")}`);
    for (const s of SERIES_NAMES) {
      const pub = day.values[s];
      const c = derived.series[s];
      const pubText = pub?.value == null ? null : String(pub.value);
      const part: Check["part"] = INPUT_SERIES.has(s) || FROM_INPUTS.has(s) ? "supply" : "scan";
      const verb = FROM_INPUTS.has(s) ? "recomputed" : "re-derived";
      if (INPUT_SERIES.has(s)) {
        add(part, s, "info", `${pubText ?? "empty"}: taken from the published file as an input; Scan's registry serves only the current supply`);
        continue;
      }
      if (pubText == null) {
        const why = pub?.gap ? `${pub.gap.reason_code}: ${pub.gap.reason}` : "no value";
        add(part, s, "info", `published empty (${why}); ${verb} ${c.value ?? `empty (${c.gap?.reason_code})`}`);
        continue;
      }
      if (c.value == null) {
        add(part, s, "fail", `published ${pubText}; not ${verb} (${c.gap?.reason_code}: ${c.gap?.reason})`);
        continue;
      }
      const same = sameFinalValue(pubText, c.value);
      const asOfSame = pub?.as_of == null || isoZ(c.as_of) === pub.as_of;
      const held = c.hold ? `; held by a gate here: ${c.hold}` : "";
      const note = FROM_INPUTS.has(s) ? " (the published supply_cc of D minus that of D-1, not read from Scan)" : "";
      if (same && asOfSame) add(part, s, c.hold ? "warn" : "ok", `${pubText}${note}${held}`);
      else if (same) add(part, s, "fail", `${pubText}, but as_of ${isoZ(c.as_of)} here and ${pub?.as_of} published`);
      else add(part, s, "fail", `published ${pubText}, ${verb} ${c.value}${held}`);
    }
    for (const w of derived.warnings) add("scan", "note", "info", w);
  }

  const failed = checks.some((c) => c.status === "fail" || (opts.strict === true && c.status === "warn"));
  const summary = derived
    ? { migrationId: derived.migrationId, host: derived.host, prevLastRound: derived.prevLastRound, notFound: derived.notFound, pages: derived.pages, warnings: derived.warnings }
    : null;
  return { date, origin: published.origin, generation, checks, derived: summary, passed: !failed };
}
