import { scanSourceOutcomes } from "../health";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = new Map<string, unknown>();
const alerts: Array<{ severity: string; title: string; message: string }> = [];
/** What sendPage was asked to page: the finalize configs page the operator, the rest go to the summary (sendAlert). */
const pages: Array<{ kind: string; title: string; message: string }> = [];
/** What sendAlert and sendPage answer; false is a send the alert sink did not take. */
let delivered = true;

vi.mock("../../runtime/cache-store", () => ({
  getCacheEntry: async (key: string) =>
    cache.has(key) ? { status: "hit", value: cache.get(key), updatedAt: null } : { status: "miss" },
  setCached: async (key: string, value: unknown) => {
    cache.set(key, value);
  },
}));
vi.mock("../../runtime/alerts", () => ({
  sendAlert: async (severity: string, title: string, message: string) => {
    alerts.push({ severity, title, message });
    return delivered;
  },
  sendPage: async (kind: string, title: string, message: string) => {
    pages.push({ kind, title, message });
    return delivered;
  },
}));

import { checkFeedHealth } from "../../runtime/feed-health";
import { SERIES_NAMES, type SeriesName } from "../../open-record/contract";
import { COLLECTOR_LIMITS, type ForwardResult } from "../collector";
import type { FinalizeResult, SeriesState } from "../finalize";
import {
  COLLECTOR_HEALTH,
  FINALIZE_HEALTH,
  FINALIZE_LOCK_HEALTH,
  LICENSES_ALERT_KEY,
  LICENSES_GAVE_UP_TITLE,
  ROUNDS_ABANDONED_TITLE,
  ROUNDS_ALERT_KEY,
  collectorAlertPolicy,
  collectorLossAlerts,
  collectorOutcomes,
  finalizeLockOutcomes,
  finalizeOutcomes,
} from "../health";
import type { SnapshotStageResult } from "../snapshot";

/** A complete run that captured every issuing round. */
const run = (over: Partial<ForwardResult> = {}): ForwardResult => ({
  ok: true, host: "api.cantonnodes.com", migration_id: 4, open_rounds: [114683], issuing_rounds: [114513],
  captured: [114513], not_located: [], locate_errors: [], locate_deferred: [], repaired: [], missing: [],
  repair_errors: [], repair_waiting: 0, repair_deferred: null, unanchored: 0, abandoned: [], abandoned_total: 0,
  given_up: null, cursor: 114513, snapshot: null, snapshot_deferred: null, snapshot_error: null, busy: null,
  stalled: null, errors: [], ...over,
});
/** A run whose round collection failed before the snapshot stage. */
const roundsDown = () => run({ ok: false, host: null, captured: [], cursor: null, errors: ["open-and-issuing returned no rounds"] });
const stage = (state: SnapshotStageResult["state"], detail?: string): SnapshotStageResult => ({ date: "2026-10-05", state, detail });
const gaveUp = () => run({ ok: false, snapshot: stage("gave_up", "gave up after 8 failed attempts: 404 not found") });
const AFTER_GRACE = Date.parse("2026-10-06T06:10:00Z");
const IN_GRACE = Date.parse("2026-10-06T00:20:00Z");
const outcome = (r: ForwardResult, id: string, nowMs = AFTER_GRACE) => collectorOutcomes(r, nowMs).find((o) => o.id === id)!;

beforeEach(() => {
  cache.clear();
  alerts.length = 0;
  pages.length = 0;
  delivered = true;
});

