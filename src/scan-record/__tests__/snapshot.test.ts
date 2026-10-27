import { describe, expect, it } from "vitest";
import { CURSOR_FORWARD, CURSOR_SNAPSHOT } from "../../open-record/contract";
import { TEMPLATES, type AcsCreatedEvent } from "../acs";
import { SCAN_BUDGET, ScanBusyError, scanSlotMaxWaitMs, type ScanCallClass } from "../scan-budget";
import { SCAN_TIMEOUT_MS, ScanHttpError, scanCallWorstCaseMs } from "../scan-client";
import type { ScanApi } from "../scan-client";
import {
  SNAPSHOT_RETRY,
  licenseReadHeadroomMs,
  readLicenseCount,
  readSnapshot,
  runSnapshotStage,
  snapshotCoreHeadroomMs,
  snapshotStageHealth,
  type SnapshotHealth,
  type SnapshotStageResult,
} from "../snapshot";
import type { CursorRow, RecordStore, SnapshotRow } from "../store";
import { snapshotRow } from "./helpers/day-builders";
import { fakeScan, loadFixture } from "./helpers/fake-scan";
import { memoryStore } from "./helpers/memory-store";

const acs = loadFixture("acs-snapshot-2026-06-01.json");
const acsCalls = (calls: string[]) => calls.filter((c) => c.startsWith("acs "));
const notFound = () => new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "not found");
const at = (iso: string) => new Date(iso);
const OTHER_HOST = "scan.example.org";
const WORST = scanCallWorstCaseMs("record");
const SPACING = SCAN_BUDGET.spacingMs;
/**
 * The live queue at its slowest for a core read: the first call waits the
 * class's whole slot wait, each later one starts one spacing after the one
 * before, and every answer ends 1 ms short of the timeout.
 */
const slowest = (cls: ScanCallClass) => ({
  startMs: 0, callMs: SCAN_TIMEOUT_MS - 1, spacingMs: SPACING, firstWaitMs: scanSlotMaxWaitMs(cls),
});
/** For the tests that are not about the deadline: every call ends in time. */
const NO_DEADLINE = Number.POSITIVE_INFINITY;
const license = acs[TEMPLATES.validatorLicense].created_events[0];
/** Answers that must never become a count: empty, mixed with another template, or a changed template id. */
const badLicenseAnswers: Array<[string, AcsCreatedEvent[], string]> = [
  ["an empty answer", [], "incomplete: no ValidatorLicense"],
  ["an answer mixed with another template", [license, acs[TEMPLATES.featuredApp].created_events[0]], "another template id"],
  ["a template id of another shape", [{ ...license, template_id: "Splice.ValidatorLicense.ValidatorLicense" }], "another template id"],
];
/** Yesterday's row as the backfill writes it at 02:00 on 2026-10-06: no licenses. */
const backfilled = (extra: Partial<SnapshotRow> = {}): SnapshotRow => ({
  date: "2026-10-05", record_time: "2026-10-06T00:00:00Z", migration_id: 4, source_host: "api.cantonnodes.com",
  method: "scan-1", last_round: 98370, reference_round: 98373, reference_price_usd: "0.1560",
  super_validators: 4, sv_voting_threshold: 3, featured_apps: 3, validator_licenses: null, ...extra,
});

