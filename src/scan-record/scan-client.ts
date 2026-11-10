/**
 * Scan HTTP for the open record. Every call goes through the budget
 * (scan-budget.ts); the host list is a setting (runtime/scan-settings.ts, else
 * SCAN_RECORD_HOSTS: ordered, comma-separated https URLs) and every result
 * carries the host it came from, because every stored value records its
 * source.
 *
 * A list can go Super Validators first and a public Scan host last: a host
 * that refuses, fails or times out sends the call on to the next one by
 * itself, with a log line, and the value then names the host that really
 * served it, so a fallback shows in the published files and in the source
 * alarm (health.ts SCAN_SOURCE_HEALTH). On a Super Validator that goes for any
 * answer but a 200: one whose snapshots lag answers 404 for a day another holds.
 * On any other host, what it answered about the question itself ends the call.
 *
 * No inline retries: a 429 or a dropped connection opens the shared gate and
 * the next scheduled run tries again. ACS snapshots are read from
 * /v2/state/acs, and from /v0/state/acs only on a host that does not serve v2
 * (acsSnapshot): Splice 0.9.0 removes v0, and the SV operations calendar
 * (read 2026-10-05) moves the MainNet Super Validators to it on 2026-10-19.
 *
 * A 200 in the wrong shape is a failure (ScanShapeError), never an empty
 * result: a missing list read as "nothing" would publish zero as a value or
 * report the collector healthy while it collects nothing.
 */

import { scanSettings } from "../runtime/scan-settings";
import { sharedGet, sharedSet } from "../runtime/shared-cache";
import { trackApiUsage } from "../runtime/usage";
import type { AcsCreatedEvent } from "./acs";
import { parseOpenAndIssuing, type ParsedRounds, type ScanTransaction } from "./rounds";
import {
  acquireScanSlot,
  closeSvScanHost,
  hostOf,
  isSvScanHost,
  openScanGate,
  releaseScanSlot,
  ScanBusyError,
  scanSlotMaxWaitMs,
  type ScanCallClass,
} from "./scan-budget";
import { scanDial, scanForwardPorts } from "./scan-dial";

const DEFAULT_HOST = "https://api.cantonnodes.com";
/** The User-Agent of every Scan call when the settings name none; the registry reader (supply.ts) sends it too. */
export const DEFAULT_USER_AGENT = "cctools-network-record/0.1 (+https://github.com/0xScoutr/cctools-network-record)";
/** Our own limit on one call, body included. */
export const SCAN_TIMEOUT_MS = 30_000;
const TIMEOUT_MS = SCAN_TIMEOUT_MS;
const ACS_PAGE_SIZE = 1000;
const ACS_MAX_PAGES = 5;
const MIGRATION_KEY = "scan:migration-id";
const LAST_SOURCE_KEY = "scan:last-source";
/** Long enough to read between two runs; an alarm never reads a host this old as current. */
const LAST_SOURCE_MEMORY_MS = 3_600_000;

/**
 * The ACS endpoints, v2 asked first. v2 pages with an opaque string token and
 * leaves the token out on the last page (AcsResponseV2, scan.yaml at tag
 * 0.9.0); v0 pages with a whole number and is gone from Splice 0.9.0.
 */
export const ACS_ENDPOINTS = { v2: "/v2/state/acs", v0: "/v0/state/acs" } as const;
export type AcsEndpoint = (typeof ACS_ENDPOINTS)[keyof typeof ACS_ENDPOINTS];
/** How long the shared cache keeps the endpoint a host was switched to, so each read does not probe twice. */
export const ACS_ENDPOINT_MEMORY_MS = 3_600_000;
const acsEndpointKey = (host: string) => `scan:acs-endpoint:${host}`;

export class ScanHttpError extends Error {
  constructor(
    public readonly host: string,
    public readonly path: string,
    public readonly status: number,
    /** The answer's body, whole: acsEndpointAbsent reads it. */
    public readonly detail: string,
  ) {
    super(`Scan ${host}${path} answered ${status}: ${detail.slice(0, 160)}`);
    this.name = "ScanHttpError";
  }
}

