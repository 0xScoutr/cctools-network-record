/**
 * The supply collector: reads Canton Coin's total supply from Scan's token
 * registry (`GET {registry}/instruments`, splice-api-token-metadata-v1) and
 * stores each reading once per instant through a SupplyWriter, which is what
 * getSupplyAt reads back (src/adapters/postgres-store.ts writes and reads
 * network_record_supply, sql/supply.sql).
 *
 * The record uses only the reading whose totalSupplyAsOf is exactly
 * D+1 00:00:00Z (day-values.ts). The registry serves only its current
 * reading, so that one has to be read while it is current: the CCTools
 * deployment runs this every 15 minutes. A past day's supply cannot be read
 * again.
 *
 * Ported from the CCTools deployment's registry reader and the Canton Coin
 * part of its supply job, with the same requests, retries, budget marks,
 * failure rules and health latch. The seams: the fetch and User-Agent come
 * from runtime/scan-settings.ts; the registry base defaults to the first Scan
 * host's /registry/metadata/v1 instead of a row of the deployment's asset
 * table; a reading is stored through SupplyWriter instead of the deployment's
 * asset tables, and a failed read is reported to the health latch and the
 * result, not to a per-asset failure counter.
 *
 * Three things the registry does that this code relies on knowing:
 *   1. Only `/instruments` returning a non-empty list proves a registry is
 *      there; an empty list with a 200 is reported as a failure, never as
 *      "no tokens".
 *   2. Reporting a supply is optional (CIP-0056): an instrument without
 *      totalSupply or totalSupplyAsOf is not a failure, and nothing is stored.
 *   3. The host is load balanced and replicas can answer with an older
 *      totalSupplyAsOf: every distinct instant is stored once, and a reading
 *      already stored is not an error.
 */

import { checkFeedHealth, type FeedHealthConfig, type FeedOutcome } from "../runtime/feed-health";
import { scanSettings } from "../runtime/scan-settings";
import { hostOf, markScanCall, openScanGate } from "./scan-budget";
import { DEFAULT_USER_AGENT, scanRecordHosts } from "./scan-client";

/** Canton Coin's instrument id in Scan's registry. */
export const CC_INSTRUMENT_ID = "Amulet";

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The registry hosts rate-limit hard and inconsistently: one probe was refused
 * after three requests in twelve seconds, another served eight in a row. Pace
 * defensively and back off steeply rather than tuning for the good case.
 */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

export const SUPPLY_HEALTH: FeedHealthConfig = {
  stateKey: "feed-health:network-record-supply",
  cacheSource: "network-record-supply",
  // Four consecutive failures at 15-minute spacing is an hour of silence,
  // which is long enough to be real and short enough to still matter.
  failThreshold: 4,
  downWindow: "~1h",
  downTitle: "Asset supply feed degraded",
  recoveredTitle: "Asset supply feed recovered",
};

export interface RegistryInstrument {
  id: string;
  name: string;
  symbol: string;
  /** Decimal string. Kept as a string all the way to Postgres numeric. */
  totalSupply: string | null;
  /** The registry's own timestamp for that figure. */
  totalSupplyAsOf: string | null;
  decimals: number | null;
  paused: boolean | null;
}

export interface RegistryFetchResult {
  ok: boolean;
  instruments: RegistryInstrument[];
  status: number | null;
  error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalise(raw: unknown): RegistryInstrument | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof r.name === "string" ? r.name : id,
    symbol: typeof r.symbol === "string" ? r.symbol : id,
    totalSupply: typeof r.totalSupply === "string" ? r.totalSupply : null,
    totalSupplyAsOf: typeof r.totalSupplyAsOf === "string" ? r.totalSupplyAsOf : null,
    decimals: typeof r.decimals === "number" ? r.decimals : null,
    paused: typeof r.paused === "boolean" ? r.paused : null,
  };
}

/**
 * Every instrument a registry issues, in one request.
 *
 * Never throws: the failure comes back as data, so the caller can report it
 * against the instrument it was reading.
 */