describe("readSnapshot", () => {
  it("reads the five templates at D+1 00:00:00Z into one snapshot row", async () => {
    const scan = fakeScan({ acs });
    const row = await readSnapshot(scan, 4, "2026-06-01", { withLicenses: true });
    expect(row).toEqual({
      date: "2026-06-01", record_time: "2026-06-02T00:00:00Z", migration_id: 4, source_host: "api.cantonnodes.com",
      method: "scan-1", last_round: 98370, reference_round: 98373, reference_price_usd: "0.1560",
      super_validators: 4, sv_voting_threshold: 3, featured_apps: 3, validator_licenses: 2,
    });
    expect(scan.calls.filter((c) => c.startsWith("acs 2026-06-02T00:00:00Z"))).toHaveLength(5);
  });

  it("skips licenses when asked (backfill), leaving them null", async () => {
    const scan = fakeScan({ acs });
    const row = await readSnapshot(scan, 4, "2026-06-01", { withLicenses: false });
    expect(row.validator_licenses).toBeNull();
    expect(scan.calls.some((c) => c.includes("ValidatorLicense"))).toBe(false);
  });

  it("refuses an incomplete snapshot instead of storing holes", async () => {
    const scan = fakeScan({ acs: { ...acs, "splice-dso-governance:Splice.DsoRules:DsoRules": { created_events: [] } } });
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: false })).rejects.toThrow("incomplete");
  });

  it("refuses a DsoRules with no members, which would store a count with no voting threshold", async () => {
    const dso = acs[TEMPLATES.dsoRules].created_events[0];
    const empty = { ...dso, create_arguments: { ...dso.create_arguments, svs: [] } };
    const scan = fakeScan({ acs: { ...acs, [TEMPLATES.dsoRules]: { created_events: [empty] } } });
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: false })).rejects.toThrow("incomplete");
  });

  it.each([
    ["a second DsoRules contract", TEMPLATES.dsoRules, [acs[TEMPLATES.dsoRules].created_events[0], acs[TEMPLATES.dsoRules].created_events[0]], 1],
    ["no OpenMiningRound", TEMPLATES.openRound, [], 2],
    ["no IssuingMiningRound", TEMPLATES.issuingRound, [], 3],
    ["no FeaturedAppRight, which is a hole and not a count of 0", TEMPLATES.featuredApp, [], 4],
  ])("stops at %s right after its own call instead of spending the rest", async (_label, template, events, spent) => {
    const scan = fakeScan({ acs: { ...acs, [template]: { created_events: events } } });
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: true })).rejects.toThrow("incomplete");
    expect(acsCalls(scan.calls)).toHaveLength(spent);
  });

  it.each(badLicenseAnswers)("refuses ValidatorLicense as %s instead of counting what is left", async (_label, events, error) => {
    const scan = fakeScan({ acs: { ...acs, [TEMPLATES.validatorLicense]: { created_events: events } } });
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: true })).rejects.toThrow(error);
  });

  it("refuses an answer carrying another template for any of the core templates", async () => {
    const open = acs[TEMPLATES.openRound].created_events;
    const scan = fakeScan({ acs: { ...acs, [TEMPLATES.openRound]: { created_events: [...open, license] } } });
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: false })).rejects.toThrow(
      "1 of 4 OpenMiningRound events carry another template id",
    );
    expect(acsCalls(scan.calls)).toHaveLength(2);
  });

  it("asks only the host that answered DsoRules, so a host gated mid-snapshot is busy, not a failure", async () => {
    // FeaturedAppRight would fall back to another host; pinned, it reports busy before it is dialled.
    const scan = fakeScan({ acs, acsHosts: { [TEMPLATES.featuredApp]: OTHER_HOST } });
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: true })).rejects.toBeInstanceOf(ScanBusyError);
    expect(acsCalls(scan.calls)).toHaveLength(3);
  });

  it("refuses before DsoRules when the deadline cannot cover the whole core read", async () => {
    const scan = fakeScan({ acs, clock: { startMs: 0, callMs: 30_000 } });
    await expect(
      readSnapshot(scan, 4, "2026-06-01", { withLicenses: false, deadline: snapshotCoreHeadroomMs() - 1 }),
    ).rejects.toBeInstanceOf(ScanBusyError);
    expect(scan.calls).toEqual([]);
  });

  it("refuses before DsoRules a read that starts just inside the old headroom but waits for its slot, instead of spending three calls and failing busy at FeaturedAppRight", async () => {
    // The old headroom: the first call's worst case and three starts one spacing apart.
    const oldHeadroom = WORST + 3 * SPACING;
    // DsoRules waits one spacing for its slot (a call just before it holds the queue) and every answer takes 2 s.
    const scan = fakeScan({ acs, clock: { startMs: 0, callMs: 2_000, spacingMs: SPACING, firstWaitMs: SPACING } });
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: false, deadline: oldHeadroom })).rejects.toBeInstanceOf(
      ScanBusyError,
    );
    expect(scan.calls).toEqual([]);
  });

  it.each(["record", "backfill"] as const)(
    "gives a %s read exactly its headroom: every core call passes at the slowest queue, and 1 ms less spends none",
    async (cls) => {
      const scan = fakeScan({ acs, cls, clock: slowest(cls) });
      const row = await readSnapshot(scan, 4, "2026-06-01", { withLicenses: false, deadline: snapshotCoreHeadroomMs(cls) });
      expect(row.featured_apps).toBe(3);
      expect(acsCalls(scan.calls)).toHaveLength(4);

      const short = fakeScan({ acs, cls, clock: slowest(cls) });
      await expect(
        readSnapshot(short, 4, "2026-06-01", { withLicenses: false, deadline: snapshotCoreHeadroomMs(cls) - 1 }),
      ).rejects.toBeInstanceOf(ScanBusyError);
      expect(short.calls).toEqual([]);
    },
  );

  it("holds a read with licenses to the license call too, so it never spends the core and fails busy at the last call", async () => {
    const deadline = snapshotCoreHeadroomMs() + SPACING;
    const scan = fakeScan({ acs, clock: slowest("record") });
    expect((await readSnapshot(scan, 4, "2026-06-01", { withLicenses: true, deadline })).validator_licenses).toBe(2);
    expect(acsCalls(scan.calls)).toHaveLength(5);

    const short = fakeScan({ acs, clock: slowest("record") });
    await expect(readSnapshot(short, 4, "2026-06-01", { withLicenses: true, deadline: deadline - 1 })).rejects.toBeInstanceOf(
      ScanBusyError,
    );
    expect(short.calls).toEqual([]);
  });

  it("still refuses a snapshot answered by different hosts when a Scan ignores the pin", async () => {
    const base = fakeScan({ acs });
    const scan: ScanApi = {
      ...base,
      async acsSnapshot(migrationId, recordTime, template) {
        const r = await base.acsSnapshot(migrationId, recordTime, template);
        return template === TEMPLATES.featuredApp ? { ...r, host: "scan.example.org" } : r;
      },
    };
    await expect(readSnapshot(scan, 4, "2026-06-01", { withLicenses: true })).rejects.toThrow(
      "api.cantonnodes.com, scan.example.org",
    );
  });
});