describe("scanSourceOutcomes", () => {
  const SV = "scan.sv-9.global.canton.network.example.invalid";
  const list = [SV, "api.cantonnodes.com"];

  it("has nothing to say while the list names no Super Validator", () => {
    expect(scanSourceOutcomes(["api.cantonnodes.com"], { host: "api.cantonnodes.com", at: "2026-11-08T00:00:00Z" })).toEqual([]);
  });

  it("counts nothing when no read happened lately", () => {
    expect(scanSourceOutcomes(list, null)).toEqual([expect.objectContaining({ id: "scan-source", skipped: true })]);
  });

  it("is fine on any Super Validator, the first or another", () => {
    expect(scanSourceOutcomes(list, { host: SV, at: "2026-11-08T00:00:00Z" })).toEqual([expect.objectContaining({ ok: true })]);
    expect(scanSourceOutcomes(list, { host: "scan.sv-1.global.canton.network.other.invalid", at: "2026-11-08T00:00:00Z" })[0].ok).toBe(true);
  });

  it("takes the Scan host list's URLs as well as host names", () => {
    const urls = [`https://${SV}/api/scan`, "https://api.cantonnodes.com"];
    expect(scanSourceOutcomes(urls, { host: "api.cantonnodes.com", at: "2026-11-08T00:00:00Z" })).toEqual([expect.objectContaining({ ok: false })]);
    expect(scanSourceOutcomes(["https://api.cantonnodes.com"], null)).toEqual([]);
  });

  it("says when a 429 closed the Super Validators, since that is hours, not minutes", () => {
    const [o] = scanSourceOutcomes(list, { host: "api.cantonnodes.com", at: "2026-11-08T00:00:00Z" }, "2026-11-08T06:00:00.000Z");
    expect(o.detail).toContain("closed until 2026-11-08T06:00:00.000Z after a 429");
  });

  it("fails on a public host, naming it and when", () => {
    const [o] = scanSourceOutcomes(list, { host: "api.cantonnodes.com", at: "2026-11-08T00:00:00Z" });
    expect(o.ok).toBe(false);
    expect(o.detail).toContain("api.cantonnodes.com");
    expect(o.detail).toContain("2026-11-08T00:00:00Z");
  });
});

