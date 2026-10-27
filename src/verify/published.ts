/**
 * The published files a verification reads, from the live keyless URLs or
 * from a recorded directory, and their rows as the renderer takes them.
 *
 * A recorded directory holds each file at its published path under
 * `published/`, byte for byte, and `published/headers.json` with the ETag and
 * X-Record-Generation each one was served with.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  OPEN_BASE_URL,
  SERIES_NAMES,
  type GapRow,
  type RecordMethod,
  type RevisionRow,
  type SeriesName,
  type ValueRow,
} from "../open-record/contract";
import { parseCsv } from "./csv";

export interface PublishedFile {
  path: string;
  body: string;
  etag: string | null;
  generation: string | null;
}

export interface PublishedSource {
  /** Where the files come from, for the report. */
  readonly origin: string;
  get(path: string): Promise<PublishedFile | null>;
}

const USER_AGENT = "cctools-network-record-verify/0.1";

export function httpPublished(baseUrl: string = OPEN_BASE_URL, send: typeof fetch = fetch): PublishedSource {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return {
    origin: base,
    async get(path) {
      const res = await send(`${base}${path}`, { headers: { Accept: "*/*", "User-Agent": USER_AGENT } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${base}${path} answered ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        path,
        body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        etag: res.headers.get("etag"),
        generation: res.headers.get("x-record-generation"),
      };
    },
  };
}

type Headers = Record<string, { etag: string | null; generation: string | null }>;

export function dirPublished(dir: string): PublishedSource {
  let headers: Headers | null = null;
  return {
    origin: dir,
    async get(path) {
      headers ??= JSON.parse(await readFile(join(dir, "published", "headers.json"), "utf-8")) as Headers;
      let body: string;
      try {
        body = await readFile(join(dir, "published", path), "utf-8");
      } catch (err) {
        if ((err as { code?: unknown })?.code === "ENOENT") return null;
        throw err;
      }
      const h = headers[path] ?? { etag: null, generation: null };
      return { path, body, etag: h.etag, generation: h.generation };
    },
  };
}

/** Wraps a source so every file it returns is also written under `dir`, for a later offline run. */
export function recordingPublished(source: PublishedSource, dir: string): PublishedSource & { save(): Promise<void> } {
  const headers: Headers = {};
  return {
    origin: source.origin,
    async get(path) {
      const file = await source.get(path);
      if (file) {
        const out = join(dir, "published", path);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, file.body, "utf-8");
        headers[path] = { etag: file.etag, generation: file.generation };
      }
      return file;
    },
    async save() {
      await mkdir(join(dir, "published"), { recursive: true });
      await writeFile(join(dir, "published", "headers.json"), `${JSON.stringify(headers, null, 2)}\n`, "utf-8");
    },
  };
}

const orNull = (cell: string | undefined) => (cell == null || cell === "" ? null : cell);

function isSeries(name: string): name is SeriesName {
  return (SERIES_NAMES as readonly string[]).includes(name);
}

/**
 * values.csv as stored rows. A published value is the stored numeric in its
 * published form (a count as an integer, an amount with 10 places), which the
 * renderer prints back unchanged. retrieved_at and finalized_at are not
 * published and not rendered; revision counts come from revisions.csv.
 */
export function valueRows(csv: string): ValueRow[] {
  return parseCsv(csv).map((r) => {
    if (!isSeries(r.series)) throw new Error(`values.csv names an unknown series ${r.series}`);
    return {
      date: r.date,
      series: r.series,
      value: orNull(r.value),
      status: r.status as ValueRow["status"],
      source_host: orNull(r.source_host),
      method: r.method as RecordMethod,
      as_of: orNull(r.as_of),
      retrieved_at: orNull(r.as_of) ?? `${r.date}T00:00:00Z`,
      finalized_at: null,
      revision: Number(r.revision),
      revised_at: orNull(r.revised_at),
    };
  });
}

export function gapRows(csv: string): GapRow[] {
  return parseCsv(csv).map((r) => ({
    date: r.date,
    series: r.series as GapRow["series"],
    reason_code: r.reason_code as GapRow["reason_code"],
    reason: r.reason,
    status: r.status as GapRow["status"],
    detected_at: r.detected_at,
    resolved_at: orNull(r.resolved_at),
    evidence_url: orNull(r.evidence_url),
  }));
}

export function revisionRows(csv: string): RevisionRow[] {
  return parseCsv(csv).map((r) => ({
    date: r.date,
    series: r.series as SeriesName,
    old_value: orNull(r.old_value),
    new_value: orNull(r.new_value),
    kind: r.kind as RevisionRow["kind"],
    reason: r.reason,
    method: r.method,
    revised_at: r.revised_at,
  }));
}