describe("runSnapshotStage", () => {
  it("waits until 00:15 UTC, then writes yesterday once", async () => {
    const { store, state } = memoryStore();
    const scan = fakeScan({ acs });
    expect(await runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T00:10:00Z"), deadline: NO_DEADLINE }))
      .toEqual({ date: "2026-10-05", state: "not_due" });
    expect(await runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T00:20:00Z"), deadline: NO_DEADLINE }))
      .toEqual({ date: "2026-10-05", state: "written" });
    expect(state.snapshots.get("2026-10-05")?.record_time).toBe("2026-10-06T00:00:00Z");
    expect(await runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T00:25:00Z"), deadline: NO_DEADLINE }))
      .toEqual({ date: "2026-10-05", state: "already" });
  });

  it("reports a snapshot Scan cannot serve yet as failed, and writes nothing", async () => {
    const { store, state } = memoryStore();
    const scan = fakeScan({ acs, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "not found") });
    const r = await runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T00:20:00Z"), deadline: NO_DEADLINE });
    expect(r.state).toBe("failed");
    expect(r.detail).toContain("404");
    expect(state.snapshots.size).toBe(0);
  });

  it("adds validator licenses to a row the backfill stored without them, with one call", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set("2026-10-05", backfilled());
    const scan = fakeScan({ acs });
    expect(await runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T02:10:00Z"), deadline: NO_DEADLINE })).toEqual({
      date: "2026-10-05", state: "written", detail: "added validator licenses to a row stored without them",
    });
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled({ validator_licenses: 2 }));
    expect(acsCalls(scan.calls)).toEqual([`acs 2026-10-06T00:00:00Z ${TEMPLATES.validatorLicense}`]);

    const again = fakeScan({ acs });
    expect(await runSnapshotStage({ store, scan: again, migrationId: 4, now: new Date("2026-10-06T02:15:00Z"), deadline: NO_DEADLINE }))
      .toEqual({ date: "2026-10-05", state: "already" });
    expect(again.calls).toEqual([]);
  });

  it("reads the missing licenses only from the host the row names: a configured host whose gate is open is busy", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set("2026-10-05", backfilled({ source_host: OTHER_HOST }));
    // OTHER_HOST is configured but gated: unpinned, the answer would come from api.cantonnodes.com.
    const scan = fakeScan({ acs, hosts: ["api.cantonnodes.com", OTHER_HOST] });
    await expect(runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T02:10:00Z"), deadline: NO_DEADLINE }))
      .rejects.toBeInstanceOf(ScanBusyError);
    expect(scan.calls).toEqual([]);
    expect(state.snapshots.get("2026-10-05")?.validator_licenses).toBeNull();
    expect(state.cursors.size).toBe(0);
  });

  it("fails, then gives up on the licenses alone, on a row whose host is not in SCAN_RECORD_HOSTS, never asking another host", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set("2026-10-05", backfilled({ source_host: OTHER_HOST }));
    let t = Date.parse("2026-10-06T00:20:00Z");
    for (let i = 1; i <= SNAPSHOT_RETRY.maxAttempts; i++) {
      const scan = fakeScan({ acs });
      const r = await runSnapshotStage({ store, scan, migrationId: 4, now: new Date(t), deadline: NO_DEADLINE });
      expect(r.state).toBe("failed");
      expect(r.detail).toContain(`${OTHER_HOST} is not in SCAN_RECORD_HOSTS`);
      expect(scan.calls).toEqual([]);
      t += SNAPSHOT_RETRY.backoffMs;
    }
    const idle = fakeScan({ acs });
    // The core row is stored: only its license count is lost, a wait for the day, not a failure every run.
    const r = await runSnapshotStage({ store, scan: idle, migrationId: 4, now: new Date(t), deadline: NO_DEADLINE });
    expect(r).toMatchObject({ date: "2026-10-05", state: "licenses_gave_up" });
    expect(r.detail).toContain(`gave up after ${SNAPSHOT_RETRY.maxAttempts} failed attempts`);
    expect(snapshotStageHealth(r)).toBe("neutral");
    expect(idle.calls).toEqual([]);
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled({ source_host: OTHER_HOST }));
  });

  it("keeps the stored row when the missing licenses cannot be read", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set("2026-10-05", backfilled());
    const scan = fakeScan({ acs, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "not found") });
    const r = await runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T02:10:00Z"), deadline: NO_DEADLINE });
    expect(r.state).toBe("failed");
    expect(r.detail).toContain("404");
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled());
  });

  it("hands a busy budget to the caller instead of calling it a failure, and writes nothing", async () => {
    const { store, state } = memoryStore();
    const scan = fakeScan({ acs, error: new ScanBusyError("api.cantonnodes.com", "gate") });
    await expect(runSnapshotStage({ store, scan, migrationId: 4, now: new Date("2026-10-06T00:20:00Z"), deadline: NO_DEADLINE }))
      .rejects.toBeInstanceOf(ScanBusyError);
    expect(state.snapshots.size).toBe(0);
    expect(state.cursors.size).toBe(0);
  });

  it("stores the four core templates first, backs off after a failed license read, then adds them with one call", async () => {
    const { store, state } = memoryStore();
    const first = fakeScan({ acs, acsErrors: { [TEMPLATES.validatorLicense]: notFound() } });
    const r = await runSnapshotStage({ store, scan: first, migrationId: 4, now: at("2026-10-06T00:20:00Z"), deadline: NO_DEADLINE });
    expect(r.state).toBe("failed");
    expect(r.detail).toContain("stored without validator licenses");
    expect(r.detail).toContain("404");
    expect(acsCalls(first.calls)).toHaveLength(5);
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled());

    const idle = fakeScan({ acs });
    const wait = await runSnapshotStage({ store, scan: idle, migrationId: 4, now: at("2026-10-06T00:45:00Z"), deadline: NO_DEADLINE });
    expect(wait.state).toBe("waiting");
    expect(wait.detail).toContain("2026-10-06T00:50:00.000Z");
    expect(idle.calls).toEqual([]);

    const later = fakeScan({ acs });
    expect(await runSnapshotStage({ store, scan: later, migrationId: 4, now: at("2026-10-06T00:50:00Z"), deadline: NO_DEADLINE })).toEqual({
      date: "2026-10-05", state: "written", detail: "added validator licenses to a row stored without them",
    });
    expect(acsCalls(later.calls)).toEqual([`acs 2026-10-06T00:00:00Z ${TEMPLATES.validatorLicense}`]);
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled({ validator_licenses: 2 }));
    expect(state.cursors.get(CURSOR_SNAPSHOT)?.detail).toEqual({});
  });

  it("gives up after SNAPSHOT_RETRY.maxAttempts failed attempts, spends nothing more that day, and starts over the next", async () => {
    const { store, state } = memoryStore();
    let t = Date.parse("2026-10-06T00:15:00Z");
    for (let i = 1; i <= SNAPSHOT_RETRY.maxAttempts; i++) {
      const scan = fakeScan({ acs, acsError: notFound() });
      const r = await runSnapshotStage({ store, scan, migrationId: 4, now: new Date(t), deadline: NO_DEADLINE });
      expect(r.state).toBe("failed");
      expect(r.detail).toContain(`attempt ${i} of ${SNAPSHOT_RETRY.maxAttempts}`);
      expect(acsCalls(scan.calls)).toHaveLength(1);
      t += SNAPSHOT_RETRY.backoffMs;
    }

    const idle = fakeScan({ acs });
    const r = await runSnapshotStage({ store, scan: idle, migrationId: 4, now: at("2026-10-06T23:55:00Z"), deadline: NO_DEADLINE });
    expect(r).toMatchObject({ date: "2026-10-05", state: "gave_up" });
    expect(r.detail).toContain("404");
    expect(idle.calls).toEqual([]);
    expect(state.snapshots.size).toBe(0);

    const next = fakeScan({ acs });
    expect(await runSnapshotStage({ store, scan: next, migrationId: 4, now: at("2026-10-07T00:20:00Z"), deadline: NO_DEADLINE }))
      .toEqual({ date: "2026-10-06", state: "written" });
    expect(state.cursors.get(CURSOR_SNAPSHOT)).toMatchObject({ last_date: "2026-10-06", detail: {} });
    expect(state.cursors.get(CURSOR_SNAPSHOT)?.detail).toEqual({});
  });

  it("keeps its attempts on its own cursor row, which the collector's cursor writes neither erase nor lose", async () => {
    const { store, state } = memoryStore();
    // The forward cursor as the collector writes it on every run: nothing of this stage in it.
    const forward = (lastRound: number, pollAt: string): CursorRow => ({
      id: CURSOR_FORWARD, last_round: lastRound, last_date: null, last_poll_at: pollAt,
      detail: { started_at: "2026-10-01T00:00:00Z", repair_attempts: { "114500": 1 } },
    });
    const failing = () => fakeScan({ acs, acsError: notFound() });
    await store.setCursor(forward(114512, "2026-10-06T00:20:00.000Z"));
    const first = await runSnapshotStage({ store, scan: failing(), migrationId: 4, now: at("2026-10-06T00:20:00Z"), deadline: NO_DEADLINE });
    expect(first.detail).toContain(`attempt 1 of ${SNAPSHOT_RETRY.maxAttempts}`);
    expect(state.cursors.get(CURSOR_SNAPSHOT)).toEqual({
      id: CURSOR_SNAPSHOT, last_round: null, last_date: "2026-10-05", last_poll_at: "2026-10-06T00:20:00.000Z",
      detail: { attempts: 1, next_try_at: "2026-10-06T00:50:00.000Z", last_error: expect.stringContaining("404") },
    });
    expect(state.cursors.get(CURSOR_FORWARD)).toEqual(forward(114512, "2026-10-06T00:20:00.000Z"));

    // Collector runs in between rewrite the forward cursor from their own state.
    await store.setCursor(forward(114520, "2026-10-06T00:45:00.000Z"));
    const second = await runSnapshotStage({ store, scan: failing(), migrationId: 4, now: at("2026-10-06T00:50:00Z"), deadline: NO_DEADLINE });
    expect(second.detail).toContain(`attempt 2 of ${SNAPSHOT_RETRY.maxAttempts}`);
    expect(state.cursors.get(CURSOR_SNAPSHOT)?.detail).toMatchObject({ attempts: 2, next_try_at: "2026-10-06T01:20:00.000Z" });
    expect(state.cursors.get(CURSOR_FORWARD)).toEqual(forward(114520, "2026-10-06T00:45:00.000Z"));

    await store.setCursor(forward(114530, "2026-10-06T01:15:00.000Z"));
    const idle = fakeScan({ acs });
    expect((await runSnapshotStage({ store, scan: idle, migrationId: 4, now: at("2026-10-06T01:15:00Z"), deadline: NO_DEADLINE })).state)
      .toBe("waiting");
    expect(idle.calls).toEqual([]);

    await runSnapshotStage({ store, scan: fakeScan({ acs }), migrationId: 4, now: at("2026-10-06T01:20:00Z"), deadline: NO_DEADLINE });
    expect(state.cursors.get(CURSOR_SNAPSHOT)).toEqual({
      id: CURSOR_SNAPSHOT, last_round: null, last_date: "2026-10-05", last_poll_at: "2026-10-06T01:20:00.000Z", detail: {},
    });
    expect(state.cursors.get(CURSOR_FORWARD)).toEqual(forward(114530, "2026-10-06T01:15:00.000Z"));
  });

  it.each(badLicenseAnswers)("keeps the row without licenses when the heal read returns %s", async (_label, events, error) => {
    const { store, state } = memoryStore();
    state.snapshots.set("2026-10-05", backfilled());
    const scan = fakeScan({ acs: { ...acs, [TEMPLATES.validatorLicense]: { created_events: events } } });
    const r = await runSnapshotStage({ store, scan, migrationId: 4, now: at("2026-10-06T02:10:00Z"), deadline: NO_DEADLINE });
    expect(r.state).toBe("failed");
    expect(r.detail).toContain(error);
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled());
  });

  it.each([
    ["DsoRules alone", WORST + 10_000],
    ["all but the last core template", snapshotCoreHeadroomMs() - 1],
  ])("refuses a core read whose deadline covers %s before its first call: no call spent, nothing stored, no attempt", async (_label, deadline) => {
    const { store, state } = memoryStore();
    const scan = fakeScan({ acs, clock: { startMs: 0, callMs: 30_000 } });
    await expect(
      runSnapshotStage({ store, scan, migrationId: 4, now: at("2026-10-06T00:20:00Z"), deadline }),
    ).rejects.toBeInstanceOf(ScanBusyError);
    expect(scan.calls).toEqual([]);
    expect(state.snapshots.size).toBe(0);
    expect(state.cursors.size).toBe(0);
  });

  it("keeps the core row when the deadline cuts off the license read, and the next run adds the licenses", async () => {
    const { store, state } = memoryStore();
    // Exactly the core headroom at the longest first wait: slots at 70, 100, 130 and 160 s, each answered in 1 s.
    // FeaturedAppRight is asked at 131 s and passes; the license read, asked at 161 s, would end past the deadline.
    const scan = fakeScan({
      acs, clock: { startMs: 0, callMs: 1_000, spacingMs: SPACING, firstWaitMs: scanSlotMaxWaitMs("record") },
    });
    await expect(
      runSnapshotStage({ store, scan, migrationId: 4, now: at("2026-10-06T00:20:00Z"), deadline: snapshotCoreHeadroomMs() }),
    ).rejects.toBeInstanceOf(ScanBusyError);
    expect(acsCalls(scan.calls)).toHaveLength(4);
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled());

    const next = fakeScan({ acs });
    expect(await runSnapshotStage({ store, scan: next, migrationId: 4, now: at("2026-10-06T00:25:00Z"), deadline: NO_DEADLINE })).toEqual({
      date: "2026-10-05", state: "written", detail: "added validator licenses to a row stored without them",
    });
  });

  it("refuses the heal path's license read when the deadline cannot cover it", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set("2026-10-05", backfilled());
    const scan = fakeScan({ acs, clock: { startMs: 0, callMs: 30_000 } });
    await expect(
      runSnapshotStage({ store, scan, migrationId: 4, now: at("2026-10-06T02:10:00Z"), deadline: WORST - 1 }),
    ).rejects.toBeInstanceOf(ScanBusyError);
    expect(scan.calls).toEqual([]);
    expect(state.snapshots.get("2026-10-05")).toEqual(backfilled());
  });
});

