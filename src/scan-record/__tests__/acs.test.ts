import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATES, extractSnapshot, requiredNumVotes, type AcsCreatedEvent } from "../acs";

const acs = JSON.parse(
  readFileSync(join(process.cwd(), "src/scan-record/__tests__/fixtures/acs-snapshot-2026-06-01.json"), "utf-8"),
) as Record<string, { created_events: AcsCreatedEvent[] }>;
const events = (t: string) => acs[t].created_events;

describe("requiredNumVotes (Splice DsoRules.daml summarizeDso)", () => {
  it("matches the live network and the formula's small cases", () => {
    expect(requiredNumVotes(13)).toBe(9); // /v0/dso voting_threshold on 2026-09-25
    expect(requiredNumVotes(4)).toBe(3);
    expect(requiredNumVotes(16)).toBe(11);
    expect(requiredNumVotes(1)).toBe(1);
  });
});

describe("extractSnapshot", () => {
  it("reads every snapshot series from one instant", () => {
    const x = extractSnapshot({
      dsoRules: events(TEMPLATES.dsoRules),
      openRounds: events(TEMPLATES.openRound),
      issuingRounds: events(TEMPLATES.issuingRound),
      featuredApps: events(TEMPLATES.featuredApp),
      validatorLicenses: events(TEMPLATES.validatorLicense),
    });
    expect(x).toEqual({
      lastRound: 98370,
      referenceRound: 98373,
      referencePriceUsd: "0.1560",
      superValidators: 4,
      svVotingThreshold: 3,
      featuredApps: 3,
      validatorLicenses: 2,
    });
  });

  it("leaves licenses null when they were not read, and ignores events of other templates", () => {
    const x = extractSnapshot({
      dsoRules: events(TEMPLATES.dsoRules),
      openRounds: events(TEMPLATES.openRound),
      issuingRounds: events(TEMPLATES.issuingRound),
      featuredApps: [...events(TEMPLATES.featuredApp), ...events(TEMPLATES.dsoRules)],
      validatorLicenses: null,
    });
    expect(x.featuredApps).toBe(3);
    expect(x.validatorLicenses).toBeNull();
  });

  it("refuses to count members when the snapshot does not hold exactly one DsoRules", () => {
    const x = extractSnapshot({
      dsoRules: [],
      openRounds: events(TEMPLATES.openRound),
      issuingRounds: events(TEMPLATES.issuingRound),
      featuredApps: events(TEMPLATES.featuredApp),
      validatorLicenses: null,
    });
    expect(x.superValidators).toBeNull();
    expect(x.svVotingThreshold).toBeNull();
  });
});