/** A 200 whose body is not what the request asked for. A failure, not a throttle. */
export class ScanShapeError extends Error {
  constructor(
    public readonly host: string,
    public readonly path: string,
    detail: string,
  ) {
    super(`Scan ${host}${path} answered in an unexpected shape: ${detail}`);
    this.name = "ScanShapeError";
  }
}

/** Our own TIMEOUT_MS ran out. A failure, not a throttle: it opens no gate. */
export class ScanTimeoutError extends Error {
  constructor(
    public readonly host: string,
    public readonly path: string,
  ) {
    super(`Scan ${host}${path} did not answer within ${TIMEOUT_MS} ms`);
    this.name = "ScanTimeoutError";
  }
}

function isTimeout(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A Splice error body: {"error": "..."} (ErrorResponse, common-external.yaml at tag 0.9.0). */
function isScanErrorBody(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return isObject(parsed) && typeof parsed.error === "string";
}

/**
 * Whether an error answer means the host does not serve the ACS endpoint
 * asked, rather than that the endpoint answered: a 405 or a 501, or a 404
 * whose body is not a Splice error. A Scan says it holds no snapshot at a
 * record time with a 404 and a Splice error body, and api.cantonnodes.com
 * passes it through ({"error" : "Failed to find ACS snapshot for migration id
 * 4 at ..."}, 2026-10-06); a path it does not route gets "404 page not found"
 * in plain text (2026-10-05). A throttle, a timeout or any other 5xx is never
 * an absent endpoint: a transient error is no reason to switch.
 */
export function acsEndpointAbsent(err: unknown): err is ScanHttpError {
  if (!(err instanceof ScanHttpError)) return false;
  if (err.status === 405 || err.status === 501) return true;
  return err.status === 404 && !isScanErrorBody(err.detail);
}

/**
 * An ordered list of https Scan bases (comma-separated text, or a list),
 * checked. A Super Validator serves Scan under /api/scan and a public host such
 * as api.cantonnodes.com at its root, so a Super Validator's entry carries the
 * prefix.
 */
export function parseScanHosts(raw: string | readonly string[], setting: string): string[] {
  const list = (typeof raw === "string" ? raw.split(",") : [...raw])
    .map((h) => h.trim().replace(/\/$/, ""))
    .filter(Boolean);
  // A typo here must fail the run, not read as a host that is down.
  scanForwardPorts();
  for (const base of list) {
    // An entry is echoed with any port masked: a forward's port is the operator's (scan-dial.ts).
    const shown = base.replace(/:\d+/g, ":PORT");
    let protocol: string | null = null;
    try {
      protocol = new URL(base).protocol;
    } catch {
      protocol = null;
    }
    if (protocol !== "https:") throw new Error(`${setting} entry "${shown}" is not an https URL`);
    const url = new URL(base);
    if (isSvScanHost(url.hostname)) {
      // Without the prefix every path is a plain 404.
      if (url.pathname !== "/api/scan") throw new Error(`${setting} entry "${shown}" must end in /api/scan`);
      if (url.port !== "") throw new Error(`${setting} entry "${shown}" carries a port: a forward's port goes in SCAN_FORWARD_PORTS`);
    }
  }
  return list;
}

export function scanRecordHosts(): string[] {
  const configured = scanSettings().hosts;
  const list =
    configured !== undefined
      ? parseScanHosts(configured, "Scan host list")
      : parseScanHosts(process.env.SCAN_RECORD_HOSTS ?? "", "SCAN_RECORD_HOSTS");
  return list.length > 0 ? list : [DEFAULT_HOST];
}

export interface ScanRequestInit {
  method: "GET" | "POST";
  body?: unknown;
  cls: ScanCallClass;
  /**
   * Ask only this host (a name an earlier scanRequest returned) and report busy
   * instead of falling back: a page token is a position in one Scan's database.
   */
  host?: string;
  /**
   * Epoch ms by which the call must have ended (a run's lock expiry less a
   * margin). A call whose worst case would pass it is refused as busy (queue)
   * before it queues or dials, so a slow queue ends a run's reads instead of
   * running it past its lock.
   */
  deadline?: number;
}

/**
 * The longest one budgeted call can take, from asking for its slot to the end
 * of its answer: the budget's wait plus our timeout, which also bounds the body.
 */
export function scanCallWorstCaseMs(cls: ScanCallClass): number {
  return scanSlotMaxWaitMs(cls) + TIMEOUT_MS;
}

function basesFor(pinned: string | undefined): string[] {
  const all = scanRecordHosts();
  if (pinned === undefined) return all;
  const base = all.find((b) => hostOf(b) === pinned);
  if (base === undefined) throw new Error(`Scan host ${pinned} is not in SCAN_RECORD_HOSTS`);
  return [base];
}

/**
 * Whether another host may do better. A Super Validator's 404 is not the network's answer: its snapshots can lag by a day
 * (one's were 27 hours behind on 2026-11-06) while the next holds what was asked. On any other host a 404 or a 4xx is an
 * answer, and 501 says the host does not serve the path (acsEndpointAbsent), which is an answer about its endpoints.
 */
function isHostFailure(err: unknown, host: string): boolean {
  if (err instanceof ScanBusyError || err instanceof ScanTimeoutError || err instanceof ScanShapeError) return true;
  if (!(err instanceof ScanHttpError)) return false;
  if (isSvScanHost(host)) return true;
  return err.status === 403 || err.status === 408 || (err.status >= 500 && err.status !== 501);
}

/** Whether that failure says the host is out for everything, not only for this read. */
function isHostDown(err: unknown): boolean {
  return !(err instanceof ScanHttpError) || err.status === 403 || err.status === 408 || err.status >= 500;
}

function failureWords(err: unknown): string {
  if (err instanceof ScanHttpError) return `HTTP ${err.status}`;
  if (err instanceof ScanBusyError) return err.reason === "gate" ? "throttled or unreachable" : err.reason;
  if (err instanceof ScanTimeoutError) return "timeout";
  return "not JSON";
}

/** One call to one host, admitted by the budget. Every failure is thrown; the loop below decides what it means. */
async function askHost<T>(base: string, host: string, path: string, init: ScanRequestInit): Promise<T> {
  trackApiUsage("splice-scan", path);
  const settings = scanSettings();
  const send = settings.fetch ?? scanDial;
  let res: Response;
  try {
    res = await send(`${base}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        "User-Agent": settings.userAgent ?? DEFAULT_USER_AGENT,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeout(err)) throw new ScanTimeoutError(host, path);
    // A rate-limited public host can drop the connection instead of answering
    // 429, which Node reports as "fetch failed": treated as a 429. On a Super
    // Validator it says that host, or the forward to it, is down.
    if (!isSvScanHost(host)) openScanGate(host, "30");
    throw new ScanBusyError(host, "gate");
  }
  if (res.status === 429) {
    openScanGate(host, res.headers.get("retry-after"));
    // Release the unread body so the socket goes back to the pool now.
    await res.body?.cancel().catch(() => undefined);
    throw new ScanBusyError(host, "gate");
  }
  if (!res.ok) {
    throw new ScanHttpError(host, path, res.status, await res.text().catch(() => ""));
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isTimeout(err)) throw new ScanTimeoutError(host, path);
    throw new ScanShapeError(host, path, "the body is not JSON");
  }
}

/** The host that answered the record's last Scan read, for the source alarm; null when none did lately. */
export function lastScanSource(): { host: string; at: string } | null {
  return sharedGet<{ host: string; at: string }>(LAST_SOURCE_KEY);
}

export async function scanRequest<T>(path: string, init: ScanRequestInit): Promise<{ host: string; body: T }> {
  const bases = basesFor(init.host);
  let lastError: unknown = null;
  for (let i = 0; i < bases.length; i++) {
    const host = hostOf(bases[i]);
    const next = bases[i + 1] === undefined ? null : hostOf(bases[i + 1]);
    if (init.deadline !== undefined && Date.now() + scanCallWorstCaseMs(init.cls) > init.deadline) {
      throw new ScanBusyError(host, "queue");
    }
    try {
      await acquireScanSlot(host, init.cls);
    } catch (err) {
      lastError = err;
      if (next !== null) console.warn(`[scan-record] ${host} did not serve ${path} (${failureWords(err)}); asking ${next}`);
      continue;
    }
    try {
      const body = await askHost<T>(bases[i], host, path, init);
      if (bases.length > 1 || isSvScanHost(host)) sharedSet(LAST_SOURCE_KEY, { host, at: new Date().toISOString() }, LAST_SOURCE_MEMORY_MS);
      return { host, body };
    } catch (err) {
      if (!isHostFailure(err, host)) throw err;
      // A 429 also closed every other Super Validator (openScanGate); any other failure closes this one alone.
      if (isSvScanHost(host) && isHostDown(err)) closeSvScanHost(host);
      lastError = err;
      if (next !== null) console.warn(`[scan-record] ${host} did not serve ${path} (${failureWords(err)}); asking ${next}`);
    } finally {
      releaseScanSlot(host);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`no Scan host answered ${path}`);
}

/**
 * The Scan reads the collector and backfill need, as one mockable surface.
 * Every `deadline` is ScanRequestInit.deadline: a call whose worst case would
 * pass it is refused as busy (queue) before it queues or dials, and checked
 * again before a fallback host, so no call of a run outlives the run's lock.
 */
export interface ScanApi {
  /**
   * The budget class every call is made in. A caller that plans several calls
   * against one deadline sizes its plan with it (snapshotCoreHeadroomMs), since
   * each call is held to this class's worst case (scanCallWorstCaseMs).
   */
  readonly cls: ScanCallClass;
  migrationId(deadline?: number): Promise<number>;
  openAndIssuing(deadline?: number): Promise<{ host: string; rounds: ParsedRounds }>;
  updatesAfter(
    migrationId: number,
    afterRecordTime: string,
    pageSize: number,
    deadline?: number,
  ): Promise<{ host: string; transactions: ScanTransaction[] }>;
  /**
   * `host` asks only that host (one an earlier call returned) from the first
   * page on, and reports busy instead of falling back: the templates of one
   * snapshot must all come from the Scan the row names as its source.
   * `deadline` (ScanRequestInit.deadline) is checked before every page.
   * `endpoint` is the ACS endpoint that answered every page of the read.
   */
  acsSnapshot(
    migrationId: number,
    recordTime: string,
    template: string,
    host?: string,
    deadline?: number,
  ): Promise<{ host: string; endpoint: AcsEndpoint; events: AcsCreatedEvent[] }>;
}

interface AcsPage {
  record_time?: unknown;
  migration_id?: unknown;
  created_events?: unknown;
  next_page_token?: unknown;
}

type AcsRequest = { migration_id: number; record_time: string; page_size: number; templates: string[] };
type AcsSource = { host: string; endpoint: AcsEndpoint };
type AcsAnswer = AcsSource & { body: AcsPage | null };

/** The endpoint a host was last switched to (ACS_ENDPOINT_MEMORY_MS), else v2. */
function keptEndpoint(host: string): AcsEndpoint {
  return sharedGet<string>(acsEndpointKey(host)) === ACS_ENDPOINTS.v0 ? ACS_ENDPOINTS.v0 : ACS_ENDPOINTS.v2;
}

/**
 * The first page of an ACS read, and the endpoint that answered it. The host
 * asked first (the caller's, else the head of SCAN_RECORD_HOSTS) is asked the
 * endpoint it was last switched to, else v2; a fallback to the next host in
 * the list asks the same one. When that endpoint is not served there
 * (acsEndpointAbsent), the same host is asked the other endpoint once, under
 * the same deadline. The switch is stored before that call, in the shared
 * cache that every worker reads, so a call the deadline refuses still
 * spares the next run the probe. Any other failure is the read's own.
 */
async function firstAcsPage(
  cls: ScanCallClass,
  request: AcsRequest,
  onlyHost: string | undefined,
  deadline: number | undefined,
): Promise<AcsAnswer> {
  const endpoint = keptEndpoint(onlyHost ?? hostOf(scanRecordHosts()[0]));
  try {
    const { host, body } = await scanRequest<AcsPage | null>(endpoint, { method: "POST", cls, host: onlyHost, deadline, body: request });
    return { host, endpoint, body };
  } catch (err) {
    if (!acsEndpointAbsent(err)) throw err;
    const other = endpoint === ACS_ENDPOINTS.v2 ? ACS_ENDPOINTS.v0 : ACS_ENDPOINTS.v2;
    sharedSet(acsEndpointKey(err.host), other, ACS_ENDPOINT_MEMORY_MS);
    console.warn(`[scan-record] ${err.host} does not serve ${endpoint} (${err.status}); asking ${other} there`);
    const { host, body } = await scanRequest<AcsPage | null>(other, { method: "POST", cls, host: err.host, deadline, body: request });
    return { host, endpoint: other, body };
  }
}

/** A later page of an ACS read: only on the host and the endpoint of the first page. */
async function laterAcsPage(
  cls: ScanCallClass,
  request: AcsRequest,
  source: AcsSource,
  after: string | number,
  deadline: number | undefined,
): Promise<AcsAnswer> {
  const { body } = await scanRequest<AcsPage | null>(source.endpoint, {
    method: "POST",
    cls,
    host: source.host,
    deadline,
    body: { ...request, after },
  });
  return { ...source, body };
}

/**
 * The token of the next page, or null after the last one. v0 sends a whole
 * number and an explicit null at the end (api.cantonnodes.com, probe of
 * 2026-09-25), so a missing key there could be a renamed field and is refused.
 * v2 sends an opaque string and leaves the key out at the end; an explicit
 * null or an empty string, which no next page could be asked with, is read
 * as the end too (the caller refuses it on a full page).
 */
function nextPageToken(token: unknown, endpoint: AcsEndpoint, shape: (detail: string) => ScanShapeError): string | number | null {
  if (endpoint === ACS_ENDPOINTS.v0) {
    if (token === undefined) throw shape("next_page_token is absent");
    if (token !== null && (typeof token !== "number" || !Number.isSafeInteger(token))) {
      throw shape(`next_page_token ${JSON.stringify(token)} is not a whole number`);
    }
    return token;
  }
  if (token === undefined || token === null || token === "") return null;
  if (typeof token !== "string") throw shape(`next_page_token ${JSON.stringify(token)} is not a page token`);
  return token;
}

export function liveScanApi(cls: ScanCallClass): ScanApi {
  return {
    cls,
    async migrationId(deadline) {
      const cached = sharedGet<number>(MIGRATION_KEY);
      if (typeof cached === "number") return cached;
      // Splice's getMigrationId (scan.yaml); api.cantonnodes.com answered
      // {"migration_id":4} to the read-only probe of 2026-09-25.
      const path = "/v0/migrations/last";
      const { host, body } = await scanRequest<{ migration_id?: unknown } | null>(path, { method: "GET", cls, deadline });
      const id = body?.migration_id;
      // Number(null) and Number("") are 0: only a JSON whole number is an id.
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
        throw new ScanShapeError(host, path, `migration_id ${JSON.stringify(id)} is not a whole number`);
      }
      sharedSet(MIGRATION_KEY, id, 3_600_000);
      return id;
    },

    async openAndIssuing(deadline) {
      const path = "/v0/open-and-issuing-mining-rounds";
      const { host, body } = await scanRequest<{ open_mining_rounds?: unknown; issuing_mining_rounds?: unknown } | null>(
        path,
        {
          method: "POST",
          cls,
          deadline,
          body: { cached_open_mining_round_contract_ids: [], cached_issuing_round_contract_ids: [] },
        },
      );
      if (!isObject(body?.open_mining_rounds) || !isObject(body?.issuing_mining_rounds)) {
        throw new ScanShapeError(host, path, "open_mining_rounds or issuing_mining_rounds is not an object");
      }
      return { host, rounds: parseOpenAndIssuing(body) };
    },

    async updatesAfter(migrationId, afterRecordTime, pageSize, deadline) {
      const path = "/v2/updates";
      const { host, body } = await scanRequest<{ transactions?: unknown } | null>(path, {
        method: "POST",
        cls,
        deadline,
        body: { page_size: pageSize, after: { after_migration_id: migrationId, after_record_time: afterRecordTime } },
      });
      // A missing list is not "nothing new": the collector would report ok while collecting nothing.
      if (!Array.isArray(body?.transactions)) throw new ScanShapeError(host, path, "transactions is not an array");
      return { host, transactions: body.transactions as ScanTransaction[] };
    },

    async acsSnapshot(migrationId, recordTime, template, onlyHost, deadline) {
      const wantTime = Date.parse(recordTime);
      if (!Number.isFinite(wantTime)) throw new Error(`ACS record time ${recordTime} is not a timestamp`);
      // No record_time_match: "exact" (the default) at the time asked, checked again on every answer below.
      const request: AcsRequest = { migration_id: migrationId, record_time: recordTime, page_size: ACS_PAGE_SIZE, templates: [template] };
      const events: AcsCreatedEvent[] = [];
      // Every page after the first goes to the host and the endpoint that
      // answered the first (and reports busy there rather than falling back):
      // the `after` token is a position in that Scan's answer to that endpoint
      // (a row number on v0, opaque on v2), meaningless on another. A caller's
      // `onlyHost` pins the first page too.
      let pinned: AcsSource | null = null;
      let after: string | number | null = null;
      for (let page = 0; page < ACS_MAX_PAGES; page++) {
        const answer: AcsAnswer =
          pinned === null || after === null
            ? await firstAcsPage(cls, request, onlyHost, deadline)
            : await laterAcsPage(cls, request, pinned, after, deadline);
        const { host, endpoint } = answer;
        pinned = { host, endpoint };
        const shape = (detail: string) => new ScanShapeError(host, endpoint, `${detail} (${template} at ${recordTime})`);
        const body = answer.body ?? {};
        if (!Array.isArray(body.created_events)) throw shape("created_events is not an array");
        if (body.migration_id !== migrationId) {
          throw shape(`migration_id ${JSON.stringify(body.migration_id)} is not the ${migrationId} asked for`);
        }
        if (typeof body.record_time !== "string" || Date.parse(body.record_time) !== wantTime) {
          throw shape(`record_time ${JSON.stringify(body.record_time)} is not the one asked for`);
        }
        const token = nextPageToken(body.next_page_token, endpoint, shape);
        // Reading a full page without a token as the end would cut the count short without an error.
        if (token === null && body.created_events.length >= ACS_PAGE_SIZE) {
          throw shape(`a full page of ${body.created_events.length} events carried no next_page_token`);
        }
        events.push(...(body.created_events as AcsCreatedEvent[]));
        if (token === null) {
          const shortName = template.slice(template.lastIndexOf(":") + 1);
          console.info(`[scan-record] ACS ${shortName} at ${recordTime}: ${events.length} contracts from ${host}${endpoint}`);
          return { host, endpoint, events };
        }
        after = token;
      }
      throw new Error(`ACS for ${template} at ${recordTime} ran past ${ACS_MAX_PAGES} pages`);
    },
  };
}