describe("collectorOutcomes", () => {
  it("gives the snapshot its own outcome: a day the stage gave up on leaves round collection green", () => {
    const r = gaveUp();
    expect(outcome(r, "acs-snapshot")).toMatchObject({ ok: false, skipped: false });
    expect(outcome(r, "rounds-poll")).toMatchObject({ ok: true });
    expect(outcome(r, "start-issuing")).toMatchObject({ ok: true, skipped: false });
  });

  it("feeds round collection from the rounds only: a stage error is the snapshot's failure", () => {
    const r = run({ ok: false, snapshot_error: "snapshot table unreadable" });
    expect(outcome(r, "rounds-poll")).toMatchObject({ ok: true });
    expect(outcome(r, "acs-snapshot")).toMatchObject({ ok: false, skipped: false, detail: "snapshot table unreadable" });
  });

  it("gives no signal for a deferred, waiting or unreached stage, so no streak starts or ends", () => {
    const deferred = run({ snapshot: "deferred", snapshot_deferred: "budget busy (gate)" });
    expect(outcome(deferred, "acs-snapshot")).toMatchObject({ skipped: true, detail: "deferred: budget busy (gate)" });
    expect(outcome(run({ snapshot: stage("waiting", "next try at 01:40") }), "acs-snapshot").skipped).toBe(true);
    expect(outcome(roundsDown(), "acs-snapshot").skipped).toBe(true);
  });

  it("counts failed after the grace, and starved and gave_up at any hour", () => {
    expect(outcome(run({ ok: false, snapshot: stage("failed") }), "acs-snapshot", IN_GRACE).skipped).toBe(true);
    expect(outcome(run({ ok: false, snapshot: stage("failed") }), "acs-snapshot")).toMatchObject({ ok: false, skipped: false });
    expect(outcome(run({ ok: false, snapshot: stage("starved") }), "acs-snapshot")).toMatchObject({ ok: false, skipped: false });
    expect(outcome(gaveUp(), "acs-snapshot", IN_GRACE)).toMatchObject({ ok: false, skipped: false });
    expect(outcome(run({ snapshot: stage("written") }), "acs-snapshot")).toMatchObject({ ok: true, skipped: false });
  });

  it("counts every snapshot state as snapshotStageHealth does: waiting, deferred and licenses_gave_up are neutral", () => {
    const cases: Array<[SnapshotStageResult["state"], { ok: boolean; skipped: boolean }]> = [
      ["not_due", { ok: true, skipped: false }],
      ["already", { ok: true, skipped: false }],
      ["written", { ok: true, skipped: false }],
      ["waiting", { ok: true, skipped: true }],
      ["licenses_gave_up", { ok: true, skipped: true }],
      ["failed", { ok: false, skipped: false }],
      ["gave_up", { ok: false, skipped: false }],
      ["starved", { ok: false, skipped: false }],
    ];
    for (const [state, want] of cases) {
      expect(outcome(run({ snapshot: stage(state, `${state} detail`) }), "acs-snapshot"), state).toMatchObject({
        ...want,
        detail: `${state} detail`,
      });
    }
    expect(outcome(run({ snapshot: "deferred", snapshot_deferred: "budget busy (queue)" }), "acs-snapshot")).toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it("fails start-issuing on a run whose only failure is a locate error, and leaves rounds-poll green", () => {
    const r = run({ ok: false, captured: [], locate_errors: ["locate round 114513: Scan api.cantonnodes.com answered 503"] });
    expect(outcome(r, "start-issuing")).toMatchObject({
      ok: false,
      skipped: false,
      detail: "locate_errors: locate round 114513: Scan api.cantonnodes.com answered 503",
    });
    expect(outcome(r, "rounds-poll")).toMatchObject({ ok: true });
  });

  it("fails start-issuing on a run whose only failure is a repair error", () => {
    // The failed repair put its round on the error backoff, so the run also reports it waiting: the failure wins.
    const r = run({
      ok: false, missing: [114400], repair_waiting: 1,
      repair_errors: ["repair round 114400: Scan api.cantonnodes.com answered 502 (error 1 in a row; next try at 2026-10-06T06:40:00.000Z)"],
    });
    expect(outcome(r, "start-issuing")).toMatchObject({ ok: false, skipped: false });
    expect(outcome(r, "start-issuing").detail).toContain("repair_errors: repair round 114400");
    expect(outcome(r, "rounds-poll")).toMatchObject({ ok: true });
  });

  it("skips start-issuing on a run that only waited out a repair backoff, keeping the streak", async () => {
    const waiting = run({ missing: [114400], repair_waiting: 1 });
    expect(outcome(waiting, "start-issuing")).toMatchObject({ ok: true, skipped: true });
    expect(outcome(waiting, "rounds-poll")).toMatchObject({ ok: true });

    // Neither a recovery nor another failure: three failing runs page across the waits between them.
    const failing = run({ ok: false, missing: [114400], repair_errors: ["repair round 114400: Scan api.cantonnodes.com answered 502"] });
    const policy = { ...COLLECTOR_HEALTH, failThreshold: 3 };
    for (const r of [failing, waiting, failing, waiting, failing]) {
      await checkFeedHealth(policy, collectorOutcomes(r, AFTER_GRACE));
    }
    expect(alerts.map((a) => [a.title, a.message.includes("(start-issuing)")])).toEqual([[COLLECTOR_HEALTH.downTitle, true]]);
    expect(cache.get(COLLECTOR_HEALTH.stateKey)).toMatchObject({ "start-issuing": { consecutiveFailures: 3, alerted: true } });
  });

  it("fails rounds-poll on a busy budget, an error or a stalled run, and on nothing else", () => {
    const busy = run({ ok: false, host: null, captured: [], cursor: null, busy: "gate" });
    expect(outcome(busy, "rounds-poll")).toMatchObject({ ok: false, detail: "budget: gate" });
    expect(outcome(busy, "start-issuing")).toMatchObject({ skipped: true });
    expect(outcome(roundsDown(), "rounds-poll")).toMatchObject({ ok: false, detail: "open-and-issuing returned no rounds" });

    const why = "no due locate got an answer (114513): 181 s into the run, 99 s before the lock deadline";
    const stalled = run({ ok: false, captured: [], locate_deferred: [114513], stalled: why });
    expect(outcome(stalled, "rounds-poll")).toMatchObject({ ok: false, detail: why });
    expect(outcome(stalled, "start-issuing")).toMatchObject({ skipped: true });

    // A busy repair, a deferred locate and a deferred stage are waits.
    const waits = run({
      locate_deferred: [114514], repair_deferred: "repair round 114400: budget busy (queue)",
      snapshot: "deferred", snapshot_deferred: "budget busy (queue)",
    });
    expect(outcome(waits, "rounds-poll")).toMatchObject({ ok: true });
    expect(outcome(waits, "start-issuing")).toMatchObject({ skipped: true });
  });

  it("pages the recovery of round collection while the snapshot stays given up", async () => {
    const policy = { ...COLLECTOR_HEALTH, failThreshold: 2 };
    // Snapshot fails twice (paged), rounds fail twice (paged), rounds come back
    // while the snapshot is still given up.
    for (const r of [gaveUp(), gaveUp(), roundsDown(), roundsDown(), gaveUp()]) {
      await checkFeedHealth(policy, collectorOutcomes(r, AFTER_GRACE));
    }
    expect(alerts.map((a) => [a.title, a.message.includes("(acs-snapshot)"), a.message.includes("(rounds-poll)")])).toEqual([
      [COLLECTOR_HEALTH.downTitle, true, false],
      [COLLECTOR_HEALTH.downTitle, false, true],
      [COLLECTOR_HEALTH.recoveredTitle, false, true],
    ]);
    expect(cache.get(COLLECTOR_HEALTH.stateKey)).toMatchObject({
      "acs-snapshot": { consecutiveFailures: 3, alerted: true },
      "rounds-poll": { consecutiveFailures: 0, alerted: false },
    });
  });
});

describe("collectorLossAlerts", () => {
  it("pages rounds given up at once, whatever the threshold, listing at most 20 of them and the total", async () => {
    // What the collector reports after an outage of weeks: 20 rounds listed, all counted, the latch set.
    const lost = run({
      ok: false,
      abandoned: Array.from({ length: COLLECTOR_LIMITS.abandonedListed }, (_, i) => 110000 + i),
      abandoned_total: 4382,
      given_up: { total: 4382, first: 110000, last: 114381, runs_left: COLLECTOR_LIMITS.givenUpRuns - 1 },
    });
    expect(outcome(lost, "start-issuing")).toMatchObject({
      ok: false, skipped: false, detail: "given_up: 4382 rounds from 110000 to 114381",
    });
    // The latch alone pages only after failThreshold failing runs.
    await checkFeedHealth({ ...COLLECTOR_HEALTH, failThreshold: 5 }, collectorOutcomes(lost, AFTER_GRACE));
    expect(alerts).toEqual([]);

    await collectorLossAlerts(lost);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "error", title: ROUNDS_ABANDONED_TITLE });
    expect(alerts[0].message).toContain("110000, 110001");
    expect(alerts[0].message).toContain("110019");
    expect(alerts[0].message).not.toContain("110020");
    expect(alerts[0].message).toContain("(4382 in all)");

    // The next run reports no new loss: nothing more is sent, and the latch keeps start-issuing failing.
    const held = run({ ok: false, given_up: { total: 4382, first: 110000, last: 114381, runs_left: COLLECTOR_LIMITS.givenUpRuns - 2 } });
    await collectorLossAlerts(held);
    expect(alerts).toHaveLength(1);
    expect(outcome(held, "start-issuing")).toMatchObject({ ok: false, skipped: false });
  });

  it("pages a license count the stage gave up on once per day, while the latch counts it neutral", async () => {
    const licenses = (date: string) =>
      run({ snapshot: { date, state: "licenses_gave_up", detail: "gave up after 8 failed attempts: Scan answered 503" } });
    expect(outcome(licenses("2026-10-05"), "acs-snapshot")).toMatchObject({ ok: true, skipped: true });

    for (let i = 0; i < 3; i++) await collectorLossAlerts(licenses("2026-10-05"));
    await collectorLossAlerts(licenses("2026-10-06"));
    expect(alerts.map((a) => [a.title, a.message.includes("2026-10-05"), a.message.includes("2026-10-06")])).toEqual([
      [LICENSES_GAVE_UP_TITLE, true, false],
      [LICENSES_GAVE_UP_TITLE, false, true],
    ]);
    expect(alerts[0].message).toContain("gave up after 8 failed attempts");
  });

  it("records a license page only once the sink took it, so the next run of the day pages it again", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const licenses = run({
      snapshot: { date: "2026-10-05", state: "licenses_gave_up", detail: "gave up after 8 failed attempts: Scan answered 503" },
    });
    delivered = false;
    await collectorLossAlerts(licenses);
    expect(alerts).toHaveLength(1);
    expect(cache.has(LICENSES_ALERT_KEY)).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("validator_licenses for 2026-10-05 stays empty"));

    delivered = true;
    await collectorLossAlerts(licenses);
    await collectorLossAlerts(licenses);
    expect(alerts.map((a) => a.title)).toEqual([LICENSES_GAVE_UP_TITLE, LICENSES_GAVE_UP_TITLE]);
    expect(cache.get(LICENSES_ALERT_KEY)).toEqual({ date: "2026-10-05" });
    logged.mockRestore();
  });

  it("pages given-up rounds again from the runs that still hold them until the sink takes it, then stops", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const latch = (runs_left: number) => ({ total: 4, first: 114209, last: 114212, runs_left });
    const lost = run({ ok: false, abandoned: [114209, 114210, 114211, 114212], abandoned_total: 4, given_up: latch(23) });
    const held = (runs_left: number) => run({ ok: false, given_up: latch(runs_left) });

    // The collector reports these rounds in this run only: a failed send must not be the end of them.
    delivered = false;
    await collectorLossAlerts(lost);
    await collectorLossAlerts(held(22));
    expect(cache.has(ROUNDS_ALERT_KEY)).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("114209, 114210, 114211, 114212 (4 in all)"));

    delivered = true;
    await collectorLossAlerts(held(21));
    await collectorLossAlerts(held(20));
    expect(alerts.map((a) => a.title)).toEqual([ROUNDS_ABANDONED_TITLE, ROUNDS_ABANDONED_TITLE, ROUNDS_ABANDONED_TITLE]);
    expect(alerts[0].message).toContain("114209, 114210, 114211, 114212 (4 in all)");
    expect(alerts[2].message).toContain("4 rounds from 114209 to 114212");
    expect(cache.get(ROUNDS_ALERT_KEY)).toEqual({ total: 4, first: 114209, last: 114212 });
    logged.mockRestore();
  });

  it("names the whole latch when a new loss joins one whose page was not delivered", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    delivered = false;
    await collectorLossAlerts(
      run({ ok: false, abandoned: [114209], abandoned_total: 1, given_up: { total: 1, first: 114209, last: 114209, runs_left: 23 } }),
    );
    delivered = true;
    await collectorLossAlerts(
      run({
        ok: false, abandoned: [114300, 114301], abandoned_total: 2,
        given_up: { total: 3, first: 114209, last: 114301, runs_left: 23 },
      }),
    );
    expect(alerts).toHaveLength(2);
    expect(alerts[1].message).toContain("114300, 114301 (2 in all)");
    expect(alerts[1].message).toContain("3 rounds from 114209 to 114301");
    expect(cache.get(ROUNDS_ALERT_KEY)).toEqual({ total: 3, first: 114209, last: 114301 });
    logged.mockRestore();
  });

  it("sends nothing for a run without a loss", async () => {
    for (const r of [run(), roundsDown(), gaveUp(), run({ missing: [114400], repair_waiting: 1 })]) await collectorLossAlerts(r);
    expect(alerts).toEqual([]);
  });
});

