import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AcsCreatedEvent } from "../../acs";
import { parseOpenAndIssuing, type ScanTransaction } from "../../rounds";
import { ScanBusyError, type ScanCallClass } from "../../scan-budget";
import { ACS_ENDPOINTS, scanCallWorstCaseMs, type ScanApi } from "../../scan-client";

export const FIXTURES = join(process.cwd(), "src/scan-record/__tests__/fixtures");
export const loadFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));

const HOST = "api.cantonnodes.com";

export interface FakeScanOptions {
  openAndIssuing?: unknown;
  transactions?: ScanTransaction[];
  acs?: Record<string, { created_events: AcsCreatedEvent[] }>;
  /**
   * The host that answers acsSnapshot for a template, for a read that fell back
   * to another host. A call pinned to a different configured host reports busy
   * (its gate is open) before it is made, as the live client does.
   */
  acsHosts?: Record<string, string>;
  /**
   * SCAN_RECORD_HOSTS, as host names. Default: api.cantonnodes.com and every
   * host in `acsHosts`. A call pinned to a host outside it throws a plain
   * Error (a configuration fault, not a wait), as the live client does.
   */
  hosts?: string[];
  /**
   * Added to every round number of the OpenMiningRound and IssuingMiningRound
   * events served for a record time, so one fixture can stand for a run of
   * days whose rounds advance (and whose round-count gate passes).
   */
  acsRoundOffset?: (recordTime: string) => number;
  /** Thrown by acsSnapshot, for "snapshot not readable yet". */
  acsError?: Error;
  /** Thrown by acsSnapshot for one template only. */
  acsErrors?: Record<string, Error>;
  /** Thrown by updatesAfter, after the call is made: a 5xx, a timeout or a shape error. */
  updatesError?: Error;
  /**
   * The fake's clock for deadlines. It starts at `startMs`; each ACS call is
   * asked at the clock, waits for its slot in the shared queue and answers
   * `callMs` after that slot. The queue is kept as scan-budget keeps it: a
   * slot starts no sooner than the clock and no sooner than `spacingMs` after
   * the slot before, and the first slot is `firstWaitMs` after `startMs` (a
   * slot an earlier caller holds). Both default to 0, so each call then just
   * takes `callMs`. A call whose worst case for the fake's class
   * (scanCallWorstCaseMs) would pass the caller's deadline at the time it is
   * asked is refused as busy before it is made (and so not in `calls`), as the
   * live client does. Without it, deadlines are checked against Date.now().
   */
  clock?: { startMs: number; callMs: number; spacingMs?: number; firstWaitMs?: number };
  /** The budget class the fake's calls are made in, as liveScanApi(cls). Default record. */
  cls?: ScanCallClass;
  /** Thrown by every call, for a closed budget. */
  error?: Error;
}

/** Serves fixtures the way Scan pages them: updates strictly after the cursor, ascending. */
export function fakeScan(opts: FakeScanOptions): ScanApi & { calls: string[] } {
  const calls: string[] = [];
  const hosts = opts.hosts ?? [HOST, ...Object.values(opts.acsHosts ?? {})];
  const cls = opts.cls ?? "record";
  let clockMs = opts.clock?.startMs ?? 0;
  let nextSlotMs = clockMs + (opts.clock?.firstWaitMs ?? 0);
  const guard = (name: string) => {
    calls.push(name);
    if (opts.error) throw opts.error;
  };
  /** As the live client: a call whose worst case would pass the deadline is refused before it is made. */
  const refuseLate = (deadline: number | undefined, host = HOST) => {
    const nowMs = opts.clock ? clockMs : Date.now();
    if (deadline !== undefined && nowMs + scanCallWorstCaseMs(cls) > deadline) throw new ScanBusyError(host, "queue");
  };
  return {
    calls,
    cls,
    async migrationId(deadline) {
      refuseLate(deadline);
      guard("migrationId");
      return 4;
    },
    async openAndIssuing(deadline) {
      refuseLate(deadline);
      guard("openAndIssuing");
      return { host: HOST, rounds: parseOpenAndIssuing(opts.openAndIssuing ?? {}) };
    },
    async updatesAfter(_migrationId, afterRecordTime, pageSize, deadline) {
      refuseLate(deadline);
      guard(`updatesAfter ${afterRecordTime}`);
      if (opts.updatesError) throw opts.updatesError;
      const after = Date.parse(afterRecordTime);
      const transactions = (opts.transactions ?? [])
        .filter((t) => Date.parse(t.record_time) > after)
        .sort((a, b) => Date.parse(a.record_time) - Date.parse(b.record_time))
        .slice(0, pageSize);
      return { host: HOST, transactions };
    },
    async acsSnapshot(_migrationId, recordTime, template, onlyHost, deadline) {
      // In the live client's order: the host list, the deadline, the gate, then the call.
      if (onlyHost !== undefined && !hosts.includes(onlyHost)) {
        throw new Error(`Scan host ${onlyHost} is not in SCAN_RECORD_HOSTS`);
      }
      refuseLate(deadline, onlyHost ?? HOST);
      const host = opts.acsHosts?.[template] ?? HOST;
      if (onlyHost !== undefined && host !== onlyHost) throw new ScanBusyError(onlyHost, "gate");
      if (opts.clock) {
        const slot = Math.max(clockMs, nextSlotMs);
        nextSlotMs = slot + (opts.clock.spacingMs ?? 0);
        clockMs = slot + opts.clock.callMs;
      }
      guard(`acs ${recordTime} ${template}`);
      if (opts.acsError) throw opts.acsError;
      if (opts.acsErrors?.[template]) throw opts.acsErrors[template];
      const events = opts.acs?.[template]?.created_events ?? [];
      const endpoint = ACS_ENDPOINTS.v2;
      const offset = opts.acsRoundOffset?.(recordTime) ?? 0;
      if (offset === 0) return { host, endpoint, events };
      return {
        host,
        endpoint,
        events: events.map((e) => {
          const args = e.create_arguments as { round?: { number?: string } } | undefined;
          if (args?.round?.number == null) return e;
          return { ...e, create_arguments: { ...args, round: { ...args.round, number: String(Number(args.round.number) + offset) } } };
        }),
      };
    },
  };
}