describe("runSnapshotStage past 04:00 UTC", () => {
  it.each([
    ["an open 429 gate", () => fakeScan({ acs, error: new ScanBusyError("api.cantonnodes.com", "gate") }), NO_DEADLINE],
    [
      "a deadline short of the core read",
      () => fakeScan({ acs, clock: { startMs: 0, callMs: 30_000 } }),
      snapshotCoreHeadroomMs() - 1,
    ],
  ])("reports a day still unread at 04:00 because of %s as starved, which pages, and counts no attempt", async (_label, make, deadline) => {
    const { store, state } = memoryStore();
    await expect(runSnapshotStage({ store, scan: make(), migrationId: 4, now: at("2026-10-06T03:59:00Z"), deadline }))
      .rejects.toBeInstanceOf(ScanBusyError);

    const r = await runSnapshotStage({ store, scan: make(), migrationId: 4, now: at("2026-10-06T04:00:00Z"), deadline });
    expect(r).toMatchObject({ date: "2026-10-05", state: "starved" });
    expect(r.detail).toContain("busy");
    expect(snapshotStageHealth(r)).toBe("failing");
    expect(state.snapshots.size).toBe(0);
    expect(state.cursors.size).toBe(0);
  });

  it("counts a backoff still running at 04:00 with no row as starved, not waiting", async () => {
    const { store } = memoryStore();
    const failed = await runSnapshotStage({
      store, scan: fakeScan({ acs, acsError: notFound() }), migrationId: 4, now: at("2026-10-06T03:50:00Z"), deadline: NO_DEADLINE,
    });
    expect(failed.state).toBe("failed");

    const idle = fakeScan({ acs });
    const r = await runSnapshotStage({ store, scan: idle, migrationId: 4, now: at("2026-10-06T04:05:00Z"), deadline: NO_DEADLINE });
    expect(r.state).toBe("starved");
    expect(r.detail).toContain("next try at 2026-10-06T04:20:00.000Z");
    expect(snapshotStageHealth(r)).toBe("failing");
    expect(idle.calls).toEqual([]);
  });

  it("keeps a busy or backed-off license read a wait when the core row is stored", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set("2026-10-05", backfilled());
    const busy = fakeScan({ acs, error: new ScanBusyError("api.cantonnodes.com", "gate") });
    await expect(runSnapshotStage({ store, scan: busy, migrationId: 4, now: at("2026-10-06T05:00:00Z"), deadline: NO_DEADLINE }))
      .rejects.toBeInstanceOf(ScanBusyError);

    const failing = fakeScan({ acs, acsError: notFound() });
    expect((await runSnapshotStage({ store, scan: failing, migrationId: 4, now: at("2026-10-06T05:05:00Z"), deadline: NO_DEADLINE })).state)
      .toBe("failed");
    expect((await runSnapshotStage({ store, scan: fakeScan({ acs }), migrationId: 4, now: at("2026-10-06T05:10:00Z"), deadline: NO_DEADLINE })).state)
      .toBe("waiting");
  });
});

