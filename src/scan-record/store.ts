/**
 * Persistence for the open record's data layer: the RecordStore interface and
 * its row shapes. The adapters are in src/adapters (Postgres reference,
 * Supabase, in-memory).
 *
 * Raw inputs (rounds, snapshots, cursor) are written by the collector and the
 * backfill; values and gaps only by finalize.ts. Numerics travel as text,
 * never as a double: supply needs about 21 significant digits.
 */

import {
  METHOD_SCAN,
  SERIES_NAMES,
  type GapRow,
  type GapStatus,
  type IssuanceCategory,
  type ReasonCode,
  type RecordMethod,
  type RevisionKind,
  type SeriesName,
  type ValueRow,
  type ValueStatus,
} from "../open-record/contract";
import type { IssuanceConfig, StartIssuingCapture } from "./rounds";

export interface RoundSplit {
  summary: StartIssuingCapture["summary"];
  rates: StartIssuingCapture["rates"];
  config_inferred: boolean;
}

export interface RoundRow {
  round: number;
  opens_at: string | null;
  start_issuing_at: string | null;
  closed_at: string | null;
  tick_duration_us: number | null;
  issuance_config: IssuanceConfig | null;
  amulet_price: string | null;
  app_rewards_cc: string | null;
  validator_rewards_cc: string | null;
  sv_rewards_cc: string | null;
  dev_fund_cc: string | null;
  faucet_rewards_cc: string | null;
  unfeatured_app_rewards_cc: string | null;
  unclaimed_rewards_cc: string | null;
  split: RoundSplit | null;
  issuing_contract_id: string | null;
  update_id: string | null;
  migration_id: number | null;
  source_host: string;
  method: RecordMethod;
  repaired: boolean;
}

export function blankRound(round: number, sourceHost: string): RoundRow {
  return {
    round, opens_at: null, start_issuing_at: null, closed_at: null, tick_duration_us: null,
    issuance_config: null, amulet_price: null, app_rewards_cc: null, validator_rewards_cc: null,
    sv_rewards_cc: null, dev_fund_cc: null, faucet_rewards_cc: null, unfeatured_app_rewards_cc: null,
    unclaimed_rewards_cc: null, split: null, issuing_contract_id: null, update_id: null, migration_id: null,
    source_host: sourceHost, method: METHOD_SCAN, repaired: false,
  };
}

/** Each write type always carries the same keys, so an upsert never nulls a column it did not name. */
export type RoundMetaWrite = Pick<
  RoundRow,
  "round" | "opens_at" | "tick_duration_us" | "issuance_config" | "amulet_price" | "source_host" | "method"
>;
export type RoundCaptureWrite = Pick<
  RoundRow,
  | "round" | "start_issuing_at" | "tick_duration_us" | "issuance_config" | IssuanceCategory | "split"
  | "issuing_contract_id" | "update_id" | "migration_id" | "source_host" | "method" | "repaired"
>;
export type RoundTotalsWrite = Pick<
  RoundRow,
  "round" | "closed_at" | "app_rewards_cc" | "validator_rewards_cc" | "source_host" | "method"
>;

export interface SnapshotRow {
  date: string;
  record_time: string;
  migration_id: number;
  source_host: string;
  method: typeof METHOD_SCAN;
  last_round: number | null;
  reference_round: number | null;
  reference_price_usd: string | null;
  super_validators: number | null;
  sv_voting_threshold: number | null;
  featured_apps: number | null;
  validator_licenses: number | null;
}

export interface CursorRow {
  id: string;
  last_round: number | null;
  last_date: string | null;
  last_poll_at: string | null;
  detail: Record<string, unknown>;
}

export interface ValueWrite {
  date: string;
  series: SeriesName;
  value: string | null;
  status: ValueStatus;
  source_host: string | null;
  method: RecordMethod;
  as_of: string | null;
  retrieved_at: string;
  finalized_at: string | null;
}

export interface GapWrite {
  date: string;
  series: SeriesName | "all";
  reason_code: ReasonCode;
  reason: string;
  status: GapStatus;
  evidence_url?: string | null;
}

