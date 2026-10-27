/**
 * The snapshot series, all read from the one ACS snapshot at D+1 00:00:00Z
 *, so forward collection and backfill share one method.
 */

export const TEMPLATES = {
  dsoRules: "splice-dso-governance:Splice.DsoRules:DsoRules",
  openRound: "splice-amulet:Splice.Round:OpenMiningRound",
  issuingRound: "splice-amulet:Splice.Round:IssuingMiningRound",
  featuredApp: "splice-amulet:Splice.Amulet:FeaturedAppRight",
  validatorLicense: "splice-amulet:Splice.ValidatorLicense:ValidatorLicense",
} as const;

export interface AcsCreatedEvent {
  contract_id: string;
  template_id: string;
  create_arguments: Record<string, unknown>;
  created_at?: string;
}

/**
 * Votes a DSO action needs, copied from Splice DsoRules.daml summarizeDso:
 * ceiling((n + f + 1) / 2) with f = floor((n - 1) / 3).
 */
export function requiredNumVotes(numSvs: number): number {
  const f = Math.floor((numSvs - 1) / 3);
  return Math.ceil((numSvs + f + 1) / 2);
}

/** DsoRules.svs is a list of [party, info] pairs in compact JSON; a map is accepted too. */
export function countSvs(args: Record<string, unknown>): number | null {
  const svs = args.svs;
  if (Array.isArray(svs)) return svs.length;
  if (svs && typeof svs === "object") return Object.keys(svs).length;
  return null;
}

function entity(templateId: string): string {
  const i = templateId.indexOf(":");
  return i >= 0 ? templateId.slice(i + 1) : templateId;
}

/** Whether an event is of `template` (a package-name id), whatever package id the event names. */
export function isTemplate(event: AcsCreatedEvent, template: string): boolean {
  return entity(event.template_id) === template.slice(template.indexOf(":") + 1);
}

/** Keep only events whose template matches the filter we sent: a host that ignores the filter must not inflate a count. */
function only(events: AcsCreatedEvent[], template: string): AcsCreatedEvent[] {
  return events.filter((e) => isTemplate(e, template));
}

function roundOf(args: Record<string, unknown>): number | null {
  const n = Number((args.round as { number?: unknown } | undefined)?.number);
  return Number.isInteger(n) ? n : null;
}

export interface SnapshotExtract {
  lastRound: number | null;
  referenceRound: number | null;
  referencePriceUsd: string | null;
  superValidators: number | null;
  svVotingThreshold: number | null;
  featuredApps: number;
  validatorLicenses: number | null;
}

export function extractSnapshot(input: {
  dsoRules: AcsCreatedEvent[];
  openRounds: AcsCreatedEvent[];
  issuingRounds: AcsCreatedEvent[];
  featuredApps: AcsCreatedEvent[];
  validatorLicenses: AcsCreatedEvent[] | null;
}): SnapshotExtract {
  const dso = only(input.dsoRules, TEMPLATES.dsoRules);
  const members = dso.length === 1 ? countSvs(dso[0].create_arguments) : null;

  let referenceRound: number | null = null;
  let referencePriceUsd: string | null = null;
  for (const e of only(input.openRounds, TEMPLATES.openRound)) {
    const n = roundOf(e.create_arguments);
    if (n == null || (referenceRound != null && n <= referenceRound)) continue;
    referenceRound = n;
    const price = e.create_arguments.amuletPrice;
    referencePriceUsd = typeof price === "string" ? price : null;
  }

  let lastRound: number | null = null;
  for (const e of only(input.issuingRounds, TEMPLATES.issuingRound)) {
    const n = roundOf(e.create_arguments);
    if (n != null && (lastRound == null || n > lastRound)) lastRound = n;
  }

  return {
    lastRound,
    referenceRound,
    referencePriceUsd,
    superValidators: members,
    svVotingThreshold: members != null && members > 0 ? requiredNumVotes(members) : null,
    featuredApps: only(input.featuredApps, TEMPLATES.featuredApp).length,
    validatorLicenses: input.validatorLicenses ? only(input.validatorLicenses, TEMPLATES.validatorLicense).length : null,
  };
}
