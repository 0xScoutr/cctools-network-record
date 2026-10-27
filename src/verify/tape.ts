/**
 * The Scan side of a verification, as fetch implementations for the Scan
 * client (runtime/scan-settings.ts):
 *
 *   pacedFetch      the live one: request starts spaced apart, and a 429 or
 *                   a dropped connection waited out and retried, because a
 *                   public Scan host rate limits per client IP.
 *   recordingFetch  wraps another fetch and keeps every answer on a tape.
 *   replayFetch     answers from a tape, for the offline run: the same Scan
 *                   client code runs on the same answers, with no network.
 *
 * A tape keeps what the day's derivation reads, and states what it left out:
 *   - an ACS page of DsoRules, OpenMiningRound or IssuingMiningRound as served;
 *   - an ACS page of FeaturedAppRight or ValidatorLicense, which the record
 *     only counts, with every event reduced to its contract id, template,
 *     package and creation time, and its create_arguments emptied. The
 *     arguments, signatories and observers name validator and app operators
 *     and, for ValidatorLicense, the contact e-mail address each validator
 *     gave; a tape is published in a repository, so it carries none of them.
 *     The entry records the event count and the sha256 of the page as served,
 *     re-serialized as compact JSON (`json_sha256`);
 *   - an /v2/updates page with every transaction that holds an
 *     AmuletRules_MiningRound_StartIssuing exercise, unmodified, and its last
 *     transaction reduced to its update_id, migration_id and record_time (the
 *     StartIssuing the walk looks for, and where the page ends). The entry
 *     records how many transactions the page had and the sha256 of the body
 *     as served.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { SCAN_TIMEOUT_MS } from "../scan-record/scan-client";

export interface TapeEntry {
  method: string;
  url: string;
  request: unknown;
  status: number;
  response: unknown;
  /** Present on a reduced /v2/updates page. */
  reduced?: { transactions: number; kept: number; sha256: string };
  /** Present on an ACS page whose events' create_arguments were emptied. */
  arguments_dropped?: { events: number; json_sha256: string };
}

/** Templates the record only counts: their events' arguments are not kept on a tape. */
const COUNTED_ONLY = ["Splice.Amulet:FeaturedAppRight", "Splice.ValidatorLicense:ValidatorLicense"];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * The default least time between two request starts: about the rate
 * api.cantonnodes.com sustained for one client while fixtures/verify/2026-10-25
 * was recorded (215 requests in 76 minutes, about 2.8 a minute, most of the
 * time beyond the 6.5 s spacing then used spent waiting out 429s). Measured on
 * that run; the host publishes no limit. At this spacing a day of about 215
 * requests takes at least 72 minutes, about what the throttled run took, and
 * asks the host's free tier for nothing it refuses.
 */
export const DEFAULT_SPACING_MS = 20_000;

export interface PacedFetchOptions {
  /** Least time between two request starts; DEFAULT_SPACING_MS when absent. */
  spacingMs?: number;
  /** Retries after a 429 or a dropped connection. */
  retries: number;
  /** Wait before a retry when the host names no Retry-After. */
  backoffMs: number;
  send?: typeof fetch;
  log?: (line: string) => void;
}

/** A fetch that spaces its starts and waits out throttles. Each attempt gets its own timeout. */
export function pacedFetch(opts: PacedFetchOptions): typeof fetch {
  const spacingMs = opts.spacingMs ?? DEFAULT_SPACING_MS;
  let nextStart = 0;
  const send = opts.send ?? ((input, init) => fetch(input, init));
  return (async (input: string | URL | Request, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      const wait = nextStart - Date.now();
      if (wait > 0) await sleep(wait);
      nextStart = Date.now() + spacingMs;
      let res: Response;
      try {
        res = await send(input, { ...init, signal: AbortSignal.timeout(SCAN_TIMEOUT_MS) });
      } catch (err) {
        if (isAbort(err) || attempt >= opts.retries) throw err;
        opts.log?.(`connection dropped (${err instanceof Error ? err.message : String(err)}); retrying in ${opts.backoffMs / 1000} s`);
        nextStart = Date.now() + opts.backoffMs;
        continue;
      }
      if (res.status !== 429 || attempt >= opts.retries) return res;
      const seconds = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : opts.backoffMs;
      await res.body?.cancel().catch(() => undefined);
      opts.log?.(`429 from Scan; retrying in ${Math.round(waitMs / 1000)} s`);
      nextStart = Date.now() + waitMs;
    }
  }) as typeof fetch;
}

const START_ISSUING = "AmuletRules_MiningRound_StartIssuing";

