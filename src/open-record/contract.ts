/**
 * The open daily record of the Canton Network, schema 1.0.0.
 *
 * The one place that names what is published: series, units, columns,
 * reason codes, row shapes, file names and file-cache keys. The collector
 * (src/scan-record) writes against it and the publisher (src/open-record)
 * renders from it, so the two cannot drift.
 *
 * Changing a name, unit or definition here changes a public file. An added
 * series is a minor version on the same path; a rename, removal or change of
 * unit is a major version at /v2/.
 */

export const SCHEMA_VERSION = "1.0.0";

export const METHOD_SCAN = "scan-1";
export const METHOD_ROUND_TOTALS = "scan-rt-1";
export type RecordMethod = typeof METHOD_SCAN | typeof METHOD_ROUND_TOTALS;

export const LICENSE = {
  name: "CC-BY-4.0",
  title: "Creative Commons Attribution 4.0 International",
  path: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export const ATTRIBUTION =
  "Source: CCTools daily record of the Canton Network (CC BY 4.0), https://cctools.network/network";

/**
 * What the license covers: CCTools can license only
 * what it derives. The source data comes from a Super Validator's Scan under
 * that host's terms, and api.cantonnodes.com publishes none.
 */
export const LICENSE_SCOPE =
  "CC BY 4.0 covers the daily aggregates CCTools derives and this documentation. They are derived from Scan data served publicly by a Super Validator; the host is named in the sources and on every value, and CCTools licenses only its derived aggregates, not the underlying Scan data.";

/** The same words as the site footer: Digital Asset's own two-sentence template. A test pins the text. */
export const TRADEMARK_NOTICE =
  "Canton is a registered trademark of Digital Asset (Switzerland) GmbH. Digital Asset is not affiliated with, and has not sponsored or endorsed, CCTools.";

export const OPEN_BASE_PATH = "/api/open/network-record/v1/";
export const OPEN_BASE_URL = `https://api.cctools.network${OPEN_BASE_PATH}`;
export const SITE_RECORD_URL = "https://cctools.network/network";

/** First day of the published range. */
export const RECORD_FIRST_DATE = "2026-03-26";
/** First day with an exact 00:00:00Z registry reading at its end (the registry supply readings). */
export const SUPPLY_FIRST_DATE = "2026-09-02";
/**
 * Revisions before this instant belong to release 0 (the history assembled
 * before the first public release) and are never published. It is the
 * release day at 00:00Z.
 */
export const RECORD_RELEASE_AT = "2026-10-14T00:00:00Z";
export const RECORD_RELEASE_LABEL = "2026-10";
/**
 * Hours after the end of D from which finalize may mark D's snapshot and round
 * series final: the settle deadline. Not the public promise.
 */
export const SETTLE_HOURS = 2;
/**
 * Hours after the end of D by which D is promised final: D+1 03:00 UTC. The
 * hour after the settle deadline holds the publish cycle (finalize at :35,
 * render at :40), so a day is published final at about D+1 02:40. status.json
 * states it, lag_hours counts from it, and a day not final by it is Lagging.
 */
export const FINAL_BY_HOURS = 3;
/** Edge TTL of the data files (their s-maxage): a rendered change reaches readers within it. */
export const EDGE_TTL_SECONDS = 3600;
/** Freshness is a target until 7 consecutive on-target days were measured. */
export const FRESHNESS_COMMITTED = false;

function hoursLabel(seconds: number): string {
  const hours = seconds / 3600;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * The freshness targets, stated by status.json and
 * methodology.json. final_by is built from FINAL_BY_HOURS, the instant
 * finalByMs, expectedFinalDate and lag_hours count from, so the stated time
 * and the measured lag never drift apart.
 */
export const FRESHNESS = {
  provisional_by: "D+1 01:00 UTC",
  final_by: `D+1 ${String(FINAL_BY_HOURS).padStart(2, "0")}:00 UTC`,
  files_within: hoursLabel(EDGE_TTL_SECONDS),
} as const;

export type SeriesKind = "decimal" | "count";

export interface SeriesDef {
  readonly name: string;
  readonly kind: SeriesKind;
  readonly unit: string;
  readonly title: string;
  readonly description: string;
}

const ROUND_RULE =
  "A round belongs to day D when the record time of its AmuletRules_MiningRound_StartIssuing exercise falls in D (UTC).";

export const SERIES = [
  { name: "first_round", kind: "count", unit: "round number", title: "First round",
    description: `Lowest mining round assigned to the day. ${ROUND_RULE}` },
  { name: "last_round", kind: "count", unit: "round number", title: "Last round",
    description: `Highest mining round assigned to the day. ${ROUND_RULE}` },
  { name: "rounds", kind: "count", unit: "rounds", title: "Rounds",
    description: "Number of rounds assigned to the day, last_round - first_round + 1, checked for contiguity with the previous day." },
  { name: "supply_cc", kind: "decimal", unit: "CC", title: "Supply",
    description: "Total Canton Coin supply at the end of the day (D+1 00:00:00Z): the Scan token registry's totalSupply whose totalSupplyAsOf is that instant." },
  { name: "net_supply_change_cc", kind: "decimal", unit: "CC", title: "Net supply change",
    description: "supply_cc(D) - supply_cc(D-1). Not issuance minus burn: minting is lumpy and burn can exceed it on a given day." },
  { name: "reference_price_usd", kind: "decimal", unit: "USD per CC", title: "Reference price",
    description: "SV-voted Canton Coin price (amuletPrice, the median of Super Validator votes) of the highest-numbered OpenMiningRound in the ACS snapshot at D+1 00:00:00Z. Not a market price." },
  { name: "issuance_cc", kind: "decimal", unit: "CC", title: "Issuance",
    description: "Issuance scheduled by the day's rounds: the sum of the seven category columns. Not minted supply." },
  { name: "app_rewards_cc", kind: "decimal", unit: "CC", title: "App rewards",
    description: "Featured-app reward issuance of the day's rounds: totalFeaturedAppRewardCoupons x issuancePerFeaturedAppRewardCoupon, as fixed at StartIssuing." },
  { name: "validator_rewards_cc", kind: "decimal", unit: "CC", title: "Validator rewards",
    description: "Validator reward issuance of the day's rounds: totalValidatorRewardCoupons x issuancePerValidatorRewardCoupon." },
  { name: "sv_rewards_cc", kind: "decimal", unit: "CC", title: "Super Validator rewards",
    description: "Super Validator reward issuance of the day's rounds: totalSvRewardWeight x issuancePerSvRewardCoupon." },
  { name: "dev_fund_cc", kind: "decimal", unit: "CC", title: "Development Fund",
    description: "Development Fund share of the day's rounds: the amount of each UnclaimedDevelopmentFundCoupon created at StartIssuing." },
  { name: "faucet_rewards_cc", kind: "decimal", unit: "CC", title: "Validator faucet",
    description: "Validator faucet issuance: optTotalValidatorFaucetCoupons x optIssuancePerValidatorFaucetCoupon. A measured zero while the faucet cap is 0." },
  { name: "unfeatured_app_rewards_cc", kind: "decimal", unit: "CC", title: "Unfeatured app rewards",
    description: "Unfeatured-app issuance: totalUnfeaturedAppRewardCoupons x issuancePerUnfeaturedAppRewardCoupon." },
  { name: "unclaimed_rewards_cc", kind: "decimal", unit: "CC", title: "Unclaimed rewards",
    description: "Issuance not assigned to any coupon: the amount of the UnclaimedReward created at StartIssuing, read from its own event, never computed as a remainder." },
  { name: "super_validators", kind: "count", unit: "members", title: "Super Validators",
    description: "Members of DsoRules.svs in the ACS snapshot at D+1 00:00:00Z." },
  { name: "sv_voting_threshold", kind: "count", unit: "votes", title: "Voting threshold",
    description: "Votes a DSO action needs for that membership: ceiling((n + f + 1) / 2) with f = floor((n - 1) / 3), as Splice DsoRules.daml summarizeDso computes it." },
  { name: "featured_apps", kind: "count", unit: "contracts", title: "Featured apps",
    description: "Active FeaturedAppRight contracts in the ACS snapshot at D+1 00:00:00Z (contracts, not distinct providers)." },
  { name: "validator_licenses", kind: "count", unit: "contracts", title: "Validator licenses",
    description: "Active ValidatorLicense contracts in the ACS snapshot at D+1 00:00:00Z. A new series: not the validator_count of Loop Data (formerly Lighthouse), by Five North." },
  { name: "app_reward_coupons", kind: "decimal", unit: "coupons", title: "App reward coupons",
    description: "Featured-app reward coupons of the day's rounds: the sum of totalFeaturedAppRewardCoupons in each round's AmuletRules_MiningRound_StartIssuing summary. app_rewards_cc is each round's total times its issuancePerFeaturedAppRewardCoupon. A sum of coupon amounts, not a count of apps or transactions. Empty, as not collected, before the forward collector's first full day; the update-stream backfill is planned." },
  { name: "validator_reward_coupons", kind: "decimal", unit: "coupons", title: "Validator reward coupons",
    description: "Validator reward coupons of the day's rounds: the sum of totalValidatorRewardCoupons in each round's AmuletRules_MiningRound_StartIssuing summary. validator_rewards_cc is each round's total times its issuancePerValidatorRewardCoupon. A sum of coupon amounts, not a count of validators. Empty, as not collected, before the forward collector's first full day; the update-stream backfill is planned." },
] as const satisfies readonly SeriesDef[];

export type SeriesName = (typeof SERIES)[number]["name"];
export const SERIES_NAMES: readonly SeriesName[] = SERIES.map((s) => s.name);

export function seriesDef(name: SeriesName): SeriesDef {
  const def = SERIES.find((s) => s.name === name);
  if (!def) throw new Error(`unknown series ${name}`);
  return def;
}

export const ISSUANCE_CATEGORIES = [
  "app_rewards_cc",
  "validator_rewards_cc",
  "sv_rewards_cc",
  "dev_fund_cc",
  "faucet_rewards_cc",
  "unfeatured_app_rewards_cc",
  "unclaimed_rewards_cc",
] as const satisfies readonly SeriesName[];
export type IssuanceCategory = (typeof ISSUANCE_CATEGORIES)[number];

/**
 * The coupon totals each round's StartIssuing summary carries, summed over the
 * day's rounds. Round-derived like the issuance categories (same range, gaps
 * and gates), but not issuance: they are what app_rewards_cc and
 * validator_rewards_cc are priced on. Decimal, since Scan sums coupon amounts.
 */
export const COUPON_SERIES = ["app_reward_coupons", "validator_reward_coupons"] as const satisfies readonly SeriesName[];
export type CouponSeries = (typeof COUPON_SERIES)[number];

export const DAILY_COLUMNS = ["date", "status", ...SERIES_NAMES, "method", "revision", "revised_at"] as const;
export const VALUES_COLUMNS = [
  "date", "series", "value", "status", "source_host", "method", "as_of", "revision", "revised_at",
] as const;
export const GAPS_COLUMNS = [
  "date", "series", "reason_code", "reason", "status", "detected_at", "resolved_at", "evidence_url",
] as const;
export const REVISIONS_COLUMNS = [
  "date", "series", "old_value", "new_value", "kind", "reason", "method", "revised_at",
] as const;

export const REASON_CODES = [
  "not_collected",
  "source_unavailable",
  "source_not_available_before",
  "pending_past_deadline",
  "withdrawn",
  "not_derivable",
  "sources_disagree",
  "sanity_gate_failed",
  "round_missed",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const GAP_STATUSES = ["open", "backfill_planned", "permanent", "resolved"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export const REVISION_KINDS = ["backfill", "correction", "withdrawal", "method"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export const VALUE_STATUSES = ["provisional", "final"] as const;
export type ValueStatus = (typeof VALUE_STATUSES)[number];

/** A network_record_values row as the readers return it: numerics as text, never as a double. */
export interface ValueRow {
  date: string;
  series: SeriesName;
  value: string | null;
  status: ValueStatus;
  source_host: string | null;
  method: RecordMethod;
  as_of: string | null;
  retrieved_at: string;
  finalized_at: string | null;
  revision: number;
  revised_at: string | null;
}

export interface GapRow {
  date: string;
  series: SeriesName | "all";
  reason_code: ReasonCode;
  reason: string;
  status: GapStatus;
  detected_at: string;
  resolved_at: string | null;
  evidence_url: string | null;
}

export interface RevisionRow {
  date: string;
  series: SeriesName;
  old_value: string | null;
  new_value: string | null;
  kind: RevisionKind;
  reason: string;
  method: string;
  revised_at: string;
}

/** scan_record_cursor ids. `render.detail.dirty_at` is the only link between the two tracks. */
export const CURSOR_FORWARD = "forward";
export const CURSOR_RENDER = "render";
export const CURSOR_OVERRIDES = "overrides";
/** Backfill bookkeeping: per-day attempts and the days it gave up on. */
export const CURSOR_BACKFILL = "backfill";
/**
 * The collector's daily snapshot stage, written by nothing else. The
 * collector writes the forward cursor on every run, so a backoff kept there
 * would be erased each time, and a copy of that row written back from the
 * stage could move the collector's cursor backwards. last_date is the day the
 * attempts belong to, last_poll_at the latest write, and detail the attempts
 * (empty once the day is read).
 */
export const CURSOR_SNAPSHOT = "snapshot";

/**
 * The one door for changing a final value (migration 00310):
 * revise_network_record(p_date, p_series, p_value, p_kind, p_reason,
 * p_method, p_source_host, p_as_of). The last three default to null, which
 * keeps the row's own; a withdrawal clears source_host and as_of instead. A
 * non-null value must end up naming its source host and as_of (LICENSE_SCOPE,
 * also a table check), and a gap's row and a withdrawn row have neither, so a
 * backfill that fills a null passes the computed value's source_host and
 * as_of, and so does a correction that restores a withdrawn value. A revision
 * changes the value or does nothing: one whose value is unchanged logs no
 * revision, keeps the revision number and keeps the stored provenance, and
 * new provenance (a missed-round repair's later as_of) is written only with a
 * changed value.
 */
export const REVISE_RPC = "revise_network_record";

/**
 * A final row whose value matches the recomputed one is settled, whatever its
 * method, source_host and as_of: REVISE_RPC could not change those alone. So
 * finalize compares values only, through sameFinalValue, and a method change
 * with an identical value is neither a revision nor a conflict.
 */
const NUMERIC_TEXT_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;
const RECORD_SCALE = 10;

/** Text numeric to an integer count of 10^-10 units, rounded half away from zero like Postgres round(numeric, 10). */
function scaledValue(text: string): bigint {
  const m = NUMERIC_TEXT_RE.exec(text.trim());
  const intPart = m?.[2] ?? "";
  const fracPart = m?.[3] ?? "";
  if (!m || intPart.length + fracPart.length === 0) {
    throw new Error(`not a numeric value: ${JSON.stringify(text)}`);
  }
  const digits = `${intPart || "0"}${fracPart.padEnd(RECORD_SCALE + 1, "0").slice(0, RECORD_SCALE + 1)}`;
  const ten = BigInt(10);
  const wide = BigInt(digits);
  const rounded = wide / ten + (wide % ten >= BigInt(5) ? BigInt(1) : BigInt(0));
  return m[1] === "-" ? -rounded : rounded;
}

/**
 * Whether two record values are the same value to REVISE_RPC: both null, or
 * equal as numerics after rounding to the column's 10 places (1.50 equals 1.5,
 * 0 equals -0.0). Compares exactly, never through a double. Throws on text
 * that is not a plain decimal.
 */
export function sameFinalValue(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return scaledValue(a) === scaledValue(b);
}

/**
 * SQLSTATEs of the two refusals that normal operation meets. Every other
 * refusal of the 00310 triggers and RPC is P0001 and means a bug.
 *
 * FINAL_CHANGED: a final network_record_values row was changed outside
 * REVISE_RPC.
 *
 * WITHDRAWN: the value, or the open 'withdrawn' gap, of a withdrawn
 * (date, series). A withdrawal lasts until a human correction through
 * REVISE_RPC, and finalize recomputes the last 7 days every hour from the same
 * raw rows, so it would meet this on every run for a week.
 *
 * Finalize therefore reads a day's open 'withdrawn' gaps first and leaves
 * those series out of its value writes, its revisions and its gap resolution.
 * A multi-row upsert is one statement, so WITHDRAWN from one row
 * aborts the whole batch and writes nothing. When a batch comes back with
 * WITHDRAWN (a withdrawal landed between the read and the write), finalize
 * re-reads the day's open withdrawals and retries the batch once without the
 * refused keys; a single revision call that comes back with WITHDRAWN skips
 * that (date, series) alone. Every other error, FINAL_CHANGED included, and a
 * second WITHDRAWN on the retried batch, fails the run (ok:false). Match on
 * the code (the database error's SQLSTATE), never on the message.
 */
export const RECORD_SQLSTATE = {
  FINAL_CHANGED: "RN001",
  WITHDRAWN: "RN002",
} as const;

export const CACHE_PREFIX = "open-record:v1";
export const MANIFEST_KEY = `${CACHE_PREFIX}:manifest`;
export function fileCacheKey(path: string): string {
  return `${CACHE_PREFIX}:file:${path}`;
}

export const STATIC_FILES = [
  "daily.csv",
  "daily.json",
  "values.csv",
  "gaps.csv",
  "revisions.csv",
  "datapackage.json",
  "methodology.json",
] as const;
export type StaticFile = (typeof STATIC_FILES)[number];

/** Checks the shape only: pass the captured date through isValidDate before using it. */
export const DAY_FILE_RE = /^days\/(\d{4}-\d{2}-\d{2})\.json$/;
export function dayFilePath(date: string): string {
  return `days/${date}.json`;
}

/** A rendered file as the file cache keeps it. `body` is served byte for byte. */
export interface StoredFile {
  path: string;
  body: string;
  content_type: string;
  sha256: string;
  /** sha256 of the body rendered without a generation id: what change detection compares. */
  content_sha256: string;
  generation_id: string;
  rows: number | null;
}

export interface ManifestFile {
  sha256: string;
  content_sha256: string;
  bytes: number;
  rows: number | null;
  generation_id: string;
}

export interface Manifest {
  schema_version: string;
  generation_id: string;
  /** When the current generation was produced (last content change). */
  generated_at: string;
  /** When a render last ran, changed or not: the 24-hour re-render check reads this. */
  rendered_at: string;
  dirty_at_rendered: string | null;
  first_date: string;
  last_date: string;
  latest_final_date: string | null;
  latest_provisional_date: string | null;
  source_hosts: string[];
  files: Record<string, ManifestFile>;
  generations: Array<{ generation_id: string; generated_at: string; files: Record<string, string> }>;
  warnings: Array<{ date: string; note: string }>;
}

/** One value on a day page and in days/{date}.json. */
export interface DayValue {
  value: string | number | null;
  unit: string;
  status: ValueStatus;
  source_host: string | null;
  method: RecordMethod;
  as_of: string | null;
  revision: number;
  revised_at: string | null;
  gap: { reason_code: ReasonCode; reason: string; status: GapStatus } | null;
}

/** days/{date}.json: what /network/[date] renders, byte for byte the file anyone can download. */
export interface DayFile {
  schema_version: string;
  generation_id: string;
  date: string;
  status: "final" | "provisional" | "missing";
  revision: number;
  revised_at: string | null;
  prev: string | null;
  next: string | null;
  values: Record<SeriesName, DayValue | null>;
  gaps: Array<Omit<GapRow, "date">>;
  revisions: Array<
    Omit<RevisionRow, "date" | "old_value" | "new_value"> & {
      old_value: string | number | null;
      new_value: string | number | null;
    }
  >;
  notes: string[];
  citation: { plain: string; bibtex: string; permalink: string; dataset: string };
  license: typeof LICENSE;
  /** LICENSE_SCOPE: the most-cited file carries the scoped claim, as daily.json does. */
  license_scope: string;
  attribution: string;
  links: { daily_csv: string; daily_json: string; gaps_csv: string; datapackage: string; methodology: string };
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A real UTC calendar day written as YYYY-MM-DD. Date.parse would turn
 * 2026-02-30 into 2026-03-02 and reject 2026-13-01, so the date must parse and
 * round-trip to the same string.
 */
export function isValidDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && utcDate(ms) === date;
}

export function addDays(date: string, days: number): string {
  return utcDate(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
}

/** D+1 00:00:00Z, the instant every snapshot series of D is read at. */
export function endOfDay(date: string): string {
  return `${addDays(date, 1)}T00:00:00Z`;
}

export function settleDeadlineMs(date: string): number {
  return Date.parse(endOfDay(date)) + SETTLE_HOURS * 3_600_000;
}

/** D+1 03:00:00Z, the instant D is promised final by (FRESHNESS.final_by). */
export function finalByMs(date: string): number {
  return Date.parse(endOfDay(date)) + FINAL_BY_HOURS * 3_600_000;
}

/** Newest day the public promise says is final at `nowMs`. */
export function expectedFinalDate(nowMs: number): string {
  return addDays(utcDate(nowMs - FINAL_BY_HOURS * 3_600_000), -1);
}

/**
 * Newest day finalize must have settled at `nowMs`: the due day cuts at the
 * settle deadline (SETTLE_HOURS, D+1 02:00), not at the public promise, so
 * the 02:35 run judges D and pages before the 03:00 promise is broken.
 * expectedFinalDate stays the reader's clock (serve, status.json, health).
 */
export function settledDueDate(nowMs: number): string {
  return addDays(utcDate(nowMs - SETTLE_HOURS * 3_600_000), -1);
}