describe("runSnapshotStage when the attempt cannot be recorded", () => {
  it("rethrows an error that names both the Scan failure and the store failure", async () => {
    const { store } = memoryStore();
    const broken: RecordStore = {
      ...store,
      async setCursor() {
        throw new Error("[scan-record] write cursor: 57014 canceling statement due to statement timeout");
      },
    };
    const scan = fakeScan({ acs, acsError: notFound() });
    const err = await runSnapshotStage({ store: broken, scan, migrationId: 4, now: at("2026-10-06T00:20:00Z"), deadline: NO_DEADLINE })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("404");
    expect((err as Error).message).toContain("57014");
  });
});

describe("snapshotCoreHeadroomMs", () => {
  it("covers the DsoRules slot wait, two more slots one spacing apart, the third answer and the last call's own worst case", () => {
    for (const cls of ["record", "backfill"] as const) {
      expect(snapshotCoreHeadroomMs(cls)).toBe(
        scanSlotMaxWaitMs(cls) + 2 * SPACING + SCAN_TIMEOUT_MS + scanCallWorstCaseMs(cls),
      );
    }
    // 70 + 60 + 30 + 100 s, and 130 + 60 + 30 + 160 s.
    expect(snapshotCoreHeadroomMs()).toBe(260_000);
    expect(snapshotCoreHeadroomMs("backfill")).toBe(380_000);
  });
});