export async function fetchRegistryInstruments(registryBaseUrl: string): Promise<RegistryFetchResult> {
  const url = `${registryBaseUrl.replace(/\/$/, "")}/instruments`;
  const host = hostOf(url);
  const settings = scanSettings();
  const send = settings.fetch ?? fetch;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let status: number | null = null;
    try {
      markScanCall(host, "cron");
      const res = await send(url, {
        headers: { Accept: "application/json", "User-Agent": settings.userAgent ?? DEFAULT_USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;

      if (res.status === 429) openScanGate(host, res.headers?.get?.("retry-after") ?? null);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return { ok: false, instruments: [], status, error: `HTTP ${status}` };
      }

      if (!res.ok) {
        return { ok: false, instruments: [], status, error: `HTTP ${status}` };
      }

      const body = (await res.json()) as { instruments?: unknown };
      const list = Array.isArray(body.instruments) ? body.instruments : [];
      const instruments = list.map(normalise).filter((i): i is RegistryInstrument => i !== null);

      // An empty list is reported as a failure rather than as "this issuer has
      // no tokens": in practice it means a wrong registry path or a registry
      // that moved.
      if (instruments.length === 0) {
        return {
          ok: false,
          instruments: [],
          status,
          error: "registry returned no instruments (truncated party id, or the registrar moved)",
        };
      }

      return { ok: true, instruments, status, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { ok: false, instruments: [], status, error: message };
    }
  }

  return { ok: false, instruments: [], status: null, error: "exhausted retries" };
}

/** One registry reading, as the record stores it. */
export interface SupplyReading {
  /** The registry's totalSupplyAsOf: the instant the supply describes. */
  supply_as_of: string;
  /** Decimal text, as the registry served it. */
  total_supply: string;
  /** The host that served it, named on the published value. */
  source_host: string;
}

export interface SupplyWriter {
  /** Stores a reading once per instant; false when that instant was already stored. Throws on a failed write. */
  recordSupplyReading(reading: SupplyReading): Promise<boolean>;
}

export interface SupplyCollectionResult {
  /** The run produced a usable outcome: a reading stored (or already stored), or no supply reported. */
  ok: boolean;
  registry: string;
  /** The reading the registry served for the instrument, when it reported one. */
  reading: SupplyReading | null;
  /** The reading was new to the store. */
  inserted: boolean;
  /** The registry lists the instrument without a supply (legal under CIP-0056). */
  no_supply_reported: boolean;
  error: string | null;
}

/** The default registry: the first Scan host's token registry. */
export function defaultRegistryBaseUrl(): string {
  return `${scanRecordHosts()[0]}/registry/metadata/v1`;
}

/** One run: read the registry, store Canton Coin's reading, and report the outcome to the health latch. */
export async function runSupplyCollection(deps: {
  writer: SupplyWriter;
  /** Default defaultRegistryBaseUrl(). */
  registryBaseUrl?: string;
  /** Default CC_INSTRUMENT_ID. */
  instrumentId?: string;
}): Promise<SupplyCollectionResult> {
  const registry = deps.registryBaseUrl ?? defaultRegistryBaseUrl();
  const instrumentId = deps.instrumentId ?? CC_INSTRUMENT_ID;
  const outcome = (ok: boolean, detail: string): FeedOutcome => ({ id: "registry:CC", label: "CC registry", ok, detail });
  const done = async (result: SupplyCollectionResult, detail: string): Promise<SupplyCollectionResult> => {
    await checkFeedHealth(SUPPLY_HEALTH, [outcome(result.ok, detail)]);
    return result;
  };
  const base = { registry, reading: null, inserted: false, no_supply_reported: false };

  const result = await fetchRegistryInstruments(registry);
  if (!result.ok) return done({ ...base, ok: false, error: result.error ?? "unknown" }, result.error ?? "unknown");

  const instrument = result.instruments.find((i) => i.id === instrumentId);
  if (!instrument) {
    return done({ ...base, ok: false, error: `instrument ${instrumentId} absent from registry` }, "0/1 written");
  }
  if (!instrument.totalSupply || !instrument.totalSupplyAsOf) {
    // Legal under CIP-0056: reporting supply is optional. Not a failure.
    return done({ ...base, ok: true, no_supply_reported: true, error: null }, "0/1 written");
  }

  const reading: SupplyReading = {
    supply_as_of: instrument.totalSupplyAsOf,
    total_supply: instrument.totalSupply,
    source_host: hostOf(registry),
  };
  try {
    const inserted = await deps.writer.recordSupplyReading(reading);
    return done({ ...base, ok: true, reading, inserted, error: null }, "1/1 written");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scan-record] supply write failed for ${reading.supply_as_of}: ${message}`);
    return done({ ...base, ok: false, reading, error: `write failed: ${message}` }, "0/1 written");
  }
}
