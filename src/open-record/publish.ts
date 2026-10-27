/**
 * Render the open files into the file cache (FileCache).
 *
 * A generation is one render that changed at least one file. A file whose
 * content (rendered without a generation id) is unchanged keeps its stored
 * body and generation, so each render writes only what changed and every
 * JSON file carries the generation that produced it; CSVs carry it in the
 * X-Record-Generation header. The manifest is written last and lists the
 * last 24 generations with each main file's sha256, so an outside client can
 * tell which generation an edge-cached file belongs to.
 */

import {
  SCHEMA_VERSION,
  STATIC_FILES,
  dayFilePath,
  type GapRow,
  type Manifest,
  type ManifestFile,
  type RevisionRow,
  type StoredFile,
  type ValueRow,
} from "./contract";
import { renderDatapackage } from "./datapackage";
import { dayNotes, renderDayFile } from "./day-file";
import { renderMethodology } from "./methodology";
import {
  buildModel,
  dayStatus,
  isoZ,
  recordSourceHosts,
  renderDailyCsv,
  renderDailyJson,
  renderGapsCsv,
  renderRevisionsCsv,
  renderValuesCsv,
  sha256Hex,
  type RecordModel,
  type Rendered,
} from "./render";

export interface RecordReader {
  values(): Promise<ValueRow[]>;
  gaps(): Promise<GapRow[]>;
  revisions(): Promise<RevisionRow[]>;
  dirtyAt(): Promise<string | null>;
}

export interface FileCache {
  manifest(): Promise<{ status: "hit"; value: Manifest } | { status: "miss" } | { status: "error" }>;
  putFiles(files: StoredFile[]): Promise<void>;
  putManifest(manifest: Manifest): Promise<void>;
}

export interface PublishResult {
  ok: boolean;
  skipped?: "clean";
  generation_id: string | null;
  changed: string[];
  files: number;
  latest_final_date: string | null;
  error?: string;
}

const CSV = "text/csv; charset=utf-8; header=present";
const JSON_TYPE = "application/json; charset=utf-8";
const RERENDER_MS = 24 * 3_600_000;
const GENERATIONS_KEPT = 24;

export function generationIdFor(now: Date): string {
  return `g${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

interface Candidate {
  path: string;
  content_type: string;
  rows: number | null;
  render: (generationId: string) => string;
}

export function buildFileSet(model: RecordModel, sourceHosts: string[]): Candidate[] {
  const csv = (path: string, rendered: Rendered): Candidate => ({
    path, content_type: CSV, rows: rendered.rows, render: () => rendered.body,
  });
  const json = (path: string, rows: number | null, render: (g: string) => string): Candidate => ({
    path, content_type: JSON_TYPE, rows, render,
  });
  return [
    csv("daily.csv", renderDailyCsv(model)),
    json("daily.json", model.dates.length, (g) => renderDailyJson(model, g).body),
    csv("values.csv", renderValuesCsv(model)),
    csv("gaps.csv", renderGapsCsv(model)),
    csv("revisions.csv", renderRevisionsCsv(model)),
    json("datapackage.json", null, (g) => renderDatapackage(sourceHosts, g)),
    json("methodology.json", null, (g) => renderMethodology(model, sourceHosts, g)),
    ...model.dates.map((d) => json(dayFilePath(d), null, (g) => renderDayFile(model, d, g))),
  ];
}

const failed = (error: string): PublishResult => ({
  ok: false, generation_id: null, changed: [], files: 0, latest_final_date: null, error,
});

export async function publishRecord(deps: {
  reader: RecordReader;
  cache: FileCache;
  now: Date;
  force?: boolean;
}): Promise<PublishResult> {
  const prior = await deps.cache.manifest();
  if (prior.status === "error") return failed("manifest unreadable; nothing overwritten");
  const before = prior.status === "hit" ? prior.value : null;
  // Read before the rows: a dirty mark set while this run reads is newer than
  // the one recorded below, so the next run renders again.
  const dirtyAt = await deps.reader.dirtyAt();
  const renderedAgo = before ? deps.now.getTime() - Date.parse(before.rendered_at) : Infinity;
  if (!deps.force && before && before.dirty_at_rendered === dirtyAt && renderedAgo < RERENDER_MS) {
    return {
      ok: true, skipped: "clean", generation_id: before.generation_id, changed: [],
      files: Object.keys(before.files).length, latest_final_date: before.latest_final_date,
    };
  }

  const [values, gaps, revisions] = await Promise.all([deps.reader.values(), deps.reader.gaps(), deps.reader.revisions()]);
  const model = buildModel(values, gaps, revisions);
  if (model.dates.length === 0) return failed("no values to publish");
  // The hosts daily.json names: only those behind a published value, in range.
  const sourceHosts = recordSourceHosts(model);

  const nowIso = isoZ(deps.now.toISOString()) as string;
  const generationId = generationIdFor(deps.now);
  const files: Record<string, ManifestFile> = {};
  const changed: StoredFile[] = [];
  for (const c of buildFileSet(model, sourceHosts)) {
    const contentSha = sha256Hex(c.render(""));
    const previous = before?.files[c.path];
    if (previous && previous.content_sha256 === contentSha) {
      files[c.path] = previous;
      continue;
    }
    const body = c.render(generationId);
    const file: StoredFile = {
      path: c.path, body, content_type: c.content_type, sha256: sha256Hex(body), content_sha256: contentSha,
      generation_id: generationId, rows: c.rows,
    };
    changed.push(file);
    files[c.path] = { sha256: file.sha256, content_sha256: contentSha, bytes: Buffer.byteLength(body, "utf8"), rows: c.rows, generation_id: generationId };
  }

  const isNew = changed.length > 0 || !before;
  const lastDate = model.dates[model.dates.length - 1];
  const latestFinal = [...model.dates].reverse().find((d) => dayStatus(model, d) === "final") ?? null;
  const generation = isNew ? generationId : (before as Manifest).generation_id;
  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    generation_id: generation,
    generated_at: isNew ? nowIso : (before as Manifest).generated_at,
    rendered_at: nowIso,
    dirty_at_rendered: dirtyAt,
    first_date: model.dates[0],
    last_date: lastDate,
    latest_final_date: latestFinal,
    latest_provisional_date: dayStatus(model, lastDate) === "final" ? null : lastDate,
    source_hosts: sourceHosts,
    files,
    generations: isNew
      ? [
          { generation_id: generation, generated_at: nowIso, files: Object.fromEntries(STATIC_FILES.map((p) => [p, files[p].sha256])) },
          ...(before?.generations ?? []),
        ].slice(0, GENERATIONS_KEPT)
      : (before as Manifest).generations,
    warnings: model.dates.slice(-30).flatMap((d) => dayNotes(model, d).map((note) => ({ date: d, note }))),
  };

  if (changed.length > 0) await deps.cache.putFiles(changed);
  await deps.cache.putManifest(manifest);
  return { ok: true, generation_id: generation, changed: changed.map((f) => f.path), files: Object.keys(files).length, latest_final_date: latestFinal };
}