interface TxLike {
  update_id?: unknown;
  migration_id?: unknown;
  record_time?: unknown;
  events_by_id?: Record<string, { choice?: unknown }>;
}

function holdsStartIssuing(tx: TxLike): boolean {
  return Object.values(tx.events_by_id ?? {}).some((e) => e?.choice === START_ISSUING);
}

/** The page as the tape keeps it (see the header), and what was reduced. */
export function reduceUpdatesPage(body: string): { response: unknown; reduced: NonNullable<TapeEntry["reduced"]> } | null {
  let parsed: { transactions?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.transactions)) return null;
  const txs = parsed.transactions as TxLike[];
  const kept: TxLike[] = txs.filter(holdsStartIssuing);
  const last = txs[txs.length - 1];
  if (last && !holdsStartIssuing(last)) {
    kept.push({ update_id: last.update_id, migration_id: last.migration_id, record_time: last.record_time, events_by_id: {} });
  }
  return {
    response: { ...parsed, transactions: kept },
    reduced: { transactions: txs.length, kept: kept.length, sha256: sha256(body) },
  };
}

/** What a counted-only event keeps: its identity and template, never a party or an argument. */
function countedOnly(e: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = { contract_id: e.contract_id, template_id: e.template_id };
  if (e.created_at !== undefined) kept.created_at = e.created_at;
  if (e.package_name !== undefined) kept.package_name = e.package_name;
  kept.create_arguments = {};
  return kept;
}

/** An ACS page of a counted-only template with its events reduced to their identity (see the header), or null. */
export function reduceAcsPage(request: unknown, response: unknown): { response: unknown; dropped: NonNullable<TapeEntry["arguments_dropped"]> } | null {
  const templates = (request as { templates?: unknown } | null)?.templates;
  const template = Array.isArray(templates) && typeof templates[0] === "string" ? templates[0] : "";
  if (!COUNTED_ONLY.some((t) => template.endsWith(t))) return null;
  const page = response as { created_events?: unknown } | null;
  if (!page || !Array.isArray(page.created_events)) return null;
  const events = page.created_events as Array<Record<string, unknown>>;
  return {
    response: { ...page, created_events: events.map(countedOnly) },
    dropped: { events: events.length, json_sha256: sha256(JSON.stringify(response)) },
  };
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

export function recordingFetch(inner: typeof fetch, tape: TapeEntry[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    const text = await res.text();
    const url = urlOf(input);
    const entry: TapeEntry = { method: init?.method ?? "GET", url, request: requestBody(init), status: res.status, response: text };
    const reduced = res.ok && new URL(url).pathname.endsWith("/v2/updates") ? reduceUpdatesPage(text) : null;
    if (reduced) {
      entry.response = reduced.response;
      entry.reduced = reduced.reduced;
    } else {
      try {
        entry.response = JSON.parse(text);
      } catch {
        entry.response = text;
      }
      const acs = res.ok && /\/state\/acs$/.test(new URL(url).pathname) ? reduceAcsPage(entry.request, entry.response) : null;
      if (acs) {
        entry.response = acs.response;
        entry.arguments_dropped = acs.dropped;
      }
    }
    tape.push(entry);
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** JSON with object keys sorted, so two equal request bodies give the same key. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const keyOf = (method: string, url: string, request: unknown) => `${method} ${url} ${canonical(request)}`;

/** Answers every request from the tape, in recorded order for repeated requests; anything else fails the run. */
export function replayFetch(tape: readonly TapeEntry[]): typeof fetch & { unused(): number } {
  const queues = new Map<string, TapeEntry[]>();
  for (const e of tape) {
    const key = keyOf(e.method, e.url, e.request);
    queues.set(key, [...(queues.get(key) ?? []), e]);
  }
  const replay = (async (input: string | URL | Request, init?: RequestInit) => {
    const key = keyOf(init?.method ?? "GET", urlOf(input), requestBody(init));
    const entry = queues.get(key)?.shift();
    if (!entry) throw new Error(`the tape has no answer for ${init?.method ?? "GET"} ${urlOf(input)} ${canonical(requestBody(init))}`);
    const text = typeof entry.response === "string" ? entry.response : JSON.stringify(entry.response);
    return new Response(text, { status: entry.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { unused(): number };
  replay.unused = () => [...queues.values()].reduce((n, q) => n + q.length, 0);
  return replay;
}

export async function writeTape(path: string, tape: readonly TapeEntry[]): Promise<void> {
  await writeFile(path, tape.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

export async function readTape(path: string): Promise<TapeEntry[]> {
  const text = await readFile(path, "utf-8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TapeEntry);
}
