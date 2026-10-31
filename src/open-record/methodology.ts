/**
 * methodology.json: the Methodology page's dataset section, rendered from
 * the contract and the stored data so the field table, reason codes, sources
 * and first dates can never drift from the files. The public Methodology page
 * renders it.
 */

import {
  ATTRIBUTION,
  FRESHNESS,
  FRESHNESS_COMMITTED,
  LICENSE,
  LICENSE_SCOPE,
  METHOD_SCAN,
  OPEN_BASE_URL,
  REASON_CODES,
  RECORD_RELEASE_LABEL,
  SCHEMA_VERSION,
  SERIES,
  SERIES_NAMES,
  STATIC_FILES,
  TRADEMARK_NOTICE,
  type SeriesName,
} from "./contract";
import { toJson, type RecordModel } from "./render";

/**
 * Who runs each Scan host, and what it publishes about reuse. A host missing
 * here is named without an operator.
 */
const HOST_OPERATORS: Record<string, string> = {
  "api.cantonnodes.com":
    "Canton Nodes, powered by Proof Group, a Super Validator; a commercial service whose free tier is rate limited, with no published terms of service or data license",
};

/** The host the collector reads by default, named before any value is stored. */
const DEFAULT_SOURCE_HOST = "api.cantonnodes.com";

export function hostSourceTitle(host: string): string {
  const operator = HOST_OPERATORS[host];
  return `Canton Scan (Splice Scan API) served by ${host}${operator ? ` (${operator})` : ""}`;
}

/** Legacy defects, stated once so the history is not hidden. SQL 2026-09-25. */
const LEGACY_MISSING_DATES = ["2026-03-28", "2026-03-29", "2026-04-14", "2026-06-18", "2026-08-14"];

const SOURCE: Record<SeriesName, string> = {
  first_round: "ACS snapshot, IssuingMiningRound (and StartIssuing record times)",
  last_round: "ACS snapshot, IssuingMiningRound (and StartIssuing record times)",
  rounds: "ACS snapshot, IssuingMiningRound (and StartIssuing record times)",
  supply_cc: "GET /registry/metadata/v1/instruments, totalSupply",
  net_supply_change_cc: "Derived from supply_cc",
  reference_price_usd: "ACS snapshot, OpenMiningRound amuletPrice",
  issuance_cc: "Derived: the seven categories",
  app_rewards_cc: "POST /v2/updates, AmuletRules_MiningRound_StartIssuing",
  validator_rewards_cc: "POST /v2/updates, AmuletRules_MiningRound_StartIssuing",
  sv_rewards_cc: "POST /v2/updates, AmuletRules_MiningRound_StartIssuing",
  dev_fund_cc: "POST /v2/updates, UnclaimedDevelopmentFundCoupon created at StartIssuing",
  faucet_rewards_cc: "POST /v2/updates, AmuletRules_MiningRound_StartIssuing",
  unfeatured_app_rewards_cc: "POST /v2/updates, AmuletRules_MiningRound_StartIssuing",
  unclaimed_rewards_cc: "POST /v2/updates, UnclaimedReward created at StartIssuing",
  super_validators: "ACS snapshot, DsoRules",
  sv_voting_threshold: "ACS snapshot, DsoRules",
  featured_apps: "ACS snapshot, FeaturedAppRight",
  validator_licenses: "ACS snapshot, ValidatorLicense",
  app_reward_coupons: "POST /v2/updates, AmuletRules_MiningRound_StartIssuing summary, totalFeaturedAppRewardCoupons",
  validator_reward_coupons: "POST /v2/updates, AmuletRules_MiningRound_StartIssuing summary, totalValidatorRewardCoupons",
};

const REASONS: Record<(typeof REASON_CODES)[number], string> = {
  not_collected: "Before this series was collected; a backfill may be planned.",
  source_unavailable: "The source did not answer, or has not published the reading yet.",
  source_not_available_before: "The source has no reading this far back.",
  pending_past_deadline: "Still pending after the day's settle deadline.",
  withdrawn: "A published value was withdrawn; it stays empty until a correction restores it (see revisions.csv).",
  not_derivable: "Cannot be derived from Scan data.",
  sources_disagree: "Two readings of the same fact disagreed; held until resolved.",
  sanity_gate_failed: "The value failed a sanity check and is held, never published as a confident number.",
  round_missed: "A mining round was not captured and the targeted repair has not recovered it.",
};

export interface MethodologySection {
  id: string;
  title: string;
  paragraphs: string[];
  table?: { columns: string[]; rows: string[][] };
}

function firstDateOf(model: RecordModel, series: SeriesName): string {
  for (const d of model.dates) if (model.values.get(d)?.get(series)?.value != null) return d;
  return "not yet";
}