/** Every state, so a new one fails the typecheck until it is counted here. */
const HEALTH_OF: Record<SnapshotStageResult["state"], SnapshotHealth> = {
  failed: "failing",
  gave_up: "failing",
  starved: "failing",
  waiting: "neutral",
  licenses_gave_up: "neutral",
  not_due: "healthy",
  already: "healthy",
  written: "healthy",
};

describe("snapshotStageHealth", () => {
  it.each(Object.entries(HEALTH_OF) as Array<[SnapshotStageResult["state"], SnapshotHealth]>)("counts %s as %s", (state, health) => {
    expect(snapshotStageHealth({ date: "2026-10-05", state })).toBe(health);
  });
});

describe("the license completion read", () => {
  it("reads the count at the row's own record time, host and migration", async () => {
    const scan = fakeScan({ acs: loadFixture("acs-snapshot-2026-06-01.json"), cls: "backfill" });
    const row = snapshotRow("2026-05-31", 94000, { validator_licenses: null });
    await expect(readLicenseCount(scan, row, Date.now() + 600_000)).resolves.toBe(2);
    expect(scan.calls).toEqual(["acs 2026-06-01T00:00:00Z splice-amulet:Splice.ValidatorLicense:ValidatorLicense"]);
  });

  it("leaves a two-page read room before a deadline: 320 s in the backfill class", () => {
    expect(licenseReadHeadroomMs("backfill")).toBe(320_000);
    expect(licenseReadHeadroomMs("record")).toBe(200_000);
  });
});