describe("collectorAlertPolicy", () => {
  const armed = (fail_threshold: unknown) => ({
    id: "overrides", last_round: null, last_date: null, last_poll_at: null,
    detail: { collector_alerts: { armed: true, fail_threshold } },
  });

  it("stays silent until armed, and keeps the threshold below the given-up latch so a loss always pages", () => {
    expect(collectorAlertPolicy(null)).toBeNull();
    expect(collectorAlertPolicy(armed(5))).toMatchObject({ failThreshold: 5, downWindow: "~25min" });
    expect(collectorAlertPolicy(armed(COLLECTOR_LIMITS.givenUpRuns))?.failThreshold).toBe(COLLECTOR_LIMITS.givenUpRuns - 1);
    expect(collectorAlertPolicy(armed(100))?.failThreshold).toBe(COLLECTOR_LIMITS.givenUpRuns - 1);
    expect(collectorAlertPolicy(armed("five"))?.failThreshold).toBe(COLLECTOR_HEALTH.failThreshold);
    expect(collectorAlertPolicy(armed(1))?.failThreshold).toBe(COLLECTOR_HEALTH.failThreshold);
  });
});

describe("finalizeOutcomes", () => {
  const DUE = "2026-10-05";
  /** A run whose due day settled in full. */
  const settled = (over: Partial<FinalizeResult> = {}): FinalizeResult => ({
    ok: true,
    date: DUE,
    series: Object.fromEntries(SERIES_NAMES.map((n): [SeriesName, SeriesState] => [n, { state: "final" }])),
    days: [{ date: DUE, past_deadline: true, wrote: 18, counts: { final: 18 } }],
    warnings: [],
    errors: [],
    ...over,
  });
  const withSeries = (name: SeriesName, s: SeriesState) => settled({ ok: false, series: { ...settled().series, [name]: s } });
  const finalizeOutcome = (r: FinalizeResult, id: string) => finalizeOutcomes(r).find((o) => o.id === id)!;

  it("judges each series of the due day by the rule of the run's ok: settled, and no null that means the pipeline failed", () => {
    const cases: Array<[SeriesState, boolean]> = [
      [{ state: "final" }, true],
      [{ state: "revised", reason: "Late data: a round arrived after the day was final" }, true],
      [{ state: "final_null", gap_code: "not_collected", reason: "Before the forward collector started" }, true],
      [{ state: "final_null", gap_code: "withdrawn", reason: "withdrawn; only a correction restores it" }, true],
      [{ state: "final_null", gap_code: "source_unavailable", reason: "No registry reading with totalSupplyAsOf at the end of this day" }, false],
      [{ state: "final_null", gap_code: "round_missed", reason: "Round 200070 was never captured" }, false],
      [{ state: "provisional" }, false],
      [{ state: "held", gap_code: "sanity_gate_failed", reason: "featured_apps moved 27% in a day" }, false],
      [{ state: "conflict", reason: "final 127 would become 128" }, false],
      [{ state: "unexplained", reason: "null with no gap reason" }, false],
    ];
    for (const [s, ok] of cases) {
      expect(finalizeOutcome(withSeries("supply_cc", s), "series:supply_cc"), `${s.state} ${s.gap_code ?? ""}`).toMatchObject({
        ok,
        skipped: false,
      });
    }
    // The page names the state and the gap code the verdict rests on.
    expect(finalizeOutcome(withSeries("supply_cc", cases[4][0]), "series:supply_cc")).toMatchObject({
      label: `supply_cc for ${DUE}`,
      detail: "final_null (source_unavailable): No registry reading with totalSupplyAsOf at the end of this day",
    });
    // A series the evaluated due day did not report is a failure, not a pass.
    const missing = settled();
    delete missing.series.supply_cc;
    expect(finalizeOutcome(missing, "series:supply_cc")).toMatchObject({ ok: false, skipped: false, detail: "no state" });
  });

  it("gives no series signal when the due day was not evaluated, and fails the run with the error", () => {
    const dueThrew = settled({
      ok: false, series: {}, days: [],
      errors: [{ date: DUE, error: "[scan-record] read gaps: 57014 timeout" }],
      error: `${DUE}: [scan-record] read gaps: 57014 timeout`,
    });
    const out = finalizeOutcomes(dueThrew);
    // The lock is reported on its own key (finalizeLockOutcomes), never with the series and the run.
    expect(out.map((o) => o.id)).toEqual([...SERIES_NAMES.map((n) => `series:${n}`), "run"]);
    expect(out.filter((o) => o.id.startsWith("series:")).every((o) => o.skipped)).toBe(true);
    expect(finalizeOutcome(dueThrew, "run")).toMatchObject({ ok: false, detail: `${DUE}: [scan-record] read gaps: 57014 timeout` });

    // A run the caller could not start has no day in errors: its own error is named.
    const whole = settled({ ok: false, series: {}, days: [], error: "[scan-record] read cursor: 57014 timeout" });
    expect(finalizeOutcome(whole, "run")).toMatchObject({ ok: false, detail: "[scan-record] read cursor: 57014 timeout" });
  });

  it("names in the run line the days that threw and the days past their deadline that need a human, which have no series outcome", () => {
    const r = settled({
      ok: false,
      errors: [{ date: "2026-09-30", error: "[scan-record] read gaps: 57014 timeout" }],
      days: [
        { date: "2026-10-03", past_deadline: true, wrote: 0, counts: { final: 16, held: 1, conflict: 1 } },
        { date: DUE, past_deadline: true, wrote: 0, counts: { final: 18 } },
        // Before 02:00 the newest day is not past its deadline: a hold there is no fault yet.
        { date: "2026-10-06", past_deadline: false, wrote: 3, counts: { provisional: 17, held: 1 } },
      ],
    });
    expect(finalizeOutcome(r, "run")).toMatchObject({
      ok: false,
      detail: "2026-09-30: [scan-record] read gaps: 57014 timeout; 2026-10-03: 1 held, 1 conflict",
    });
    expect(finalizeOutcomes(r).filter((o) => o.id.startsWith("series:")).every((o) => o.ok && !o.skipped)).toBe(true);

    // A run that is not ok only because of the due day's series names the due day.
    const unsettled = withSeries("supply_cc", { state: "final_null", gap_code: "source_unavailable" });
    expect(finalizeOutcome(unsettled, "run")).toMatchObject({ ok: false, detail: `due day ${DUE} not settled` });
    expect(finalizeOutcome(settled(), "run")).toEqual({ id: "run", label: "finalize run", ok: true, detail: undefined });
  });

  it("keeps the lock on its own key, so a skip run racing the holder cannot overwrite its series or run state", async () => {
    expect(FINALIZE_LOCK_HEALTH.stateKey).not.toBe(FINALIZE_HEALTH.stateKey);
    expect(finalizeLockOutcomes(false).map((o) => o.id)).toEqual(["lock"]);
    const failing = withSeries("supply_cc", { state: "final_null", gap_code: "source_unavailable", reason: "No registry reading" });
    // The holder and a skip run read their state together and write it after: on one key the later write would drop the other's.
    await Promise.all([
      checkFeedHealth(FINALIZE_HEALTH, finalizeOutcomes(failing)),
      checkFeedHealth(FINALIZE_LOCK_HEALTH, finalizeLockOutcomes(false)),
    ]);
    expect(cache.get(FINALIZE_HEALTH.stateKey)).toMatchObject({
      "series:supply_cc": { consecutiveFailures: 1 }, run: { consecutiveFailures: 1 },
    });
    expect(cache.get(FINALIZE_HEALTH.stateKey)).not.toHaveProperty("lock");
    expect(cache.get(FINALIZE_LOCK_HEALTH.stateKey)).toEqual({ lock: { consecutiveFailures: 1, alerted: false } });
    expect(pages).toEqual([]);

    // The holder's second failing run pages its series and its run, never the lock.
    await checkFeedHealth(FINALIZE_HEALTH, finalizeOutcomes(failing));
    await checkFeedHealth(FINALIZE_LOCK_HEALTH, finalizeLockOutcomes(true));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ kind: "problem", title: "Open record is not settling" });
    expect(pages[0].message).toContain("(series:supply_cc)");
    expect(pages[0].message).toContain("final_null (source_unavailable): No registry reading");
    expect(pages[0].message).toContain(`(run)`);
    expect(pages[0].message).toContain("What to do: read the finalize job's log");
    expect(pages[0].message).not.toContain("(lock)");

    // Two skips in a row page the lock on its own title; a run that claims it recovers it.
    await checkFeedHealth(FINALIZE_LOCK_HEALTH, finalizeLockOutcomes(false));
    await checkFeedHealth(FINALIZE_LOCK_HEALTH, finalizeLockOutcomes(false));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ kind: "problem", title: FINALIZE_LOCK_HEALTH.downTitle });
    expect(pages[1].message).toContain("(lock)");
    expect(pages[1].message).toContain("another run held the lock, or the shared cache failed");
    expect(pages[1].message).toContain("What to do: read the finalize job's log");
    expect(pages[1].message).not.toContain("(series:");
    // The skips left the holder's latches as they were.
    expect(cache.get(FINALIZE_HEALTH.stateKey)).toMatchObject({ "series:supply_cc": { consecutiveFailures: 2, alerted: true } });

    await checkFeedHealth(FINALIZE_HEALTH, finalizeOutcomes(settled()));
    await checkFeedHealth(FINALIZE_LOCK_HEALTH, finalizeLockOutcomes(true));
    expect(pages).toHaveLength(4);
    expect(pages[2]).toMatchObject({ kind: "resolved", title: "Open record settling again" });
    for (const id of ["(series:supply_cc)", "(run)"]) expect(pages[2].message).toContain(id);
    expect(pages[3]).toMatchObject({ kind: "resolved", title: FINALIZE_LOCK_HEALTH.recoveredTitle });
    expect(pages[3].message).toContain("(lock)");
    // None of it went to the summary.
    expect(alerts).toEqual([]);
  });
});
