import { describe, expect, it } from "vitest";
import { sharedClaim, sharedDelete } from "../../runtime/shared-cache";
import { CURSOR_BACKFILL, CURSOR_OVERRIDES, RECORD_FIRST_DATE, addDays, endOfDay } from "../../open-record/contract";
import { TEMPLATES } from "../acs";
import {
  BACKFILL_FINALIZE_GRACE_MS,
  BACKFILL_FINALIZE_MAX_DAYS,
  BACKFILL_MAX_ATTEMPTS,
  BACKFILL_RETRY_MS,
  finalizeSlotStart,
  runBackfill,
} from "../backfill";
import { backfillOutcomes } from "../health";
import { FINALIZE_LOCK, FINALIZE_WINDOW_DAYS } from "../finalize";
import { ScanBusyError } from "../scan-budget";
import { ScanHttpError, ScanTimeoutError } from "../scan-client";
import { licenseReadHeadroomMs, readSnapshot, snapshotCoreHeadroomMs } from "../snapshot";
import type { RecordStore, SnapshotRow } from "../store";
import { NO_ROUND_TOTALS, snapshotRow } from "./helpers/day-builders";
import { fakeScan, loadFixture } from "./helpers/fake-scan";
import { memoryStore } from "./helpers/memory-store";

const acs = loadFixture("acs-snapshot-2026-06-01.json");
// Three days to fill: the boundary day before the first date, the first date
// and the next. Derived from the contract, so a later first date moves them too.
const D0 = addDays(RECORD_FIRST_DATE, -1);
const D1 = RECORD_FIRST_DATE;
const D2 = addDays(RECORD_FIRST_DATE, 1);
const now = new Date(`${addDays(RECORD_FIRST_DATE, 2)}T03:00:00Z`);
const base = { now, maxDays: 4, budgetMs: 520_000, roundTotalsVerified: NO_ROUND_TOTALS };
// Scan advances about 144 rounds a day (10-minute rounds). Each day the fake
// serves, and each day a test seeds, is that many rounds after the day before,
// so the round-count gate passes and a finalize alarm here is one a test means.
const ROUNDS_PER_DAY = 144;
const dayIndex = (date: string) => Math.round((Date.parse(date) - Date.parse(D0)) / 86_400_000);
/** The fixture, served at each record time as the snapshot of the day that ends there. */
const days = { acs, acsRoundOffset: (recordTime: string) => ROUNDS_PER_DAY * dayIndex(addDays(recordTime.slice(0, 10), -1)) };
/** A stored snapshot row for a test that seeds the store, its rounds advancing day by day. */
const seeded = (date: string, extra: Partial<SnapshotRow> = {}) =>
  snapshotRow(date, 100_000 + ROUNDS_PER_DAY * dayIndex(date), extra);
/** The row the backfill stores for `date` from the fixture. */
const readFromFixture = (date: string) => readSnapshot(fakeScan(days), 4, date, { withLicenses: false });