/**
 * The method versions of a series' published values, oldest first; scan-1
 * before any value. An empty row (a gap's) names the method of the branch
 * that could not fill it, not of anything published, so it is left out, as
 * daily.csv's method column leaves it out (render.ts).
 */
function methodsOf(model: RecordModel, series: SeriesName): string {
  const seen: string[] = [];
  for (const d of model.dates) {
    const v = model.values.get(d)?.get(series);
    if (v?.value != null && !seen.includes(v.method)) seen.push(v.method);
  }
  return seen.length > 0 ? seen.join(", ") : METHOD_SCAN;
}

const OBSERVABLE = "Observable by any onboarded validator through Scan; publicly through third-party Scan proxies";

export function renderMethodology(model: RecordModel, sourceHosts: string[], generationId: string): string {
  // One list for the host names and their operators, so a host is never named without its operator.
  const hostList = sourceHosts.length > 0 ? sourceHosts : [DEFAULT_SOURCE_HOST];
  const freshness = FRESHNESS_COMMITTED ? "commitment" : "target";
  const sections: MethodologySection[] = [
    {
      id: "rules",
      title: "The rules",
      paragraphs: [
        "Every figure carries its source and its time. \"As of\" is the time the data describes; \"retrieved\" is when CCTools read it.",
        "Gaps stay gaps: a value that was not recorded is empty, never zero, and every empty value in a final row has a reason in gaps.csv.",
        "History is corrected after publication, in the open: every change to a final value is a row in revisions.csv.",
      ],
    },
    {
      id: "daily-record",
      title: "The daily record",
      paragraphs: [
        "A day is a UTC day D: [D 00:00:00Z, D+1 00:00:00Z). Snapshot series are the state at D+1 00:00:00Z, so a snapshot minus the previous day's snapshot is the flow of day D.",
        "A mining round belongs to day D when the record time of its AmuletRules_MiningRound_StartIssuing exercise falls in D. first_round and last_round are published so anyone can recompute a day.",
        `A value is provisional until its day has settled, then final: provisional by ${FRESHNESS.provisional_by} and final by ${FRESHNESS.final_by}, as a ${freshness}.`,
      ],
      table: {
        columns: ["Column", "Unit", "Definition", "Scan source", "Since", "Settle window", "Method"],
        rows: SERIES.map((s) => [
          s.name, s.unit, s.description, SOURCE[s.name], firstDateOf(model, s.name),
          `Final by ${FRESHNESS.final_by}`, methodsOf(model, s.name),
        ]),
      },
    },
    {
      id: "sources",
      title: "Sources",
      paragraphs: [
        `Canton Scan (the Splice Scan API that Super Validators serve), read through ${hostList.join(", ")}. This is a single operator until a second Super Validator source is added; the host is recorded on every value.`,
        ...hostList.filter((h) => HOST_OPERATORS[h]).map((h) => `${h}: ${HOST_OPERATORS[h]}.`),
        "Scan data is observable by any onboarded validator through Scan, and publicly through third-party Scan proxies. When two Super Validator scans are available, each day's snapshot series will be read from both and compared.",
        "Loop Data and market price providers are not sources of the record.",
      ],
    },
    {
      id: "data-classes",
      title: "What each series depends on",
      paragraphs: ["The record publishes no party-level rows. Per-party views elsewhere on cctools.network are not part of the record."],
      table: {
        columns: ["Series", "Data required", "Class", "Depends on involved-party or Mediator metadata", "If that metadata disappears"],
        rows: [
          ["Issuance by category, reward coupon totals, rounds, reference price", "DSO round contracts and the StartIssuing exercise", OBSERVABLE, "No", "Unaffected"],
          ["Supply", "Registry metadata (a DSO-level aggregate)", OBSERVABLE, "No", "Unaffected"],
          ["Super Validators, threshold, featured apps, validator licenses", "DSO-governed contracts", OBSERVABLE, "No (operator parties appear in contracts, not in Mediator metadata)", "Unaffected"],
          ["All synchronizer transactions, total parties", "Mediator verdicts, topology", "Metadata-dependent", "Yes", "Would break: excluded from the record"],
        ],
      },
    },
    {
      id: "gaps",
      title: "Gaps",
      paragraphs: ["Every empty value in a final row joins a reason in gaps.csv, or the day stays provisional and an alert fires."],
      table: { columns: ["reason_code", "Meaning"], rows: REASON_CODES.map((c) => [c, REASONS[c]]) },
    },
    {
      id: "revisions",
      title: "Corrections and revisions",
      paragraphs: [
        "A final value changes only as a logged revision: backfill (empty to value), correction (a new value, with its source host and as-of time), withdrawal (value to empty, with a new gap) or method (a new value recomputed under a new method version). A recomputation that gives the same value is not a revision: the value keeps its revision number, source host and as-of time. The database enforces this.",
        "A withdrawn value stays empty until a correction restores it: the daily jobs never put a withdrawn number back.",
        "Method versions: scan-1 (forward StartIssuing capture and the D+1 00:00Z ACS snapshot); scan-rt-1 (reserved for the archived round-totals endpoint, which was checked against the StartIssuing split and matches it for neither app nor validator rewards: its app rewards exceed the featured-app pool a round can issue, consistent with counting rewards collected rather than issued, so nothing from it is published).",
        `Backfill before the first public release (${RECORD_RELEASE_LABEL}) is part of release 0; revision counters start at 0 on release day.`,
      ],
    },
    {
      id: "downloads",
      title: "Downloads and license",
      paragraphs: [
        `Files: ${STATIC_FILES.filter((p) => p !== "methodology.json").map((p) => `${OPEN_BASE_URL}${p}`).join(", ")}, one file per day at ${OPEN_BASE_URL}days/YYYY-MM-DD.json, and ${OPEN_BASE_URL}status.json. No key, no cookie.`,
        `Schema ${SCHEMA_VERSION}. An added column is a minor version on the same path; a rename, removal or change of unit is a new major version at /v2/, and /v1/ keeps serving for at least six months.`,
        `Data and this text: ${LICENSE.title} (${LICENSE.path}). Attribution: ${ATTRIBUTION}.`,
        LICENSE_SCOPE,
        "These daily files are permanently free and keyless. Paid products are sold on freshness, granularity and support, never on access to the daily facts.",
        "Please cache: the files change at most hourly. Intraday and per-round data are in the keyed API.",
        TRADEMARK_NOTICE,
      ],
    },
    {
      id: "cite",
      title: "How to cite",
      paragraphs: [
        "Each day page and days/YYYY-MM-DD.json carry a plain citation and a BibTeX entry; replace {retrieved} with the date you read it.",
        `Dataset: CCTools (${RECORD_RELEASE_LABEL.slice(0, 4)}). CCTools daily record of the Canton Network, schema ${SCHEMA_VERSION}, release ${RECORD_RELEASE_LABEL}.`,
      ],
    },
    {
      id: "reproducibility",
      title: "Reproducibility",
      paragraphs: [
        // What statusDocument (serve.ts) lists: the static files' sha256 in each kept generation (publish.ts), the day files only counted.
        `first_round and last_round let anyone recompute a day's issuance from Scan. status.json lists the sha256 of ${STATIC_FILES.slice(0, -1).join(", ")} and ${STATIC_FILES[STATIC_FILES.length - 1]} for each of the last 24 generations. For the day files it gives their count and their first and last dates, not their sha256: each day file is served with its own sha256 as its ETag.`,
      ],
    },
    {
      id: "limitations",
      title: "Known limitations",
      paragraphs: [
        "The reference price is the Super Validators' voted price, not a market price.",
        "Issuance is what the rounds schedule, not minted supply: unclaimed rewards are not minted and some shares are minted only when claimed, so net supply change can be negative or larger than a day's issuance.",
        "Burn is not in schema 1.0.0; it arrives as a new column when measured. Transaction counts stay out of the record: counting all synchronizer transactions depends on Mediator metadata (see What each series depends on).",
        "Reward coupon totals start with the forward collector: the round-totals archive does not carry them, so earlier days are empty (not collected) until the update-stream backfill. A coupon total is a sum of coupon amounts, not a count of apps, validators or transactions.",
        "Single operator until a second Super Validator source is added. App rewards and app reward coupons change method when the network switches reward versions (CIP-104).",
      ],
    },
    {
      id: "before-the-record",
      title: "Before the open record",
      paragraphs: [
        "CCTools kept an earlier daily table copied from a third-party indexer (Loop Data). It is not carried into this record, and its defects are listed here so the history is not hidden:",
        `Missing dates: ${LEGACY_MISSING_DATES.join(", ")}.`,
        "On 2026-08-14 a missing column stopped the daily write, which is why that date is absent.",
        "Its supply figure stayed frozen at one value from mid-August 2026, about 5% below the registry supply.",
        "In September 2026 several values are empty because the indexer answered 401 or 429 on those days.",
      ],
    },
  ];
  // Every series is in the field table: a new column cannot ship without its row.
  if (sections[1].table?.rows.length !== SERIES_NAMES.length) throw new Error("methodology field table is incomplete");
  return toJson({ schema_version: SCHEMA_VERSION, generation_id: generationId, title: "Methodology", sections });
}