export interface RecordStore {
  getCursor(id: string): Promise<CursorRow | null>;
  setCursor(row: CursorRow): Promise<void>;
  upsertRoundMeta(rows: RoundMetaWrite[]): Promise<void>;
  upsertRoundCaptures(rows: RoundCaptureWrite[]): Promise<void>;
  upsertRoundTotals(rows: RoundTotalsWrite[]): Promise<void>;
  /** Inclusive, by round number, at most 1,000 rounds. */
  getRounds(from: number, to: number): Promise<RoundRow[]>;
  /** Rounds whose StartIssuing record time is in [fromIso, toIso). */
  getRoundsStartedBetween(fromIso: string, toIso: string): Promise<RoundRow[]>;
  getSnapshot(date: string): Promise<SnapshotRow | null>;
  /** The dates in [from, to] that have a snapshot row, ascending. Paged, so it is not bounded by the 1,000-row cap. */
  listSnapshotDates(from: string, to: string): Promise<string[]>;
  /**
   * Stored rows in [from, to] whose validator_licenses is null, oldest first
   * (the backfill's license completion pass). Paged past the 1,000-row cap.
   */
  listSnapshotsMissingLicenses(from: string, to: string): Promise<SnapshotRow[]>;
  /**
   * Stamps retrieved_at with the time of this write, not only the insert's
   * column default: the row's latest Scan read, so validator licenses added to
   * a row read earlier never carry the earlier time. A null validator_licenses
   * is left out of the write, so a writer that did not read them (the
   * backfill) never erases a stored count.
   *
   * The backfill never writes over an existing row's core: it inserts
   * days that have none, and its license completion pass (network index plan
   * D6) adds only a count read from the row's own host, migration and record
   * time, as the forward stage does. A kept count survives any write, so a
   * backfill that rewrote a row's core from another host (or migration) would
   * leave that count credited to a source_host it was not read from. Every
   * stored count must come from the row's own host, as readLicenseCount
   * checks.
   */
  upsertSnapshot(row: SnapshotRow): Promise<void>;
  /**
   * The backfill's only snapshot write: a plain insert of a day that has no
   * row. True when it inserted; false, with nothing written, when the date
   * already has a row (the primary key refuses it, 23505), so a row the
   * forward stage stored after the backfill listed the day keeps its own
   * host and license count. Any other refusal throws.
   */
  insertSnapshot(row: SnapshotRow): Promise<boolean>;
  getValues(date: string): Promise<ValueRow[]>;
  /**
   * The dates in [from, to] that have a network_record_values row of
   * VALUE_DATE_SERIES, ascending: the backfill's check for a stored day that
   * was never finalized. One row per day, since finalize writes every series
   * of a day it evaluates (only an unexplained null writes none, and such a
   * day is owed again, as it should be). Paged, so it is not bounded by the
   * 1,000-row cap.
   */
  listValueDates(from: string, to: string): Promise<string[]>;
  upsertValues(rows: ValueWrite[]): Promise<void>;
  /**
   * The one door for a final value (REVISE_RPC). sourceHost, asOf and method
   * default to the row's own, and a withdrawal clears the host and as_of; a
   * backfill that fills a gap's null, or a correction that restores a
   * withdrawn value, must pass the host and as_of, or the RPC refuses it
   * (P0001). A backfill passes the method that produced its value too: a
   * gap's null carries a method of its own (scan-rt-1 for what the
   * round-totals archive cannot carry), and the new value and its logged
   * revision are published under the method given here. An unchanged value
   * is a no-op that keeps the stored provenance. A withdrawn (date, series)
   * refuses anything but a correction with RECORD_SQLSTATE.WITHDRAWN.
   */
  revise(
    date: string,
    series: SeriesName,
    value: string | null,
    kind: RevisionKind,
    reason: string,
    sourceHost?: string | null,
    asOf?: string | null,
    method?: RecordMethod | null,
  ): Promise<number>;
  getGaps(date: string): Promise<GapRow[]>;
  upsertGap(gap: GapWrite): Promise<void>;
  /** Resolve the open gaps of (date, series), except those with reason `keep` when given. */
  resolveGaps(date: string, series: SeriesName, atIso: string, keep?: ReasonCode): Promise<void>;
  getSupplyAt(instantIso: string): Promise<{ value: string; source_host: string } | null>;
  markDirty(atIso: string): Promise<void>;
}

/** The series listValueDates reads: one that finalize writes on every day it evaluates. */
export const VALUE_DATE_SERIES: SeriesName = SERIES_NAMES[0];

/**
 * A failed store call. `code` is the Postgres SQLSTATE, so a caller matches
 * RECORD_SQLSTATE by code, never by message.
 */
export class RecordStoreError extends Error {
  readonly code: string | null;
  constructor(what: string, error: { code?: string; message: string }) {
    super(`[scan-record] ${what}: ${error.code ?? "?"} ${error.message}`);
    this.name = "RecordStoreError";
    this.code = error.code ?? null;
  }
}

/** The SQLSTATE a store call failed with, or null for any other error. */
export function recordErrorCode(err: unknown): string | null {
  return err instanceof RecordStoreError ? err.code : null;
}