describe("runBackfill", () => {
  it("dry run reads one day and writes nothing", async () => {
    const { store, state } = memoryStore();
    const r = await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: true, maxDays: 1 });
    expect(r.planned.map((p) => p.date)).toEqual([D0]);
    expect(r.pending).toBe(3);
    expect(state.snapshots.size).toBe(0);
    expect(state.values.size).toBe(0);

    // A failed dry read counts no attempt: the cursor is not even written.
    const broken = fakeScan({ ...days, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "no snapshot") });
    const failed = await runBackfill({ ...base, store, scan: broken, dryRun: true, maxDays: 1 });
    expect(failed).toMatchObject({ ok: false, failures: [{ date: D0 }], waiting: [], given_up: [], pending: 3 });
    expect(state.cursors.get(CURSOR_BACKFILL)).toBeUndefined();
  });

  it("fills every missing snapshot oldest first, then finalizes the days they bound", async () => {
    const { store, state } = memoryStore();
    const r = await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: false });
    expect(r.processed).toEqual([D0, D1, D2]);
    expect(r.kept).toEqual([]);
    expect(r.finalized).toEqual([D1, D2]);
    expect(r).toMatchObject({ ok: true, done: true, pending: 0 });
    expect(state.snapshots.get(D1)?.validator_licenses).toBeNull();
    expect(state.values.get(`${D1}|super_validators`)).toMatchObject({ value: "4.0000000000", status: "final" });
    expect(state.dirtyAt).not.toBeNull();
  });

  it("never writes over a snapshot row stored after its listing: the day is kept as stored", async () => {
    const { store, state } = memoryStore();
    // The forward stage stored D1 from its own host, with its license count,
    // after this run listed the missing days.
    const forward: SnapshotRow = { ...(await readFromFixture(D1)), source_host: "scan.forward.example", validator_licenses: 1400 };
    state.snapshots.set(D1, forward);
    const staleListing: RecordStore = { ...store, listSnapshotDates: async () => [] };
    const r = await runBackfill({ ...base, store: staleListing, scan: fakeScan(days), dryRun: false });
    expect(state.snapshots.get(D1)).toEqual(forward);
    expect(r).toMatchObject({ ok: true, processed: [D0, D2], kept: [D1], pending: 0, done: true });
  });

  it("starts a day only while snapshotCoreHeadroomMs of its class is left, and holds every call to the invocation's end", async () => {
    const { store, state } = memoryStore();
    const scan = fakeScan(days);
    const started = Date.now();
    let t = started;
    const deadlines: Array<number | undefined> = [];
    const inner = scan.acsSnapshot.bind(scan);
    scan.acsSnapshot = (migrationId, recordTime, template, host, deadline) => {
      deadlines.push(deadline);
      t += 30_000;
      return inner(migrationId, recordTime, template, host, deadline);
    };
    // Room for one core read and 60 s: the first day's four calls take 120 s
    // of the run's clock, so the second day would not fit and is not started.
    const budgetMs = snapshotCoreHeadroomMs(scan.cls) + 60_000;
    const r = await runBackfill({ ...base, store, scan, dryRun: false, budgetMs, clock: () => t });
    expect(r.processed).toEqual([D0]);
    expect(r).toMatchObject({ ok: true, done: false, pending: 2, failures: [] });
    expect([...state.snapshots.keys()]).toEqual([D0]);
    expect(deadlines).toHaveLength(4);
    expect(deadlines.every((d) => d !== undefined && d <= started + budgetMs)).toBe(true);
    expect(Math.max(...(deadlines as number[]))).toBe(started + budgetMs);

    // A budget smaller than the headroom starts no day at all, and calls no ACS template.
    const tight = fakeScan(days);
    const none = await runBackfill({ ...base, store: memoryStore().store, scan: tight, dryRun: false, budgetMs: snapshotCoreHeadroomMs(tight.cls) - 1 });
    expect(none).toMatchObject({ ok: true, processed: [], done: false, pending: 3 });
    expect(tight.calls.filter((c) => c.startsWith("acs "))).toEqual([]);

    // The caller's budget (base.budgetMs, 520 s) holds the backfill class's headroom, so every call starts a day.
    expect(base.budgetMs).toBeGreaterThanOrEqual(snapshotCoreHeadroomMs("backfill"));
  });

  it("yields to the budget without calling it a failure", async () => {
    const { store } = memoryStore();
    const r = await runBackfill({
      ...base, store, dryRun: false, scan: fakeScan({ error: new ScanBusyError("api.cantonnodes.com", "window") }),
    });
    expect(r).toMatchObject({ ok: true, yielded: "window", processed: [], done: false });
  });

  it("records a day Scan cannot serve and keeps going", async () => {
    const { store } = memoryStore();
    const r = await runBackfill({
      ...base, store, dryRun: false,
      scan: fakeScan({ ...days, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "no snapshot") }),
    });
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(3);
    expect(r.failures[0].error).toContain("404");
  });

  it("gives up on a day after three failed attempts BACKFILL_RETRY_MS apart, so it never blocks newer days", async () => {
    const { store, state } = memoryStore();
    const broken = () => fakeScan({ ...days, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "no snapshot") });
    // A minute past the spacing each time: a failure is stamped a few ms after its run's start.
    const at = (i: number) => new Date(now.getTime() + i * (BACKFILL_RETRY_MS + 60_000));
    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS; i++) {
      await runBackfill({ ...base, now: at(i), store, dryRun: false, scan: broken() });
      // A run before the spacing has passed reads none of the days that failed.
      const early = broken();
      const waiting = await runBackfill({ ...base, now: new Date(at(i).getTime() + 5 * 60_000), store, dryRun: false, scan: early });
      if (i < BACKFILL_MAX_ATTEMPTS - 1) expect(waiting).toMatchObject({ waiting: [D0, D1, D2], failures: [], pending: 3 });
      expect(early.calls).toEqual([]);
    }
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.attempts).toEqual({ [D0]: 3, [D1]: 3, [D2]: 3 });

    const scan = fakeScan(days);
    const r = await runBackfill({ ...base, now: at(BACKFILL_MAX_ATTEMPTS), store, dryRun: false, scan });
    expect(r).toMatchObject({ pending: 0, processed: [], given_up: [D0, D1, D2], waiting: [] });
    expect(scan.calls).toEqual([]);
  });

  it.each([
    ["a 503", new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 503, "upstream unavailable")],
    ["a timeout", new ScanTimeoutError("api.cantonnodes.com", "/v0/state/acs")],
  ])("ends its reads on %s, and holds the day back BACKFILL_RETRY_MS while the newer days are read, spending no attempt", async (_name, outage) => {
    const { store, state } = memoryStore();
    const down = fakeScan({ ...days, acsError: outage });
    const r = await runBackfill({ ...base, store, scan: down, dryRun: false });
    // One call of the day that failed, none of the next: Scan is down, not the day.
    expect(down.calls).toEqual(["migrationId", `acs ${endOfDay(D0)} ${TEMPLATES.dsoRules}`]);
    expect(r).toMatchObject({ ok: false, failures: [{ date: D0, outage: true }], waiting: [D0], given_up: [], pending: 3, done: false });
    const stamped = Date.parse((state.cursors.get(CURSOR_BACKFILL)?.detail.failed_at as Record<string, string>)[D0]);
    // An outage says nothing about the day: it is counted apart, and spends none of its attempts.
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail).toMatchObject({ attempts: {}, outage_failures: { [D0]: 1 } });
    expect(stamped - now.getTime()).toBeGreaterThanOrEqual(0);
    expect(stamped - now.getTime()).toBeLessThan(10_000);

    // Five minutes later Scan is back: the newer days are read, the failed one waits.
    const soon = await runBackfill({ ...base, now: new Date(now.getTime() + 5 * 60_000), store, scan: fakeScan(days), dryRun: false });
    expect(soon).toMatchObject({ ok: true, processed: [D1, D2], waiting: [D0], pending: 1 });

    // Once the spacing has passed it is read, and its counts are cleared.
    const later = await runBackfill({ ...base, now: new Date(now.getTime() + BACKFILL_RETRY_MS + 60_000), store, scan: fakeScan(days), dryRun: false });
    expect(later).toMatchObject({ ok: true, processed: [D0], waiting: [], pending: 0, done: true });
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail).toMatchObject({ attempts: {}, failed_at: {}, outage_failures: {} });
  });

  it("gives no day up to a Scan outage that outlasts three reads BACKFILL_RETRY_MS apart", async () => {
    const { store, state } = memoryStore();
    // /v0/state/acs keeps timing out through the night while the other endpoints answer.
    const at = (i: number) => new Date(now.getTime() + i * (BACKFILL_RETRY_MS + 60_000));
    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS + 1; i++) {
      const r = await runBackfill({
        ...base, now: at(i), store, dryRun: false,
        scan: fakeScan({ ...days, acsError: new ScanTimeoutError("api.cantonnodes.com", "/v0/state/acs") }),
      });
      expect(r).toMatchObject({ given_up: [], failures: [{ date: D0, outage: true }], waiting: [D0], pending: 3 });
    }
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail).toMatchObject({
      attempts: {}, outage_failures: { [D0]: BACKFILL_MAX_ATTEMPTS + 1 },
    });

    // Scan is back: every day is read, none needed a hand on the cursor.
    const back = await runBackfill({ ...base, now: at(BACKFILL_MAX_ATTEMPTS + 1), store, scan: fakeScan(days), dryRun: false });
    expect(back).toMatchObject({ ok: true, processed: [D0, D1, D2], given_up: [], pending: 0, done: true });
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail).toMatchObject({ attempts: {}, failed_at: {}, outage_failures: {} });
  });

  it("still gives a day up after three failures that are not outages, whatever outages came between", async () => {
    const { store, state } = memoryStore();
    const at = (i: number) => new Date(now.getTime() + i * (BACKFILL_RETRY_MS + 60_000));
    const notFound = () => fakeScan({ ...days, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "no snapshot") });
    const outage = () => fakeScan({ ...days, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 502, "bad gateway") });
    const scans = [notFound, outage, notFound, outage, notFound];
    let last: Awaited<ReturnType<typeof runBackfill>> | undefined;
    for (let i = 0; i < scans.length; i++) last = await runBackfill({ ...base, now: at(i), store, dryRun: false, scan: scans[i]() });
    // The 404s spent D0's three attempts (and the newer days' too); the 502s ended their runs on D0 and spent none.
    expect(last?.given_up).toContain(D0);
    const detail = state.cursors.get(CURSOR_BACKFILL)?.detail;
    expect((detail?.attempts as Record<string, number>)[D0]).toBe(BACKFILL_MAX_ATTEMPTS);
    expect((detail?.outage_failures as Record<string, number>)[D0]).toBe(2);
  });

  it("yields on a busy refusal in the middle of a day's read, spending no attempt", async () => {
    const { store, state } = memoryStore();
    // A collector call took the slot between the backfill's own calls (snapshot.ts).
    const scan = fakeScan({ ...days, acsErrors: { [TEMPLATES.openRound]: new ScanBusyError("api.cantonnodes.com", "queue") } });
    const r = await runBackfill({ ...base, store, scan, dryRun: false });
    expect(scan.calls).toEqual(["migrationId", `acs ${endOfDay(D0)} ${TEMPLATES.dsoRules}`, `acs ${endOfDay(D0)} ${TEMPLATES.openRound}`]);
    expect(r).toMatchObject({ ok: true, yielded: "queue", failures: [], processed: [], waiting: [], pending: 3, done: false });
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail).toMatchObject({ attempts: {}, failed_at: {} });
  });

  it("ends the run on a store failure without spending the day's attempt", async () => {
    const { store, state } = memoryStore();
    const down: RecordStore = {
      ...store,
      insertSnapshot: async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      },
    };
    const scan = fakeScan(days);
    const r = await runBackfill({ ...base, store: down, scan, dryRun: false });
    expect(r).toMatchObject({ ok: false, processed: [], kept: [], waiting: [], pending: 3 });
    expect(r.failures).toEqual([{ date: "run", error: expect.stringContaining("statement timeout") }]);
    // Only the first day was read.
    expect(scan.calls).toHaveLength(1 + 4);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail).toMatchObject({ attempts: {}, failed_at: {} });
  });

  it("holds FINALIZE_LOCK only around its finalize: claimed after its last Scan call, released once the days are written", async () => {
    const { store, state } = memoryStore();
    const scan = fakeScan(days);
    const lock: string[] = [];
    const r = await runBackfill({
      ...base, store, scan, dryRun: false,
      finalizeLock: () => {
        lock.push(`claimed after ${scan.calls.length} calls, ${state.values.size} values`);
        return () => {
          lock.push(`released with ${state.values.size} values`);
        };
      },
    });
    expect(r.finalized).toEqual([D1, D2]);
    // migrationId, then four templates for each of the three days.
    expect(scan.calls).toHaveLength(1 + 3 * 4);
    expect(lock).toEqual([`claimed after ${1 + 3 * 4} calls, 0 values`, `released with ${state.values.size} values`]);
    expect(state.values.size).toBeGreaterThan(0);
  });

  it("finds FINALIZE_LOCK held by the finalize job and owes the days to a later run, which finalizes them without a Scan call", async () => {
    const { store, state } = memoryStore();
    expect(sharedClaim(FINALIZE_LOCK.key, FINALIZE_LOCK.holdMs)).toBe(true);
    try {
      const r = await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: false });
      expect(r).toMatchObject({
        ok: true, done: true, processed: [D0, D1, D2], finalized: [], finalize_deferred: true, finalize_owed: [D1, D2],
        finalize_errors: [],
      });
      expect(state.values.size).toBe(0);
      expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([D1, D2]);

      // A dry run writes nothing, owed days included.
      const dry = await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: true });
      expect(dry).toMatchObject({ finalized: [], finalize_owed: [D1, D2] });
    } finally {
      sharedDelete(FINALIZE_LOCK.key);
    }
    expect(state.values.size).toBe(0);

    const scan = fakeScan(days);
    const later = await runBackfill({ ...base, store, scan, dryRun: false });
    expect(scan.calls).toEqual([]);
    expect(later).toMatchObject({
      ok: true, pending: 0, processed: [], finalized: [D1, D2], finalize_deferred: false, finalize_owed: [],
    });
    expect(state.values.get(`${D1}|super_validators`)).toMatchObject({ value: "4.0000000000", status: "final" });
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([]);
    // Released after the later run's finalize.
    expect(sharedClaim(FINALIZE_LOCK.key, 1_000)).toBe(true);
    sharedDelete(FINALIZE_LOCK.key);
  });

  it("owes each stored day's finalize on the cursor before its next read, so a restart mid-run loses none", async () => {
    const { store, state } = memoryStore();
    const scan = fakeScan(days);
    const owedAtRead: unknown[] = [];
    const inner = scan.acsSnapshot.bind(scan);
    scan.acsSnapshot = (migrationId, recordTime, template, host, deadline) => {
      if (template === TEMPLATES.dsoRules) owedAtRead.push(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed ?? null);
      return inner(migrationId, recordTime, template, host, deadline);
    };
    await runBackfill({ ...base, store, scan, dryRun: false });
    // Nothing is owed before D0's read; D0 bounds D1, and D1 bounds itself and D2.
    expect(owedAtRead).toEqual([null, [D1], [D1, D2]]);
  });

  it("keeps a day whose finalize throws owed and reports it, and still finalizes the other days", async () => {
    const { store, state } = memoryStore();
    let broken = true;
    const flaky: RecordStore = {
      ...store,
      getRoundsStartedBetween: async (fromIso, toIso) => {
        if (broken && fromIso.startsWith(D1)) throw new Error("[scan-record] read rounds by start: 57014 statement timeout");
        return store.getRoundsStartedBetween(fromIso, toIso);
      },
    };
    const r = await runBackfill({ ...base, store: flaky, scan: fakeScan(days), dryRun: false });
    expect(r).toMatchObject({ ok: false, processed: [D0, D1, D2], failures: [], finalized: [D2], finalize_owed: [D1] });
    expect(r.finalize_errors).toEqual([{ date: D1, error: expect.stringContaining("57014") }]);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([D1]);

    broken = false;
    const next = await runBackfill({ ...base, store: flaky, scan: fakeScan(days), dryRun: false });
    expect(next).toMatchObject({ ok: true, finalized: [D1], finalize_owed: [], finalize_errors: [] });
  });

  it("finalizes at most BACKFILL_FINALIZE_MAX_DAYS owed days a run, oldest first, and drops entries that are not days of the record", async () => {
    const { store, state } = memoryStore();
    const owed = Array.from({ length: BACKFILL_FINALIZE_MAX_DAYS + 3 }, (_, i) => addDays(RECORD_FIRST_DATE, i));
    const last = owed[owed.length - 1];
    const later = new Date(`${addDays(last, 1)}T03:00:00Z`);
    // Every snapshot from the boundary day on is stored: nothing is left to read.
    for (let d = D0; d <= last; d = addDays(d, 1)) state.snapshots.set(d, seeded(d));
    state.cursors.set(CURSOR_BACKFILL, {
      id: CURSOR_BACKFILL, last_round: null, last_date: null, last_poll_at: null,
      detail: { attempts: {}, finalize_owed: [...owed].reverse().concat([D0, "2026-02-30", addDays(last, 1)]) },
    });
    const scan = fakeScan(days);
    const first = await runBackfill({ ...base, now: later, store, scan, dryRun: false });
    expect(scan.calls).toEqual([]);
    expect(first).toMatchObject({
      ok: true, finalized: owed.slice(0, BACKFILL_FINALIZE_MAX_DAYS), finalize_owed: owed.slice(BACKFILL_FINALIZE_MAX_DAYS),
    });
    const second = await runBackfill({ ...base, now: later, store, scan, dryRun: false });
    expect(second).toMatchObject({ ok: true, finalized: owed.slice(BACKFILL_FINALIZE_MAX_DAYS), finalize_owed: [] });
    expect(scan.calls).toEqual([]);
  });

  it("finalizes a day only once both of its snapshots are stored, so reading one day a run publishes no revision", async () => {
    const { store, state } = memoryStore();
    const finalizedAt: Record<string, string[][]> = {};
    for (const expected of [D0, D1, D2]) {
      const r = await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: false, maxDays: 1 });
      expect(r.processed).toEqual([expected]);
      for (const d of r.finalized) (finalizedAt[d] ??= []).push([...state.snapshots.keys()].sort());
    }
    // D1 once D0 and D1 are stored, D2 once D1 and D2 are: each once.
    expect(finalizedAt).toEqual({ [D1]: [[D0, D1]], [D2]: [[D0, D1, D2]] });
    expect(state.revisions).toEqual([]);
    expect(state.values.get(`${D1}|super_validators`)).toMatchObject({ value: "4.0000000000", status: "final" });
    expect(state.values.get(`${D2}|super_validators`)).toMatchObject({ value: "4.0000000000", status: "final" });
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([]);
  });

  it("finalizes a day once the snapshot that bounds it is given up, with its explained null", async () => {
    const { store, state } = memoryStore();
    const at = (i: number) => new Date(now.getTime() + i * (BACKFILL_RETRY_MS + 60_000));
    // D1 and D2 are stored; D0 fails every read, so D1 waits for it while it has attempts left.
    state.snapshots.set(D1, seeded(D1));
    state.snapshots.set(D2, seeded(D2));
    state.cursors.set(CURSOR_BACKFILL, {
      id: CURSOR_BACKFILL, last_round: null, last_date: null, last_poll_at: null, detail: { attempts: {}, finalize_owed: [D1, D2] },
    });
    const broken = () => fakeScan({ ...days, acsError: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "no snapshot") });
    const first = await runBackfill({ ...base, now: at(0), store, scan: broken(), dryRun: false });
    // D2 has both of its snapshots; D1 waits for D0.
    expect(first).toMatchObject({ finalized: [D2], finalize_owed: [D1] });
    expect(state.values.has(`${D1}|super_validators`)).toBe(false);
    await runBackfill({ ...base, now: at(1), store, scan: broken(), dryRun: false });
    const last = await runBackfill({ ...base, now: at(2), store, scan: broken(), dryRun: false });
    expect(last).toMatchObject({ given_up: [D0], finalized: [D1], finalize_owed: [] });
    expect(state.values.get(`${D1}|super_validators`)).toMatchObject({ status: "final" });
    expect(state.revisions).toEqual([]);
  });

  it("owes the days a snapshot bounds on the cursor before its insert, so a run that dies right after the commit loses neither", async () => {
    const { store, state } = memoryStore();
    // The process dies once D1's row is committed: nothing after it is written.
    let dead = false;
    const dying: RecordStore = {
      ...store,
      setCursor: async (c) => {
        if (!dead) await store.setCursor(c);
      },
      insertSnapshot: async (row) => {
        const inserted = await store.insertSnapshot(row);
        if (row.date === D1) {
          dead = true;
          throw new Error("process killed");
        }
        return inserted;
      },
    };
    await runBackfill({ ...base, store: dying, scan: fakeScan(days), dryRun: false });
    expect(state.snapshots.has(D1)).toBe(true);
    // D1 and D2, the days D1's snapshot bounds, were owed before the insert.
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([D1, D2]);

    // A later run reads D2 and finalizes both.
    const next = await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: false });
    expect(next).toMatchObject({ ok: true, processed: [D2], finalized: [D1, D2], finalize_owed: [] });
  });

  it("finalizes a day whose insert committed and then answered an error, on a later run", async () => {
    const { store, state } = memoryStore();
    const committedThenFailed: RecordStore = {
      ...store,
      insertSnapshot: async (row) => {
        const inserted = await store.insertSnapshot(row);
        if (row.date === D1) throw new Error("fetch failed: socket hang up");
        return inserted;
      },
    };
    const first = await runBackfill({ ...base, store: committedThenFailed, scan: fakeScan(days), dryRun: false });
    expect(first).toMatchObject({ ok: false, processed: [D0], finalized: [], finalize_owed: [D1, D2] });
    expect(first.failures).toEqual([{ date: "run", error: expect.stringContaining("socket hang up") }]);
    expect(state.snapshots.has(D1)).toBe(true);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([D1, D2]);

    // D1 is stored, so the next run does not read it: the cursor still owes it.
    const scan = fakeScan(days);
    const next = await runBackfill({ ...base, store, scan, dryRun: false });
    expect(next).toMatchObject({ ok: true, processed: [D2], finalized: [D1, D2], finalize_owed: [] });
    expect(state.values.get(`${D1}|super_validators`)).toMatchObject({ value: "4.0000000000", status: "final" });
    expect(state.revisions).toEqual([]);
  });

  it("finalizes a stored day older than the finalize window that has no values, whatever the cursor says", async () => {
    const { store, state } = memoryStore();
    // The finalize job's window is the last FINALIZE_WINDOW_DAYS days: D1 and D2 are older.
    const yesterday = addDays(D2, FINALIZE_WINDOW_DAYS);
    const later = new Date(`${addDays(yesterday, 1)}T03:00:00Z`);
    for (let d = D0; d <= yesterday; d = addDays(d, 1)) state.snapshots.set(d, seeded(d));
    // A forward-era day finalized earlier is not owed again.
    const D3 = addDays(D2, 1);
    const scan = fakeScan(days);
    const r = await runBackfill({ ...base, now: later, store, scan, dryRun: false });
    expect(scan.calls).toEqual([]);
    expect(r).toMatchObject({ ok: true, pending: 0, finalized: [D1, D2], finalize_owed: [] });
    expect(state.values.get(`${D2}|super_validators`)).toMatchObject({ status: "final" });
    // Days inside the window are the finalize job's.
    expect([...state.values.keys()].some((k) => k.startsWith(`${D3}|`))).toBe(false);

    const again = await runBackfill({ ...base, now: later, store, scan, dryRun: false });
    expect(again).toMatchObject({ ok: true, finalized: [], finalize_owed: [] });
    expect(state.revisions).toEqual([]);
  });

  it("reads the value dates of the old days once per UTC day, one series per day", async () => {
    const { store, state } = memoryStore();
    const yesterday = addDays(D2, FINALIZE_WINDOW_DAYS);
    const later = new Date(`${addDays(yesterday, 1)}T03:00:00Z`);
    for (let d = D0; d <= yesterday; d = addDays(d, 1)) state.snapshots.set(d, seeded(d));
    const scans: string[] = [];
    const counted: RecordStore = {
      ...store,
      listValueDates: async (from, to) => {
        scans.push(`${from}..${to}`);
        return store.listValueDates(from, to);
      },
    };
    await runBackfill({ ...base, now: later, store: counted, scan: fakeScan(days), dryRun: false });
    expect(scans).toEqual([`${RECORD_FIRST_DATE}..${D2}`]);
    // The night's later runs, with nothing pending or owed, do not read it again.
    await runBackfill({ ...base, now: new Date(later.getTime() + 5 * 60_000), store: counted, scan: fakeScan(days), dryRun: false });
    expect(scans).toHaveLength(1);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.value_scan_date).toBe(addDays(yesterday, 1));

    // The next night reads it again. It finds the old day whose values are
    // gone (as if the cursor had lost it), and the day that has just left the
    // finalize job's window, which no job run settled in this test.
    const next = new Date(later.getTime() + 86_400_000);
    state.snapshots.set(addDays(yesterday, 1), seeded(addDays(yesterday, 1)));
    for (const key of [...state.values.keys()]) if (key.startsWith(`${D1}|`)) state.values.delete(key);
    const r = await runBackfill({ ...base, now: next, store: counted, scan: fakeScan(days), dryRun: false });
    expect(scans).toEqual([`${RECORD_FIRST_DATE}..${D2}`, `${RECORD_FIRST_DATE}..${addDays(D2, 1)}`]);
    expect(r).toMatchObject({ ok: true, finalized: [D1, addDays(D2, 1)], finalize_owed: [] });
  });

  it("keeps an old day whose finalize raises an alarm owed and alarmed until it settles, and applies a later release", async () => {
    const { store, state } = memoryStore();
    // D1 and D2 are older than the finalize job's window: only the backfill settles them.
    const yesterday = addDays(D2, FINALIZE_WINDOW_DAYS);
    const later = new Date(`${addDays(yesterday, 1)}T03:00:00Z`);
    for (let d = D0; d <= yesterday; d = addDays(d, 1)) state.snapshots.set(d, seeded(d));
    // 25% more featured apps than the day before: the gate holds D2's value.
    const featured = Math.round(seeded(D1).featured_apps! * 1.25);
    state.snapshots.set(D2, seeded(D2, { featured_apps: featured }));

    const first = await runBackfill({ ...base, now: later, store, scan: fakeScan(days), dryRun: false });
    expect(first).toMatchObject({
      ok: false, finalized: [D1, D2], finalize_owed: [D2], finalize_alarmed: [D2], finalize_alarms_new: [D2],
      finalize_errors: [], failures: [],
    });
    expect(first.finalize_alarms).toEqual([
      { date: D2, series: "featured_apps", state: "held", reason: expect.stringContaining("more than 20% in a day") },
    ]);
    expect(state.values.get(`${D2}|featured_apps`)).toMatchObject({ status: "provisional" });
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail).toMatchObject({ finalize_owed: [D2], finalize_alarmed: [D2] });

    // The latch is fed the alarm on every run while it stands, and the caller pages only on the first.
    expect(backfillOutcomes(first)).toContainEqual(
      expect.objectContaining({ id: "finalize-alarms", ok: false, detail: expect.stringContaining(`${D2} featured_apps held`) }),
    );
    const again = await runBackfill({ ...base, now: new Date(later.getTime() + 5 * 60_000), store, scan: fakeScan(days), dryRun: false });
    expect(again).toMatchObject({ ok: false, finalized: [D2], finalize_owed: [D2], finalize_alarmed: [D2], finalize_alarms_new: [] });
    expect(backfillOutcomes(again)).toContainEqual(expect.objectContaining({ id: "finalize-alarms", ok: false }));

    // A human checks the value and releases the hold: the next run settles the day.
    state.cursors.set(CURSOR_OVERRIDES, {
      id: CURSOR_OVERRIDES, last_round: null, last_date: null, last_poll_at: null,
      detail: { release_holds: [`${D2}|featured_apps|${featured}`] },
    });
    const released = await runBackfill({ ...base, now: new Date(later.getTime() + 10 * 60_000), store, scan: fakeScan(days), dryRun: false });
    expect(released).toMatchObject({
      ok: true, finalized: [D2], finalize_owed: [], finalize_alarmed: [], finalize_alarms: [], finalize_alarms_new: [],
    });
    expect(state.values.get(`${D2}|featured_apps`)).toMatchObject({ value: `${featured}.0000000000`, status: "final" });
    expect(backfillOutcomes(released)).toContainEqual(expect.objectContaining({ id: "finalize-alarms", ok: true }));

    // Settled, it is owed no more.
    const quiet = await runBackfill({ ...base, now: new Date(later.getTime() + 15 * 60_000), store, scan: fakeScan(days), dryRun: false });
    expect(quiet).toMatchObject({ ok: true, finalized: [], finalize_owed: [], finalize_alarmed: [] });
  });

  it("finalizes the days owed their first finalize before the days already alarmed", async () => {
    const { store, state } = memoryStore();
    const owed = Array.from({ length: BACKFILL_FINALIZE_MAX_DAYS + 2 }, (_, i) => addDays(RECORD_FIRST_DATE, i));
    const last = owed[owed.length - 1];
    const later = new Date(`${addDays(last, 1)}T03:00:00Z`);
    for (let d = D0; d <= last; d = addDays(d, 1)) state.snapshots.set(d, seeded(d));
    // The oldest days are alarmed from an earlier run; the newest two are owed their first finalize.
    const alarmed = owed.slice(0, BACKFILL_FINALIZE_MAX_DAYS);
    state.cursors.set(CURSOR_BACKFILL, {
      id: CURSOR_BACKFILL, last_round: null, last_date: null, last_poll_at: null,
      detail: { attempts: {}, finalize_owed: owed, finalize_alarmed: alarmed },
    });
    const r = await runBackfill({ ...base, now: later, store, scan: fakeScan(days), dryRun: false });
    expect(r.finalized).toEqual([...owed.slice(BACKFILL_FINALIZE_MAX_DAYS), ...alarmed.slice(0, BACKFILL_FINALIZE_MAX_DAYS - 2)]);
    // They settle now, so the two alarmed days left for the next run are the only ones still owed.
    expect(r).toMatchObject({ ok: false, finalize_owed: alarmed.slice(-2), finalize_alarmed: alarmed.slice(-2), finalize_alarms_new: [] });
  });

  it("evaluates every held day again within two runs when more than BACKFILL_FINALIZE_MAX_DAYS are alarmed, and a released day first", async () => {
    const { store, state } = memoryStore();
    // D1 settles; each of the next BACKFILL_FINALIZE_MAX_DAYS + 2 days doubles
    // its featured apps, so the gate holds every one of them for good.
    const held = Array.from({ length: BACKFILL_FINALIZE_MAX_DAYS + 2 }, (_, i) => addDays(D1, i + 1));
    const last = held[held.length - 1];
    const featured = (d: string) => 127 * 2 ** dayIndex(d);
    for (let d = D0; d <= last; d = addDays(d, 1)) state.snapshots.set(d, seeded(d, { featured_apps: featured(d) }));
    state.cursors.set(CURSOR_BACKFILL, {
      id: CURSOR_BACKFILL, last_round: null, last_date: null, last_poll_at: null,
      detail: { attempts: {}, finalize_owed: [D1, ...held] },
    });
    const start = new Date(`${addDays(last, 1)}T03:00:00Z`).getTime();
    const run = (i: number) => runBackfill({ ...base, now: new Date(start + i * 5 * 60_000), store, scan: fakeScan(days), dryRun: false });

    // Two runs finalize every owed day once: all the held days are alarmed.
    const first = await run(0);
    expect(first.finalized).toEqual([D1, ...held.slice(0, BACKFILL_FINALIZE_MAX_DAYS - 1)]);
    const second = await run(1);
    expect(second.finalize_alarmed).toEqual(held);
    expect(second.finalize_alarms.every((a) => a.series === "featured_apps" && a.state === "held")).toBe(true);
    const evaluatedAt = state.cursors.get(CURSOR_BACKFILL)?.detail.alarm_evaluated_at as Record<string, string>;
    expect(Object.keys(evaluatedAt).sort()).toEqual(held);

    // Least recently evaluated first: any two runs in a row evaluate every held day.
    const third = await run(2);
    const fourth = await run(3);
    for (const r of [third, fourth]) expect(r.finalized).toHaveLength(BACKFILL_FINALIZE_MAX_DAYS);
    expect([...new Set([...third.finalized, ...fourth.finalized])].sort()).toEqual(held);
    expect(fourth).toMatchObject({ ok: false, finalize_alarmed: held, finalize_alarms_new: [] });

    // A human checks the newest day's value and releases it: the next run evaluates it first and settles it.
    state.cursors.set(CURSOR_OVERRIDES, {
      id: CURSOR_OVERRIDES, last_round: null, last_date: null, last_poll_at: null,
      detail: { release_holds: [`${last}|featured_apps|${featured(last)}`] },
    });
    const released = await run(4);
    expect(released.finalized[0]).toBe(last);
    expect(state.values.get(`${last}|featured_apps`)).toMatchObject({ status: "final" });
    expect(released).toMatchObject({ finalize_alarmed: held.slice(0, -1), finalize_owed: held.slice(0, -1) });
    expect(Object.keys(state.cursors.get(CURSOR_BACKFILL)?.detail.alarm_evaluated_at as Record<string, string>).sort()).toEqual(
      held.slice(0, -1),
    );
  });

  it("places the finalize job's slot from :28 to :45 of every hour", () => {
    const at = (hhmmss: string) => Date.parse(`${D1}T${hhmmss}Z`);
    expect(finalizeSlotStart(at("02:27:59"))).toBe(at("02:28:00"));
    expect(finalizeSlotStart(at("02:28:00"))).toBe(at("02:28:00"));
    expect(finalizeSlotStart(at("02:33:00"))).toBe(at("02:33:00"));
    expect(finalizeSlotStart(at("02:44:59"))).toBe(at("02:44:59"));
    expect(finalizeSlotStart(at("02:45:00"))).toBe(at("03:28:00"));
    expect(finalizeSlotStart(at("05:59:00"))).toBe(at("06:28:00"));
  });

  it("claims no FINALIZE_LOCK inside the finalize job's slot and owes the days to a later run", async () => {
    // At 02:33 the 02:35 finalize run is about to settle yesterday for the 03:00 promise.
    const { store, state } = memoryStore();
    for (const d of [D0, D1, D2]) state.snapshots.set(d, seeded(d));
    state.cursors.set(CURSOR_BACKFILL, {
      id: CURSOR_BACKFILL, last_round: null, last_date: null, last_poll_at: null, detail: { attempts: {}, finalize_owed: [D1, D2] },
    });
    let claims = 0;
    const finalizeLock = () => {
      claims += 1;
      return () => undefined;
    };
    const inSlot = new Date(`${addDays(D2, 1)}T02:33:00Z`);
    const r = await runBackfill({ ...base, now: inSlot, store, scan: fakeScan(days), dryRun: false, finalizeLock });
    expect(claims).toBe(0);
    expect(r).toMatchObject({
      ok: true, finalized: [], finalize_deferred: true, finalize_wait: "finalize_slot", finalize_owed: [D1, D2], finalize_errors: [],
    });
    expect(state.values.size).toBe(0);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([D1, D2]);

    // A run whose Scan part started at 02:20 and ran into the slot claims nothing either.
    // D1 is stored already, so the D0 this run stores makes D1 ready to finalize.
    const fresh = memoryStore();
    fresh.state.snapshots.set(D1, seeded(D1));
    const scan = fakeScan(days);
    let t = Date.now();
    const inner = scan.acsSnapshot.bind(scan);
    scan.acsSnapshot = (migrationId, recordTime, template, host, deadline) => {
      // Four calls of 120 s: the Scan part ends at 02:28, inside the slot and before the time bound.
      t += 120_000;
      return inner(migrationId, recordTime, template, host, deadline);
    };
    const before = new Date(`${addDays(D2, 1)}T02:20:00Z`);
    const late = await runBackfill({ ...base, now: before, store: fresh.store, scan, dryRun: false, clock: () => t, finalizeLock });
    expect(late).toMatchObject({ processed: [D0], finalize_deferred: true, finalize_wait: "finalize_slot", finalize_owed: [D1] });
    expect(claims).toBe(0);

    // At 02:45 the slot is over, and the owed days are finalized.
    const after = await runBackfill({ ...base, now: new Date(`${addDays(D2, 1)}T02:45:00Z`), store, scan: fakeScan(days), dryRun: false, finalizeLock });
    expect(claims).toBe(1);
    expect(after).toMatchObject({ ok: true, finalized: [D1, D2], finalize_deferred: false, finalize_wait: null, finalize_owed: [] });
  });

  it("starts no finalizeDate past BACKFILL_FINALIZE_GRACE_MS after the Scan deadline, nor from the slot's start, and leaves the rest owed", async () => {
    const owed = Array.from({ length: BACKFILL_FINALIZE_MAX_DAYS }, (_, i) => addDays(RECORD_FIRST_DATE, i));
    const last = owed[owed.length - 1];
    const day = 100_000;
    const run = async (at: string) => {
      const { store, state } = memoryStore();
      for (let d = D0; d <= last; d = addDays(d, 1)) state.snapshots.set(d, seeded(d));
      state.cursors.set(CURSOR_BACKFILL, {
        id: CURSOR_BACKFILL, last_round: null, last_date: null, last_poll_at: null, detail: { attempts: {}, finalize_owed: owed },
      });
      let t = Date.now();
      // Each finalizeDate reads its day's rounds once: 100 s a day on the run's clock.
      const slow: RecordStore = {
        ...store,
        getRoundsStartedBetween: async (fromIso, toIso) => {
          t += day;
          return store.getRoundsStartedBetween(fromIso, toIso);
        },
      };
      return runBackfill({ ...base, now: new Date(`${addDays(last, 1)}T${at}Z`), store: slow, scan: fakeScan(days), dryRun: false, clock: () => t });
    };

    // From 03:00 the slot is 28 minutes off, so the time is the bound: days
    // start at 0, 100, ... 500 s, and 600 s is past 520 + 45 s.
    const bound = Math.ceil((base.budgetMs + BACKFILL_FINALIZE_GRACE_MS) / day);
    const timed = await run("03:00:00");
    expect(timed).toMatchObject({ ok: true, finalized: owed.slice(0, bound), finalize_owed: owed.slice(bound), finalize_wait: "time", finalize_deferred: false });

    // From 03:20 the slot's start at 03:28 comes first: days start at 0 to 400 s.
    const slotted = await run("03:20:00");
    expect(slotted).toMatchObject({ ok: true, finalized: owed.slice(0, 5), finalize_owed: owed.slice(5), finalize_wait: "finalize_slot" });
  });
});

describe("the license completion pass", () => {
  it("completes stored rows oldest first, owes each day a finalize and finalizes it", async () => {
    const { store, state } = memoryStore();
    for (const d of [addDays(RECORD_FIRST_DATE, -1), D1, D2]) state.snapshots.set(d, seeded(d, { validator_licenses: null }));
    const r = await runBackfill({ ...base, store, scan: fakeScan({ ...days, cls: "backfill" }), dryRun: false, licensePass: true });
    // The stage works on yesterday (D2 at 03:00 of D3), so the pass stops at D1.
    expect(r.licenses_added).toEqual([D1]);
    expect(state.snapshots.get(D1)?.validator_licenses).toBe(2);
    expect(state.snapshots.get(D2)?.validator_licenses).toBeNull();
    expect(r.finalized).toContain(D1);
    expect(state.values.get(`${D1}|validator_licenses`)).toMatchObject({ value: "2.0000000000", status: "final" });
    expect(r.ok).toBe(true);
  });

  it("does nothing without licensePass, which keeps the day reads as they were", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const r = await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: false });
    expect(r.licenses_added).toEqual([]);
    expect(state.snapshots.get(D1)?.validator_licenses).toBeNull();
  });

  it("spends an attempt on a failed read and gives the day up after three, BACKFILL_RETRY_MS apart", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const broken = fakeScan({ ...days, cls: "backfill", acsErrors: { [TEMPLATES.validatorLicense]: new Error("shape") } });
    // A minute past the spacing each time: a failure is stamped a few ms after its run's start.
    const at = (i: number) => new Date(now.getTime() + i * (BACKFILL_RETRY_MS + 60_000));
    for (let n = 1; n <= 3; n++) {
      const r = await runBackfill({ ...base, now: at(n - 1), store, scan: broken, dryRun: false, licensePass: true });
      expect(r.license_failures.map((f) => f.date)).toEqual([D1]);
      expect(r.licenses_given_up).toEqual(n === 3 ? [D1] : []);
      expect(r.ok).toBe(false);
    }
    const after = await runBackfill({ ...base, now: at(3), store, scan: broken, dryRun: false, licensePass: true });
    expect(after.license_failures).toEqual([]);
    // A given-up day stays listed on every later run until it is cleared by hand, so the latch keeps failing on it.
    expect(after.licenses_given_up).toEqual([D1]);
    expect((state.cursors.get(CURSOR_BACKFILL)?.detail.license_attempts as Record<string, number>)[D1]).toBe(3);
  });

  it("holds a day back BACKFILL_RETRY_MS after a failed read: no attempt spent and no call made until then", async () => {
    const { store, state } = memoryStore();
    // Every day stored, so no day read comes first: only the license read makes calls.
    for (const d of [D0, D2]) state.snapshots.set(d, seeded(d));
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const detail = () => state.cursors.get(CURSOR_BACKFILL)?.detail;
    const broken = () => fakeScan({ ...days, cls: "backfill", acsErrors: { [TEMPLATES.validatorLicense]: new Error("shape") } });
    const at = (i: number) => new Date(now.getTime() + i * (BACKFILL_RETRY_MS + 60_000));

    const first = await runBackfill({ ...base, now: at(0), store, scan: broken(), dryRun: false, licensePass: true });
    expect(first.license_failures.map((f) => f.date)).toEqual([D1]);
    expect((detail()?.license_attempts as Record<string, number>)[D1]).toBe(1);
    const stamped = Date.parse((detail()?.license_failed_at as Record<string, string>)[D1]);
    expect(stamped - now.getTime()).toBeGreaterThanOrEqual(0);
    expect(stamped - now.getTime()).toBeLessThan(10_000);

    // The next runs come five minutes apart: a transient failure must not burn the day's attempts.
    for (const minutes of [5, 10, 85]) {
      const early = broken();
      const held = await runBackfill({ ...base, now: new Date(now.getTime() + minutes * 60_000), store, scan: early, dryRun: false, licensePass: true });
      expect(early.calls).toEqual([]);
      expect(held).toMatchObject({ ok: true, license_failures: [], licenses_added: [], licenses_given_up: [] });
      expect((detail()?.license_attempts as Record<string, number>)[D1]).toBe(1);
    }

    // Once the spacing has passed the second attempt is spent, and again the day is held back.
    const second = await runBackfill({ ...base, now: at(1), store, scan: broken(), dryRun: false, licensePass: true });
    expect(second.license_failures.map((f) => f.date)).toEqual([D1]);
    expect((detail()?.license_attempts as Record<string, number>)[D1]).toBe(2);
    const early = broken();
    await runBackfill({ ...base, now: new Date(at(1).getTime() + 5 * 60_000), store, scan: early, dryRun: false, licensePass: true });
    expect(early.calls).toEqual([]);
    expect((detail()?.license_attempts as Record<string, number>)[D1]).toBe(2);

    // A read that answers completes the day and clears both counts.
    const done = await runBackfill({ ...base, now: at(2), store, scan: fakeScan({ ...days, cls: "backfill" }), dryRun: false, licensePass: true });
    expect(done).toMatchObject({ ok: true, licenses_added: [D1] });
    expect(detail()).toMatchObject({ license_attempts: {}, license_failed_at: {} });
  });

  it("an outage spends no attempt and ends the pass", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const down = fakeScan({
      ...days, cls: "backfill",
      acsErrors: { [TEMPLATES.validatorLicense]: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 503, "down") },
    });
    const r = await runBackfill({ ...base, store, scan: down, dryRun: false, licensePass: true });
    expect(r.license_failures).toMatchObject([{ date: D1, outage: true }]);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.license_attempts ?? {}).toEqual({});
  });

  it("starts a license read only while licenseReadHeadroomMs of its class is left", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const tight = fakeScan({ ...days, cls: "backfill" });
    const none = await runBackfill({ ...base, store, scan: tight, dryRun: false, licensePass: true, budgetMs: licenseReadHeadroomMs("backfill") - 1 });
    expect(none.licenses_added).toEqual([]);
    expect(tight.calls.filter((c) => c.startsWith("acs "))).toEqual([]);
    // One more millisecond and the read starts. The run's clock stands still at its start: the budget is
    // exactly the headroom, so a real clock that moved a millisecond before the check would refuse the read.
    const started = Date.now();
    const fits = await runBackfill({
      ...base, store, scan: fakeScan({ ...days, cls: "backfill" }), dryRun: false, licensePass: true,
      budgetMs: licenseReadHeadroomMs("backfill"), clock: () => started,
    });
    expect(fits.licenses_added).toEqual([D1]);
  });

  it("yields to the budget without a failure or a spent attempt", async () => {
    const { store, state } = memoryStore();
    // Every day stored, so no day read comes first and the pass itself meets the busy budget.
    state.snapshots.set(D0, seeded(D0));
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    state.snapshots.set(D2, seeded(D2));
    const busy = fakeScan({ cls: "backfill", error: new ScanBusyError("api.cantonnodes.com", "window") });
    const r = await runBackfill({ ...base, store, scan: busy, dryRun: false, licensePass: true });
    expect(r).toMatchObject({ ok: true, yielded: "window", licenses_added: [], license_failures: [] });
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.license_attempts ?? {}).toEqual({});
  });

  it("a failed license read alone makes the run not ok", async () => {
    const { store, state } = memoryStore();
    for (const d of [D0, D2]) state.snapshots.set(d, seeded(d));
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const scan = (ok: boolean) =>
      fakeScan({ ...days, cls: "backfill", acsErrors: ok ? {} : { [TEMPLATES.validatorLicense]: new Error("shape") } });
    // The same store and days, so the finalize part is identical: only the license read differs.
    expect(await runBackfill({ ...base, store, scan: scan(false), dryRun: false, licensePass: true })).toMatchObject({ ok: false, finalize_errors: [], finalize_alarms: [] });
    // Two hours on, past the failed read's BACKFILL_RETRY_MS hold and outside the finalize job's slot.
    const later = new Date(now.getTime() + 2 * 3_600_000);
    expect(await runBackfill({ ...base, now: later, store, scan: scan(true), dryRun: false, licensePass: true })).toMatchObject({ ok: true, licenses_added: [D1] });
  });

  it("a store failure is not the day's: it spends no attempt and ends the pass", async () => {
    const { store, state } = memoryStore();
    for (const d of [D0, D2]) state.snapshots.set(d, seeded(d));
    for (const d of [D1, addDays(D1, 1)]) state.snapshots.set(d, seeded(d, { validator_licenses: null }));
    const failing: RecordStore = { ...store, upsertSnapshot: async () => { throw new Error("db down"); } };
    const r = await runBackfill({
      ...base, now: new Date(`${addDays(D2, 2)}T03:00:00Z`), store: failing, scan: fakeScan({ ...days, cls: "backfill" }), dryRun: false, licensePass: true,
    });
    // One write tried, one failure, the pass over: the next day's read is not started.
    expect(r.license_failures).toMatchObject([{ date: "run", error: "db down" }]);
    expect(r.licenses_added).toEqual([]);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.license_attempts ?? {}).toEqual({});
  });

  it("owes the day on the cursor before it writes the count, so a restart between them loses no finalize", async () => {
    const { store, state } = memoryStore();
    for (const d of [D0, D2]) state.snapshots.set(d, seeded(d));
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const owedAtWrite: string[][] = [];
    const watching: RecordStore = {
      ...store,
      upsertSnapshot: async (row) => {
        owedAtWrite.push([...((state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed as string[] | undefined) ?? [])]);
        return store.upsertSnapshot(row);
      },
    };
    await runBackfill({ ...base, store: watching, scan: fakeScan({ ...days, cls: "backfill" }), dryRun: false, licensePass: true });
    expect(owedAtWrite).toEqual([[D1]]);
  });

  it("lists a given-up day on every run, the early return of a settled store included", async () => {
    const { store, state } = memoryStore();
    // Every day stored and nothing owed: no day to read, and the only row lacking its count has spent its attempts.
    for (const d of [D0, D2]) state.snapshots.set(d, seeded(d));
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    state.cursors.set(CURSOR_BACKFILL, {
      id: CURSOR_BACKFILL, last_round: null, last_date: null, last_poll_at: now.toISOString(),
      detail: { license_attempts: { [D1]: BACKFILL_MAX_ATTEMPTS } },
    });
    const scan = fakeScan({ ...days, cls: "backfill" });
    const r = await runBackfill({ ...base, store, scan, dryRun: false, licensePass: true });
    expect(scan.calls.filter((c) => c.startsWith("acs "))).toEqual([]);
    expect(r).toMatchObject({ pending: 0, done: true, licenses_added: [], license_failures: [], licenses_given_up: [D1] });
    // A dry run and a run without the pass read no license rows, so they name none.
    expect((await runBackfill({ ...base, store, scan, dryRun: true })).licenses_given_up).toEqual([]);
    expect((await runBackfill({ ...base, store, scan, dryRun: false })).licenses_given_up).toEqual([]);
  });

  it("moves a day already finalized with a null count to the count, through a backfill revision that resolves its gap", async () => {
    const { store, state } = memoryStore();
    // The night as it ran before the pass: every day stored without a count, and D1 and D2 finalized with a final null and an open gap.
    await runBackfill({ ...base, store, scan: fakeScan(days), dryRun: false });
    const key = `${D1}|validator_licenses`;
    const openGaps = () => state.gaps.filter((g) => g.date === D1 && g.series === "validator_licenses" && g.resolved_at == null);
    expect(state.values.get(key)).toMatchObject({ value: null, status: "final", revision: 0 });
    expect(openGaps()).toHaveLength(1);
    expect(state.revisions.filter((x) => x.date === D1 && x.series === "validator_licenses")).toEqual([]);
    expect(state.cursors.get(CURSOR_BACKFILL)?.detail.finalize_owed).toEqual([]);

    // Nothing is pending: the owed day alone brings the run past the early return and into finalizeQueue.
    const r = await runBackfill({ ...base, store, scan: fakeScan({ ...days, cls: "backfill" }), dryRun: false, licensePass: true });
    expect(r).toMatchObject({ pending: 0, licenses_added: [D1], ok: true });
    expect(r.finalized).toContain(D1);
    expect(state.values.get(key)).toMatchObject({ value: "2.0000000000", status: "final", revision: 1 });
    expect(openGaps()).toEqual([]);
    expect(state.revisions.filter((x) => x.date === D1 && x.series === "validator_licenses")).toMatchObject([
      { kind: "backfill", old_value: null, new_value: "2.0000000000" },
    ]);
  });

  it("does not start the pass after the day reads met a Scan outage", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set(D0, seeded(D0));
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    // D2 is the day to read; its core read meets a 503, the license read would answer.
    const down = fakeScan({
      ...days, cls: "backfill",
      acsErrors: { [TEMPLATES.dsoRules]: new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 503, "down") },
    });
    const r = await runBackfill({ ...base, store, scan: down, dryRun: false, licensePass: true });
    expect(r.failures).toMatchObject([{ date: D2, outage: true }]);
    expect(r.licenses_added).toEqual([]);
    expect(down.calls.some((c) => c.includes(TEMPLATES.validatorLicense))).toBe(false);
    expect(state.snapshots.get(D1)?.validator_licenses).toBeNull();
  });

  it("reports license failures and given-up days on the backfill latch", async () => {
    const { store, state } = memoryStore();
    state.snapshots.set(D1, seeded(D1, { validator_licenses: null }));
    const broken = fakeScan({ ...days, cls: "backfill", acsErrors: { [TEMPLATES.validatorLicense]: new Error("shape") } });
    const r = await runBackfill({ ...base, store, scan: broken, dryRun: false, licensePass: true });
    expect(backfillOutcomes(r)).toContainEqual(expect.objectContaining({ id: "licenses", ok: false }));
    // No license work (the pass lists rows before the run's own inserts, so a fresh store has none): no signal.
    const quiet = await runBackfill({ ...base, store: memoryStore().store, scan: fakeScan(days), dryRun: false, licensePass: true });
    expect(quiet.licenses_added).toEqual([]);
    expect(backfillOutcomes(quiet)).toContainEqual(expect.objectContaining({ id: "licenses", skipped: true }));
  });
});
