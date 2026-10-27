import { describe, expect, it } from "vitest";
import { CURSOR_FORWARD, CURSOR_SNAPSHOT } from "../../open-record/contract";
import { TEMPLATES } from "../acs";
import {
  COLLECTOR_LIMITS,
  COLLECTOR_LOCK,
  estimateStartMs,
  forwardSnapshotHealth,
  forwardStartIssuingHealth,
  runForwardCollection,
} from "../collector";
import type { ScanTransaction } from "../rounds";
import { ScanBusyError } from "../scan-budget";
import { ScanHttpError, ScanTimeoutError, scanCallWorstCaseMs, type ScanApi } from "../scan-client";
import { SNAPSHOT_RETRY, snapshotCoreHeadroomMs } from "../snapshot";
import { blankRound, type CursorRow, type RecordStore, type SnapshotRow } from "../store";
import { fakeScan, loadFixture, type FakeScanOptions } from "./helpers/fake-scan";
import { memoryStore, type MemoryState } from "./helpers/memory-store";

const rounds = loadFixture("open-and-issuing.json");
const transactions: ScanTransaction[] = loadFixture("updates-start-issuing-114513.json").transactions;
const acs = loadFixture("acs-snapshot-2026-06-01.json");
// 06:10 UTC: the daily snapshot stage runs too, which is fine; the first tests look at rounds.
const now = new Date("2026-09-24T06:10:00Z");
/** Before 04:00 UTC, so a day with no snapshot row waits instead of starving. */
const early = new Date("2026-09-24T01:10:00Z");
const YESTERDAY = "2026-09-23";
/** A lock deadline far enough away for every read of the run. */
const later = () => Date.now() + 10 * 60_000;
const live = (over: FakeScanOptions = {}) => fakeScan({ openAndIssuing: rounds, transactions, acs, ...over });
const acsCalls = (scan: { calls: string[] }) => scan.calls.filter((c) => c.startsWith("acs "));
const notFound = () => new ScanHttpError("api.cantonnodes.com", "/v0/state/acs", 404, "not found");
/** Unrelated transactions, as live mainnet has them: 2.1 to 2.9 per second from June to September 2026. */
const filler = (from: string, count: number, stepMs: number): ScanTransaction[] =>
  Array.from({ length: count }, (_, i) => ({
    update_id: `filler-${from}-${i}`,
    migration_id: 4,
    record_time: new Date(Date.parse(from) + i * stepMs).toISOString(),
    events_by_id: {},
  }));

/** A store that logs every cursor row read or written, in order. */
function cursorLog(store: RecordStore) {
  const ids: string[] = [];
  const logged: RecordStore = {
    ...store,
    getCursor: (id) => {
      ids.push(`get ${id}`);
      return store.getCursor(id);
    },
    setCursor: (row) => {
      ids.push(`set ${row.id}`);
      return store.setCursor(row);
    },
  };
  return { store: logged, ids };
}

/** Records the deadline every acsSnapshot call was given. */
function deadlines(scan: ScanApi) {
  const seen: Array<number | undefined> = [];
  const inner = scan.acsSnapshot.bind(scan);
  scan.acsSnapshot = (migrationId, recordTime, template, host, deadline) => {
    seen.push(deadline);
    return inner(migrationId, recordTime, template, host, deadline);
  };
  return seen;
}

/** A run clock that each updates page moves on by `stepMs`, for a slow queue. */
function slowUpdates(scan: ScanApi, stepMs: number) {
  let t = Date.now();
  const inner = scan.updatesAfter.bind(scan);
  scan.updatesAfter = async (migrationId, afterRecordTime, pageSize, deadline) => {
    const res = await inner(migrationId, afterRecordTime, pageSize, deadline);
    t += stepMs;
    return res;
  };
  return () => t;
}
const updatesCalls = (scan: { calls: string[] }) => scan.calls.filter((c) => c.startsWith("updatesAfter"));

/** Records the deadline each round-collection call was given, by method. */
function roundDeadlines(scan: ScanApi) {
  const seen: Array<[string, number | undefined]> = [];
  const migrationId = scan.migrationId.bind(scan);
  const openAndIssuing = scan.openAndIssuing.bind(scan);
  const updatesAfter = scan.updatesAfter.bind(scan);
  scan.migrationId = (deadline) => {
    seen.push(["migrationId", deadline]);
    return migrationId(deadline);
  };
  scan.openAndIssuing = (deadline) => {
    seen.push(["openAndIssuing", deadline]);
    return openAndIssuing(deadline);
  };
  scan.updatesAfter = (migrationId, afterRecordTime, pageSize, deadline) => {
    seen.push(["updatesAfter", deadline]);
    return updatesAfter(migrationId, afterRecordTime, pageSize, deadline);
  };
  return seen;
}

const captured = (round: number, at: string) => ({
  ...blankRound(round, "api.cantonnodes.com"), start_issuing_at: at, update_id: `u${round}`,
});
/**
 * No round issuing and the oldest open round is `next`. `next - 1` may still
 * be summarizing (open-and-issuing lists no summarizing round), so the rounds
 * known to have started are those below `next - 1`.
 */
const openFrom = (next: number) => ({ ...rounds, issuing_mining_rounds: {}, open_mining_rounds: {
  x: { contract: { ...rounds.open_mining_rounds["00f4057cd4439d88"].contract, payload: { ...rounds.open_mining_rounds["00f4057cd4439d88"].contract.payload, round: { number: String(next) } } } },
} });

/**
 * The last of a full first repair page of unrelated transactions that start
 * at 06:03:41, 100 ms apart: 06:03:41 plus repairPageSize - 1 steps.
 */
const lastOfFirstPage = new Date(Date.parse("2026-09-24T06:03:41Z") + (COLLECTOR_LIMITS.repairPageSize - 1) * 100).toISOString();

/** Minutes after 06:40 UTC, when 114513 and 114514 have started and the snapshot stage is due. */
const at = (minutes: number) => new Date(Date.parse("2026-09-24T06:40:00Z") + minutes * 60_000);
const unavailable = () => new ScanHttpError("api.cantonnodes.com", "/v2/updates", 503, "upstream unavailable");

/**
 * Unrelated transactions every 10 s from 05:50 to 06:40 UTC, past the end of
 * every repair window in these tests: a window without its round pages to its
 * end and misses. (An empty page short of a window's end is no miss.)
 */
const withoutTheRound = filler("2026-09-24T05:50:00.000Z", 301, 10_000);

/** A second entry of SCAN_RECORD_HOSTS, which a request can fall back to. */
const FALLBACK_HOST = "scan.fallback.example";

/** Answers each updates page from the host `hostOf` names for it (page 0 first), as a fallback along SCAN_RECORD_HOSTS would. */
function updatesFrom(scan: ScanApi, hostOf: (page: number) => string) {
  const inner = scan.updatesAfter.bind(scan);
  let page = 0;
  scan.updatesAfter = async (migrationId, afterRecordTime, pageSize, deadline) => {
    const res = await inner(migrationId, afterRecordTime, pageSize, deadline);
    return { ...res, host: hostOf(page++) };
  };
}

/** 114512 and 114514 captured, 114513 missing, and the forward cursor at 114512 with `detail`; returns the cursor row. */
function gapAt114513(state: MemoryState, detail: Record<string, unknown> = {}): CursorRow {
  state.rounds.set(114512, captured(114512, "2026-09-24T05:55:50Z"));
  state.rounds.set(114514, captured(114514, "2026-09-24T06:16:30Z"));
  const row: CursorRow = { id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: null, detail };
  state.cursors.set(CURSOR_FORWARD, row);
  return row;
}

const REFUSED = "network_record_rounds write refused";
/** A store that refuses every StartIssuing capture, as in a partial database write outage. */
const refusingCaptures = (store: RecordStore): RecordStore => ({
  ...store,
  upsertRoundCaptures: async () => {
    throw new Error(REFUSED);
  },
});

/** A run clock that each ACS call moves on by `stepMs`, for a snapshot stage that spends the run. */
function slowAcs(scan: ScanApi, stepMs: number) {
  let t = Date.now();
  const inner = scan.acsSnapshot.bind(scan);
  scan.acsSnapshot = async (migrationId, recordTime, template, host, deadline) => {
    const res = await inner(migrationId, recordTime, template, host, deadline);
    t += stepMs;
    return res;
  };
  return () => t;
}

describe("runForwardCollection", () => {
  it("captures a round the moment it starts issuing and starts the cursor there", async () => {
    const { store, state } = memoryStore();
    const r = await runForwardCollection({ store, scan: live(), now, deadline: later() });

    expect(r.ok).toBe(true);
    expect(r.captured).toEqual([114513]);
    const row = state.rounds.get(114513)!;
    expect(row).toMatchObject({
      start_issuing_at: "2026-09-24T06:06:09.881439Z",
      update_id: "1220f8518aa9",
      app_rewards_cc: "112062.40486338091017470402",
      unclaimed_rewards_cc: "19153.49245086550000000000",
      method: "scan-1",
      repaired: false,
    });
    // The open round's meta was stored while it was open.
    expect(state.rounds.get(114683)).toMatchObject({ amulet_price: "0.119296", tick_duration_us: 600000000 });
    expect(state.cursors.get(CURSOR_FORWARD)).toMatchObject({ last_round: 114513, last_poll_at: now.toISOString() });
    expect(state.cursors.get(CURSOR_FORWARD)?.detail.started_at).toBe(now.toISOString());
  });

  it("finds the StartIssuing behind dozens of unrelated transactions, as on live mainnet", async () => {
    // probe big_2026-09-24T06.json: 23 transactions sit between createdAt - 5 s and
    // round 114513's StartIssuing. Sixty here, packed into the 1.5 s before it.
    const { store } = memoryStore();
    const busy = [...filler("2026-09-24T06:06:08.200Z", 60, 25), ...transactions];
    const r = await runForwardCollection({ store, scan: live({ transactions: busy }), now, deadline: later() });
    expect(r.captured).toEqual([114513]);
    expect(r.not_located).toEqual([]);
  });

  it("does not call Scan again for a round it already has", async () => {
    const { store } = memoryStore();
    await runForwardCollection({ store, scan: live(), now, deadline: later() });
    const again = live();
    const r = await runForwardCollection({ store, scan: again, now, deadline: later() });
    expect(r.captured).toEqual([]);
    expect(again.calls.some((c) => c.startsWith("updatesAfter"))).toBe(false);
  });

  it("reports a round whose StartIssuing it cannot find, and stays not ok", async () => {
    const { store } = memoryStore();
    const r = await runForwardCollection({ store, scan: live({ transactions: [] }), now, deadline: later() });
    expect(r.not_located).toEqual([114513]);
    expect(r.ok).toBe(false);
  });

  it("repairs a missed round between two captured neighbours, then advances the cursor past it", async () => {
    const { store, state } = memoryStore();
    state.rounds.set(114512, { ...blankRound(114512, "api.cantonnodes.com"), start_issuing_at: "2026-09-24T05:55:50Z", update_id: "u512" });
    state.rounds.set(114514, { ...blankRound(114514, "api.cantonnodes.com"), start_issuing_at: "2026-09-24T06:16:30Z", update_id: "u514" });
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: null, detail: { started_at: "2026-09-20T00:00:00Z" } });
    // Nothing issuing right now and the oldest open round is 114517: 114516 may
    // still be summarizing, so 114513 to 114515 are the rounds known to have started.
    const openOnly = openFrom(114517);

    // Hundreds of unrelated transactions between the repair window's start
    // (estimate 06:06:10 minus 150 s) and the round, fewer than a page holds: one page covers them.
    const busy = [...filler("2026-09-24T06:03:41.000Z", 400, 370), ...transactions];
    const scan = live({ openAndIssuing: openOnly, transactions: busy });
    const r = await runForwardCollection({ store, scan, now: new Date("2026-09-24T06:40:00Z"), deadline: later() });

    // The due snapshot (four core templates and the license count) goes before the repair.
    expect(scan.calls.map((c) => c.split(" ")[0])).toEqual([
      "migrationId", "openAndIssuing", "acs", "acs", "acs", "acs", "acs", "updatesAfter",
    ]);
    expect(r.repaired).toEqual([114513]);
    expect(state.rounds.get(114513)).toMatchObject({ repaired: true, update_id: "1220f8518aa9" });
    expect(r.missing).toEqual([114515]);
    expect(r.cursor).toBe(114514);
  });

  it("names on a capture the host that served its StartIssuing, not the host that answered the poll", async () => {
    const { store, state } = memoryStore();
    const scan = live();
    updatesFrom(scan, () => FALLBACK_HOST);
    const r = await runForwardCollection({ store, scan, now, deadline: later() });

    expect(r).toMatchObject({ ok: true, host: "api.cantonnodes.com", captured: [114513] });
    expect(state.rounds.get(114513)).toMatchObject({ update_id: "1220f8518aa9", source_host: FALLBACK_HOST });
    // The open round's meta came from the poll, and names the poll's host.
    expect(state.rounds.get(114683)?.source_host).toBe("api.cantonnodes.com");
  });

  it("names on a repaired round the host of the page that held it, when its window paged across two hosts", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state);
    // A full first page that ends before the window does, then the page with the round, from the fallback host.
    const dense = [...filler("2026-09-24T06:03:41.000Z", COLLECTOR_LIMITS.repairPageSize, 100), ...transactions];
    const scan = live({ openAndIssuing: openFrom(114516), transactions: dense });
    updatesFrom(scan, (page) => (page === 0 ? "api.cantonnodes.com" : FALLBACK_HOST));
    const r = await runForwardCollection({ store, scan, now: at(0), deadline: later() });

    expect(updatesCalls(scan)).toHaveLength(2);
    expect(r).toMatchObject({ ok: true, host: "api.cantonnodes.com", repaired: [114513], cursor: 114514 });
    expect(state.rounds.get(114513)).toMatchObject({ repaired: true, update_id: "1220f8518aa9", source_host: FALLBACK_HOST });
  });

  it("gives up on a round after three repair attempts, reports it once as abandoned, and holds it on the given-up latch", async () => {
    const { store, state } = memoryStore();
    state.rounds.set(114512, { ...blankRound(114512, "api.cantonnodes.com"), start_issuing_at: "2026-09-24T05:55:50Z", update_id: "u512" });
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: null, detail: {} });
    const openOnly = { ...rounds, issuing_mining_rounds: {} };
    const runs = [];
    for (let i = 0; i < 4; i++) {
      runs.push(await runForwardCollection({ store, scan: live({ openAndIssuing: openOnly, transactions: withoutTheRound }), now, deadline: later() }));
    }
    const attempts = () => state.cursors.get(CURSOR_FORWARD)?.detail.repair_attempts as Record<string, number>;
    expect(attempts()["114513"]).toBe(COLLECTOR_LIMITS.repairAttempts);
    expect(runs.map((r) => r.abandoned)).toEqual([[], [], [114513], []]);
    // Still missing, never paged again: the fourth run spends its repair on the next round.
    expect(runs[3].missing).toContain(114513);
    expect(attempts()["114514"]).toBe(1);

    // Two more runs use up 114514 as well.
    for (let i = 0; i < 2; i++) {
      runs.push(await runForwardCollection({ store, scan: live({ openAndIssuing: openOnly, transactions: withoutTheRound }), now, deadline: later() }));
    }
    expect(runs.map((r) => r.abandoned)).toEqual([[], [], [114513], [], [], [114514]]);
    // The runs after a loss still fail start-issuing: the latch holds it, and a second loss starts it over.
    const n = COLLECTOR_LIMITS.givenUpRuns;
    const latch = (total: number, last: number, runsLeft: number) => ({ total, first: 114513, last, runs_left: runsLeft });
    expect(runs.map((r) => r.given_up)).toEqual([
      null, null, latch(1, 114513, n - 1), latch(1, 114513, n - 2), latch(1, 114513, n - 3), latch(2, 114514, n - 1),
    ]);
    expect(runs.map((r) => r.ok)).toEqual([true, true, false, false, false, false]);
    expect(forwardStartIssuingHealth(runs[3])).toEqual({ health: "failing", detail: "given_up: round 114513" });
    expect(forwardStartIssuingHealth(runs[5])).toEqual({ health: "failing", detail: "given_up: 2 rounds from 114513 to 114514" });
  });

  it("widens the window on each miss instead of repeating it: +/-150 s, +/-300 s, then +/-600 s around the estimate", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state);
    // Halfway between 114512 (05:55:50) and 114514 (06:16:30).
    const estimate = Date.parse("2026-09-24T06:06:10Z");
    const starts: string[] = [];
    const runs = [];
    for (let i = 0; i < COLLECTOR_LIMITS.repairAttempts; i++) {
      const scan = live({ openAndIssuing: openFrom(114516), transactions: withoutTheRound });
      runs.push(await runForwardCollection({ store, scan, now: at(5 * i), deadline: later() }));
      starts.push(...updatesCalls(scan).map((c) => c.slice("updatesAfter ".length)));
    }
    const lead = COLLECTOR_LIMITS.repairLeadMs;
    expect(starts).toEqual([1, 2, 4].map((k) => new Date(estimate - k * lead).toISOString()));
    expect(runs.map((r) => r.abandoned)).toEqual([[], [], [114513]]);
  });

  it("finds on its second attempt a round that starts 150 to 300 s after the estimate, and never repeats a window", async () => {
    const { store, state } = memoryStore();
    // Neighbours that put 114513's estimate at 06:02:50, 199.9 s before its StartIssuing (06:06:09.881439).
    state.rounds.set(114512, captured(114512, "2026-09-24T05:52:30Z"));
    state.rounds.set(114514, captured(114514, "2026-09-24T06:13:10Z"));
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: null, detail: {} });
    const estimate = Date.parse("2026-09-24T06:02:50Z");
    const lead = COLLECTOR_LIMITS.repairLeadMs;
    // Unrelated transactions from just inside the first window, spaced so that one page spans it:
    // the first attempt's page ends just past that window and about 48 s short of the StartIssuing.
    const step = (2 * lead) / COLLECTOR_LIMITS.repairPageSize;
    const from = estimate - lead + 2_000;
    const count = Math.floor((estimate + 190_000 - from) / step) + 1;
    const busy = [...filler(new Date(from).toISOString(), count, step), ...transactions];
    const run = async (minutes: number) => {
      const scan = live({ openAndIssuing: openFrom(114516), transactions: busy });
      const r = await runForwardCollection({ store, scan, now: at(minutes), deadline: later() });
      return { r, starts: updatesCalls(scan).map((c) => c.slice("updatesAfter ".length)) };
    };

    const first = await run(0);
    expect(first.starts).toEqual([new Date(estimate - lead).toISOString()]);
    expect(first.r).toMatchObject({ ok: true, repaired: [], missing: [114513], abandoned: [], cursor: 114512 });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail.repair_attempts).toEqual({ "114513": 1 });

    // Twice as wide: the first page ends where the first attempt's did, still inside, and the next one holds the round.
    const second = await run(5);
    const pageEnd = new Date(from + (COLLECTOR_LIMITS.repairPageSize - 1) * step).toISOString();
    expect(second.starts).toEqual([new Date(estimate - 2 * lead).toISOString(), pageEnd]);
    expect(second.r).toMatchObject({ ok: true, repaired: [114513], missing: [], cursor: 114514 });
    expect(state.rounds.get(114513)).toMatchObject({ repaired: true, update_id: "1220f8518aa9" });
    // No page of either attempt starts where another one did.
    const all = [...first.starts, ...second.starts];
    expect(new Set(all).size).toBe(all.length);
  });

  it("puts a repair that fails with a Scan error on a backoff instead of spending an attempt, and still writes the cursor and reaches the snapshot", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state);
    const r = await runForwardCollection({ store, scan: live({ openAndIssuing: openFrom(114516), updatesError: unavailable() }), now: at(0), deadline: later() });

    expect(r.repair_errors).toEqual([expect.stringContaining("503")]);
    expect(r).toMatchObject({
      ok: false, busy: null, errors: [], locate_errors: [], repaired: [], abandoned: [], abandoned_total: 0, repair_waiting: 1, cursor: 114512,
    });
    // The error fails start-issuing even though the round now waits out its backoff.
    expect(forwardStartIssuingHealth(r)).toEqual({ health: "failing", detail: `repair_errors: ${r.repair_errors[0]}` });
    expect(r.snapshot).toMatchObject({ date: YESTERDAY, state: "written" });
    const row = state.cursors.get(CURSOR_FORWARD)!;
    expect(row).toMatchObject({ last_round: 114512, last_poll_at: at(0).toISOString() });
    expect(row.detail.repair_attempts).toEqual({});
    expect(row.detail.repair_backoff).toEqual({ "114513": { errors: 1, next_try_at: at(30).toISOString() } });
  });

  it("does not let three 503s in consecutive runs use up a round's attempts: the backoff holds the retries", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state, { repair_attempts: { "114513": COLLECTOR_LIMITS.repairAttempts - 1 } });
    const failing = () => live({ openAndIssuing: openFrom(114516), updatesError: unavailable() });

    const first = await runForwardCollection({ store, scan: failing(), now: at(0), deadline: later() });
    expect(first.repair_errors).toHaveLength(1);
    for (const minutes of [5, 10]) {
      const scan = failing();
      const r = await runForwardCollection({ store, scan, now: at(minutes), deadline: later() });
      // Waiting out the backoff: no page, no attempt, nothing given up, nothing failed this run.
      expect(updatesCalls(scan)).toEqual([]);
      expect(r).toMatchObject({ ok: true, repair_errors: [], repair_waiting: 1, abandoned: [], abandoned_total: 0, missing: [114513] });
      // No signal: an ok here would end the error's streak before it could page.
      expect(forwardStartIssuingHealth(r)).toEqual({ health: "neutral", detail: null });
    }
    // Still failing when the backoff ends: a second error in a row doubles it, and still no attempt.
    const second = await runForwardCollection({ store, scan: failing(), now: at(30), deadline: later() });
    expect(second).toMatchObject({ abandoned: [], abandoned_total: 0 });
    expect(second.repair_errors).toHaveLength(1);
    expect(state.cursors.get(CURSOR_FORWARD)!.detail).toMatchObject({
      repair_attempts: { "114513": COLLECTOR_LIMITS.repairAttempts - 1 },
      repair_backoff: { "114513": { errors: 2, next_try_at: at(90).toISOString() } },
    });

    // Scan answers again: the round is repaired and the backoff is gone.
    const back = await runForwardCollection({ store, scan: live({ openAndIssuing: openFrom(114516) }), now: at(90), deadline: later() });
    expect(back).toMatchObject({ ok: true, repaired: [114513], repair_waiting: 0, abandoned: [], cursor: 114514 });
    expect(forwardStartIssuingHealth(back)).toEqual({ health: "healthy", detail: null });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail).not.toHaveProperty("repair_backoff");
  });

  it("spends no attempt on a host whose ledger stops short of the window's end: the round waits out the error backoff instead", async () => {
    const { store, state } = memoryStore();
    // One miss away from being given up.
    gapAt114513(state, { repair_attempts: { "114513": COLLECTOR_LIMITS.repairAttempts - 1 } });
    // Its third window runs from 05:56:10 to 06:16:10 (+/-600 s), and this host has nothing after 06:05:39: a lagging fallback, for one.
    const lagging = filler("2026-09-24T06:04:00.000Z", 100, 1_000);
    const scan = live({ openAndIssuing: openFrom(114516), transactions: lagging });
    const r = await runForwardCollection({ store, scan, now: at(0), deadline: later() });

    // A short page inside the window, then an empty one: no proof the round is missing.
    expect(updatesCalls(scan)).toHaveLength(2);
    expect(r.repair_errors).toEqual([
      expect.stringContaining(
        "Scan api.cantonnodes.com has no update after 2026-09-24T06:05:39.000Z, short of the repair window's end at 2026-09-24T06:16:10.000Z",
      ),
    ]);
    expect(r).toMatchObject({
      ok: false, repaired: [], missing: [114513], abandoned: [], abandoned_total: 0, given_up: null, repair_waiting: 1, cursor: 114512,
    });
    expect(forwardStartIssuingHealth(r).health).toBe("failing");
    expect(state.cursors.get(CURSOR_FORWARD)!.detail).toMatchObject({
      repair_attempts: { "114513": COLLECTOR_LIMITS.repairAttempts - 1 },
      repair_backoff: { "114513": { errors: 1, next_try_at: at(30).toISOString() } },
    });

    // After the backoff, a host that serves the window repairs the round.
    const back = await runForwardCollection({ store, scan: live({ openAndIssuing: openFrom(114516) }), now: at(30), deadline: later() });
    expect(back).toMatchObject({ ok: true, repaired: [114513], abandoned: [], given_up: null, cursor: 114514 });
  });

  it("counts no attempt when a found round's write is refused: the run ends there and the next run repairs it", async () => {
    const { store: inner, state } = memoryStore();
    const before = gapAt114513(state, { repair_attempts: { "114513": COLLECTOR_LIMITS.repairAttempts - 1 } });
    const scan = live({ openAndIssuing: openFrom(114516) });
    const r = await runForwardCollection({ store: refusingCaptures(inner), scan, now: at(0), deadline: later() });

    // Scan found it (one page), the database refused it.
    expect(updatesCalls(scan)).toHaveLength(1);
    expect(r).toMatchObject({
      ok: false, busy: null, errors: [REFUSED], repair_errors: [], repaired: [], abandoned: [], abandoned_total: 0,
    });
    // The run ended before the cursor: the attempt a miss would have been is not counted, nothing is given up.
    expect(state.cursors.get(CURSOR_FORWARD)).toEqual(before);

    const next = await runForwardCollection({ store: inner, scan: live({ openAndIssuing: openFrom(114516) }), now: at(5), deadline: later() });
    expect(next).toMatchObject({ ok: true, repaired: [114513], abandoned: [], cursor: 114514 });
  });

  it("stops the repairs on a busy budget as a wait: no attempt, no busy run, and the cursor is still written", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state, { started_at: "2026-09-20T00:00:00Z", repair_attempts: { "114513": 1 } });
    const scan = live({ openAndIssuing: openFrom(114516), updatesError: new ScanBusyError("api.cantonnodes.com", "gate") });
    const r = await runForwardCollection({ store, scan, now: at(0), deadline: later() });
    expect(updatesCalls(scan)).toHaveLength(1);
    expect(r).toMatchObject({
      ok: true, busy: null, errors: [], repair_errors: [], repaired: [], abandoned: [], repair_waiting: 0,
      repair_deferred: "repair round 114513: budget busy (gate)", cursor: 114512,
    });
    expect(r.snapshot).toMatchObject({ date: YESTERDAY, state: "written" });
    // No signal on start-issuing, so no rounds-poll streak and no reset of a start-issuing one.
    expect(forwardStartIssuingHealth(r)).toEqual({ health: "neutral", detail: null });
    // Written with this run's poll time and the attempts as they were; no window, as the busy page was its first.
    expect(state.cursors.get(CURSOR_FORWARD)).toEqual({
      id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: at(0).toISOString(),
      detail: { started_at: "2026-09-20T00:00:00Z", repair_attempts: { "114513": 1 } },
    });
  });

  it("keeps a window that has spent a page when the budget turns busy mid-window, and pages on from it next run", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state);
    // A full 1000-row first page that ends before the window does, then a closed gate.
    const dense = [...filler("2026-09-24T06:03:41.000Z", COLLECTOR_LIMITS.repairPageSize, 100), ...transactions];
    const scan = live({ openAndIssuing: openFrom(114516), transactions: dense });
    const inner = scan.updatesAfter.bind(scan);
    let pages = 0;
    scan.updatesAfter = async (migrationId, afterRecordTime, pageSize, deadline) => {
      if (pages++ === 1) throw new ScanBusyError("api.cantonnodes.com", "gate");
      return inner(migrationId, afterRecordTime, pageSize, deadline);
    };
    const r = await runForwardCollection({ store, scan, now: at(0), deadline: later() });
    expect(r).toMatchObject({
      ok: true, busy: null, repaired: [], repair_deferred: "repair round 114513: budget busy (gate)", cursor: 114512,
    });
    const detail = state.cursors.get(CURSOR_FORWARD)!.detail;
    expect(detail.repair_attempts).toEqual({});
    expect(detail.repair_resume).toMatchObject({ round: 114513, after: lastOfFirstPage, pages: 1 });

    const next = live({ openAndIssuing: openFrom(114516), transactions: dense });
    const r2 = await runForwardCollection({ store, scan: next, now: at(5), deadline: later() });
    expect(updatesCalls(next)[0]).toBe(`updatesAfter ${lastOfFirstPage}`);
    expect(r2).toMatchObject({ ok: true, repaired: [114513], repair_deferred: null, cursor: 114514 });
  });

  it("drops a stored repair window whose round was captured since", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state, {
      repair_resume: { round: 114513, after: "2026-09-24T06:05:20.900Z", stop_at: "2026-09-24T06:08:40.000Z", pages: 1 },
    });
    state.rounds.set(114513, captured(114513, "2026-09-24T06:06:09Z"));
    const scan = live({ openAndIssuing: openFrom(114516) });
    const r = await runForwardCollection({ store, scan, now: at(0), deadline: later() });
    expect(updatesCalls(scan)).toEqual([]);
    expect(r).toMatchObject({ ok: true, missing: [], cursor: 114514 });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail).not.toHaveProperty("repair_resume");
  });

  it("keeps a failed locate out of not_located and out of errors, and still writes the cursor and reaches the snapshot", async () => {
    const { store, state } = memoryStore();
    const updatesError = new ScanTimeoutError("api.cantonnodes.com", "/v2/updates");
    const r = await runForwardCollection({ store, scan: live({ updatesError }), now, deadline: later() });
    expect(r.locate_errors).toEqual([expect.stringMatching(/^locate round 114513: .*did not answer/)]);
    expect(r).toMatchObject({ ok: false, busy: null, errors: [], captured: [], not_located: [], locate_deferred: [], cursor: 114512 });
    expect(forwardStartIssuingHealth(r)).toEqual({ health: "failing", detail: `locate_errors: ${r.locate_errors[0]}` });
    expect(r.snapshot).toMatchObject({ state: "written" });
    expect(state.cursors.get(CURSOR_FORWARD)).toMatchObject({ last_round: 114512, last_poll_at: now.toISOString() });
  });

  it("ends the run on a refused capture write in a locate: an error, not a round it cannot find, and no more Scan calls", async () => {
    const { store: inner, state } = memoryStore();
    const scan = live();
    const r = await runForwardCollection({ store: refusingCaptures(inner), scan, now, deadline: later() });
    expect(r).toMatchObject({
      ok: false, busy: null, errors: [REFUSED], captured: [], not_located: [], locate_errors: [], snapshot: null,
    });
    expect(acsCalls(scan)).toEqual([]);
    expect(state.cursors.has(CURSOR_FORWARD)).toBe(false);
  });

  it("reports once every round the cursor passes uncaptured at the repair horizon, and holds them on the latch", async () => {
    const { store, state } = memoryStore();
    // The oldest open round is 114684: 114682 is the newest round known to have started and the horizon is 114382.
    for (let r = 114371; r <= 114375; r++) state.rounds.set(r, captured(r, "2026-09-22T00:00:00Z"));
    state.cursors.set(CURSOR_FORWARD, {
      id: CURSOR_FORWARD, last_round: 114370, last_date: null, last_poll_at: null,
      // 114376 ran out of attempts on an earlier run and was reported then.
      detail: { repair_attempts: { "114376": COLLECTOR_LIMITS.repairAttempts, "114378": 1 } },
    });
    const scan = live({ openAndIssuing: openFrom(114684) });
    const first = await runForwardCollection({ store, scan, now, deadline: later() });

    expect(first.abandoned).toEqual([114377, 114378, 114379, 114380, 114381]);
    expect(first.abandoned_total).toBe(5);
    expect(first.cursor).toBe(114381);
    expect(first.ok).toBe(false);
    expect(state.cursors.get(CURSOR_FORWARD)?.detail.repair_attempts).toEqual({});
    // Nothing captured within reach of the rounds above the horizon: no repair pages spent on them,
    // and the run says so: 114382 to 114682 have no anchor.
    expect(updatesCalls(scan)).toEqual([]);
    expect(first.unanchored).toBe(301);
    const latch = { total: 5, first: 114377, last: 114381 };
    expect(first.given_up).toEqual({ ...latch, runs_left: COLLECTOR_LIMITS.givenUpRuns - 1 });

    // A run that ends early gives no start-issuing signal and leaves the latch where it was.
    const busy = await runForwardCollection({
      store, scan: fakeScan({ error: new ScanBusyError("api.cantonnodes.com", "gate") }), now, deadline: later(),
    });
    expect(busy).toMatchObject({ busy: "gate", given_up: null });
    expect(forwardStartIssuingHealth(busy)).toEqual({ health: "neutral", detail: null });
    expect(state.cursors.get(CURSOR_FORWARD)?.detail.given_up).toEqual(first.given_up);

    // Given up once, and still failing start-issuing on the next complete run.
    const second = await runForwardCollection({ store, scan: live({ openAndIssuing: openFrom(114684) }), now, deadline: later() });
    expect(second).toMatchObject({
      ok: false, abandoned: [], abandoned_total: 0, cursor: 114381, given_up: { ...latch, runs_left: COLLECTOR_LIMITS.givenUpRuns - 2 },
    });
    expect(forwardStartIssuingHealth(second)).toEqual({ health: "failing", detail: "given_up: 5 rounds from 114377 to 114381" });
  });

  it("holds rounds given up at the horizon on start-issuing for givenUpRuns complete runs, then lets it recover", async () => {
    const { store, state } = memoryStore();
    // Everything from 114371 to 114682 (the newest started) is captured but 114377 to 114381, below the horizon (114382).
    for (let r = 114371; r <= 114682; r++) if (r < 114377 || r > 114381) state.rounds.set(r, captured(r, "2026-09-22T00:00:00Z"));
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 114370, last_date: null, last_poll_at: null, detail: {} });
    const run = () => runForwardCollection({ store, scan: live({ openAndIssuing: openFrom(114684) }), now, deadline: later() });
    const latch = { total: 5, first: 114377, last: 114381 };

    const first = await run();
    expect(first).toMatchObject({
      ok: false, abandoned_total: 5, missing: [], cursor: 114682, given_up: { ...latch, runs_left: COLLECTOR_LIMITS.givenUpRuns - 1 },
    });
    for (let i = 2; i <= COLLECTOR_LIMITS.givenUpRuns; i++) {
      const r = await run();
      expect(r).toMatchObject({ ok: false, abandoned_total: 0, given_up: { ...latch, runs_left: COLLECTOR_LIMITS.givenUpRuns - i } });
      expect(forwardStartIssuingHealth(r).health).toBe("failing");
    }
    // The latch has been reported givenUpRuns times: start-issuing recovers, and the next loss pages again.
    const after = await run();
    expect(after).toMatchObject({ ok: true, given_up: null });
    expect(forwardStartIssuingHealth(after)).toEqual({ health: "healthy", detail: null });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail).not.toHaveProperty("given_up");
  });

  it("lists at most abandonedListed rounds passed at the horizon after a long outage, and counts them all", async () => {
    const { store, state } = memoryStore();
    // Weeks behind: the horizon is 114382, so 110000 to 114381 are passed uncaptured, read in 1,000-round parts.
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 109999, last_date: null, last_poll_at: null, detail: {} });
    const r = await runForwardCollection({ store, scan: live({ openAndIssuing: openFrom(114684) }), now, deadline: later() });
    expect(r.abandoned_total).toBe(114381 - 110000 + 1);
    expect(r.abandoned).toEqual(Array.from({ length: COLLECTOR_LIMITS.abandonedListed }, (_, i) => 110000 + i));
    expect(r).toMatchObject({ ok: false, cursor: 114381 });
    expect(r.given_up).toEqual({ total: 114381 - 110000 + 1, first: 110000, last: 114381, runs_left: COLLECTOR_LIMITS.givenUpRuns - 1 });
  });

  it("does not take the round below the oldest open one as started while none is issuing: it may still be summarizing", async () => {
    const { store, state } = memoryStore();
    state.rounds.set(114512, captured(114512, "2026-09-24T05:55:50Z"));
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: null, detail: {} });
    // The oldest open round is 114514, so 114513 may not have started yet: no window can hold it.
    const runs = [];
    for (let i = 0; i < COLLECTOR_LIMITS.repairAttempts + 1; i++) {
      const scan = live({ openAndIssuing: openFrom(114514), transactions: [] });
      runs.push(await runForwardCollection({ store, scan, now, deadline: later() }));
      expect(updatesCalls(scan)).toEqual([]);
    }
    for (const r of runs) expect(r).toMatchObject({ ok: true, missing: [], abandoned: [], given_up: null, cursor: 114512 });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail.repair_attempts).toEqual({});

    // Once it issues, a locate captures it and the cursor moves on.
    const issuing = await runForwardCollection({ store, scan: live(), now, deadline: later() });
    expect(issuing).toMatchObject({ ok: true, captured: [114513], cursor: 114513 });
  });


  it("starts no locate page past the run budget, and leaves the round to the next run", async () => {
    const { store } = memoryStore();
    // A full first page that ends before createdAt + 10 s, so the locate wants a second one.
    const dense = [...filler("2026-09-24T06:06:07.800Z", COLLECTOR_LIMITS.locatePageSize, 5), ...transactions];
    const scan = live({ transactions: dense });
    const clock = slowUpdates(scan, COLLECTOR_LIMITS.runBudgetMs + 1_000);
    const r = await runForwardCollection({ store, scan, now, deadline: later(), clock });
    expect(updatesCalls(scan)).toHaveLength(1);
    // A budget stop is a wait for the round, not a round it cannot find, and the run says which round waits.
    expect(r).toMatchObject({ captured: [], not_located: [], locate_deferred: [114513], cursor: 114512 });
    expect(forwardStartIssuingHealth(r)).toEqual({ health: "neutral", detail: null });
    // But no due locate got an answer: the run stalled, and a stall is not ok.
    expect(r.stalled).toMatch(/114513/);
    expect(r.ok).toBe(false);
  });

  it("reports a run whose due locates got no page before the lock deadline as stalled: not ok, with no start-issuing signal", async () => {
    const { store, state } = memoryStore();
    // 114511 is missing between two captured rounds, and 114513 is issuing.
    state.rounds.set(114510, captured(114510, "2026-09-24T05:35:10Z"));
    state.rounds.set(114512, captured(114512, "2026-09-24T05:55:50Z"));
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 114510, last_date: null, last_poll_at: null, detail: {} });
    const scan = live();
    // The lock leaves time for the poll, but from the locates on no page's worst case fits before it.
    const t0 = Date.now();
    const deadline = t0 + scanCallWorstCaseMs("record") + 20_000;
    const r = await runForwardCollection({ store, scan, now: early, deadline, clock: () => t0 + 30_000 });

    // Every stage deferred: no locate, no ACS call, no repair page.
    expect(updatesCalls(scan)).toEqual([]);
    expect(acsCalls(scan)).toEqual([]);
    expect(r).toMatchObject({
      ok: false, busy: null, errors: [], captured: [], not_located: [], locate_errors: [], locate_deferred: [114513],
      repaired: [], missing: [114511], repair_deferred: expect.stringMatching(/^repair round 114511: no page fits/),
      snapshot: "deferred", cursor: 114510,
    });
    expect(r.stalled).toMatch(/114513/);
    // Each part alone is a wait that neither outcome counts; `stalled` is what makes the run not ok.
    expect(forwardStartIssuingHealth(r)).toEqual({ health: "neutral", detail: null });
    expect(forwardSnapshotHealth(r)).toBe("neutral");
    expect(state.cursors.get(CURSOR_FORWARD)).toMatchObject({ last_round: 114510, last_poll_at: early.toISOString() });

    // With the lock's time back, the next run captures the round and is ok again.
    const next = await runForwardCollection({ store, scan: live(), now: early, deadline: later() });
    expect(next).toMatchObject({ ok: true, stalled: null, captured: [114513] });
  });

  it("starts no repair page past the run budget, and pages on from there next run without counting an attempt", async () => {
    const { store, state } = memoryStore();
    state.rounds.set(114512, { ...blankRound(114512, "api.cantonnodes.com"), start_issuing_at: "2026-09-24T05:55:50Z", update_id: "u512" });
    state.rounds.set(114514, { ...blankRound(114514, "api.cantonnodes.com"), start_issuing_at: "2026-09-24T06:16:30Z", update_id: "u514" });
    state.cursors.set(CURSOR_FORWARD, { id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: null, detail: {} });
    const at = new Date("2026-09-24T06:40:00Z");
    // A full 1000-row first page that ends before the repair window does, so the repair wants a second one.
    const dense = [...filler("2026-09-24T06:03:41.000Z", COLLECTOR_LIMITS.repairPageSize, 100), ...transactions];
    const scan = live({ openAndIssuing: openFrom(114516), transactions: dense });
    const clock = slowUpdates(scan, COLLECTOR_LIMITS.runBudgetMs + 1_000);
    const r = await runForwardCollection({ store, scan, now: at, deadline: later(), clock });
    expect(updatesCalls(scan)).toHaveLength(1);
    expect(r).toMatchObject({ repaired: [], abandoned: [], cursor: 114512 });
    const detail = state.cursors.get(CURSOR_FORWARD)!.detail;
    expect(detail.repair_attempts).toEqual({});
    expect(detail.repair_resume).toMatchObject({ round: 114513, after: lastOfFirstPage, pages: 1 });

    const next = live({ openAndIssuing: openFrom(114516), transactions: dense });
    const r2 = await runForwardCollection({ store, scan: next, now: at, deadline: later() });
    expect(updatesCalls(next)[0]).toBe(`updatesAfter ${lastOfFirstPage}`);
    expect(r2).toMatchObject({ repaired: [114513], abandoned: [], cursor: 114514 });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail).not.toHaveProperty("repair_resume");
  });

  it("keeps a cut window for a run with no time to page it", async () => {
    const { store, state } = memoryStore();
    state.rounds.set(114512, captured(114512, "2026-09-24T05:55:50Z"));
    state.rounds.set(114514, captured(114514, "2026-09-24T06:16:30Z"));
    const window = { round: 114513, after: "2026-09-24T06:05:20.900Z", stop_at: "2026-09-24T06:08:40.000Z", pages: 1 };
    state.cursors.set(CURSOR_FORWARD, {
      id: CURSOR_FORWARD, last_round: 114512, last_date: null, last_poll_at: null, detail: { repair_resume: window },
    });
    // The run budget is spent before the repairs: no page starts.
    const scan = live({ openAndIssuing: openFrom(114516) });
    const t0 = Date.now();
    let reads = 0;
    const clock = () => (reads++ === 0 ? t0 : t0 + COLLECTOR_LIMITS.runBudgetMs + 1_000);
    const r = await runForwardCollection({ store, scan, now: early, deadline: later(), clock });
    expect(updatesCalls(scan)).toEqual([]);
    expect(r).toMatchObject({ ok: true, cursor: 114512, repair_deferred: expect.stringMatching(/^repair round 114513: no page fits/) });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail.repair_resume).toEqual(window);
  });

  it("starts no page whose worst case would end past the lock deadline, and hands every call the deadline", async () => {
    const { store } = memoryStore();
    // A full first page that ends before createdAt + 10 s, so the locate wants a second one.
    const dense = [...filler("2026-09-24T06:06:07.800Z", COLLECTOR_LIMITS.locatePageSize, 5), ...transactions];
    const scan = live({ transactions: dense });
    const seen = roundDeadlines(scan);
    const clock = slowUpdates(scan, 30_000);
    const deadline = Date.now() + scanCallWorstCaseMs("record") + 20_000;
    const r = await runForwardCollection({ store, scan, now: early, deadline, clock });
    // Page one at +0 s ends by the deadline; page two at +30 s could not.
    expect(updatesCalls(scan)).toHaveLength(1);
    expect(r).toMatchObject({ captured: [], not_located: [], locate_deferred: [114513], errors: [], busy: null, cursor: 114512 });
    expect(seen.map(([name]) => name)).toEqual(["migrationId", "openAndIssuing", "updatesAfter"]);
    expect(seen.every(([, d]) => d === deadline)).toBe(true);
  });

  it("reports a closed budget as busy, not as an error", async () => {
    const { store } = memoryStore();
    const r = await runForwardCollection({
      store, scan: fakeScan({ error: new ScanBusyError("api.cantonnodes.com", "gate") }), now, deadline: later(),
    });
    expect(r).toMatchObject({ ok: false, busy: "gate", errors: [], snapshot: null });
  });
});

describe("runForwardCollection and the daily snapshot stage", () => {
  it("gives the stage the lock deadline and stores the day", async () => {
    const { store, state } = memoryStore();
    const scan = live();
    const seen = deadlines(scan);
    const deadline = later();
    const r = await runForwardCollection({ store, scan, now, deadline });
    expect(r.snapshot).toMatchObject({ date: YESTERDAY, state: "written" });
    expect(r.ok).toBe(true);
    expect(state.snapshots.get(YESTERDAY)?.validator_licenses).toBe(2);
    // Four core templates and the license count, none allowed past the lock.
    expect(seen).toHaveLength(5);
    expect(seen.every((d) => d !== undefined && d <= deadline)).toBe(true);
    expect(Math.max(...(seen as number[]))).toBe(deadline);
  });

  it("defers the stage before 04:00 when the lock leaves less than the core read needs, spending no call and no attempt", async () => {
    const { store: inner, state } = memoryStore();
    const { store, ids } = cursorLog(inner);
    const scan = live();
    const r = await runForwardCollection({ store, scan, now: early, deadline: Date.now() + snapshotCoreHeadroomMs() - 5_000 });
    expect(r.snapshot).toBe("deferred");
    expect(r.snapshot_deferred).toMatch(/^budget busy \(queue\), \d+ s left before the lock deadline$/);
    expect(r.ok).toBe(true);
    expect(forwardSnapshotHealth(r)).toBe("neutral");
    expect(acsCalls(scan)).toEqual([]);
    expect(state.snapshots.size).toBe(0);
    // The stage runs before the repairs and the forward cursor write. It reads its own row and writes it
    // only for an attempt, and a refusal before the first call is none.
    expect(ids).toEqual([`get ${CURSOR_FORWARD}`, `get ${CURSOR_SNAPSHOT}`, `set ${CURSOR_FORWARD}`]);
  });

  it("runs a due snapshot before the repairs, and leaves the repair to the next run when the stage spent the run budget", async () => {
    const { store, state } = memoryStore();
    gapAt114513(state);
    const scan = live({ openAndIssuing: openFrom(114516) });
    // Each ACS call moves the run clock on by 40 s: the five of them spend the 180 s run budget.
    const clock = slowAcs(scan, 40_000);
    const r = await runForwardCollection({ store, scan, now: at(0), deadline: later(), clock });
    expect(r.snapshot).toMatchObject({ date: YESTERDAY, state: "written" });
    expect(updatesCalls(scan)).toEqual([]);
    expect(r).toMatchObject({
      ok: true, repaired: [], missing: [114513], cursor: 114512, repair_deferred: expect.stringMatching(/^repair round 114513: /),
    });
    // The due repair got no page: no signal on start-issuing, and no attempt.
    expect(forwardStartIssuingHealth(r)).toEqual({ health: "neutral", detail: null });
    expect(state.cursors.get(CURSOR_FORWARD)!.detail.repair_attempts).toEqual({});

    // The day is stored: the next run spends no ACS call and repairs the round.
    const next = live({ openAndIssuing: openFrom(114516) });
    const r2 = await runForwardCollection({ store, scan: next, now: at(5), deadline: later() });
    expect(acsCalls(next)).toEqual([]);
    expect(r2).toMatchObject({ ok: true, repaired: [114513], cursor: 114514 });
  });

  it("reports the stage starved from 04:00 when the lock keeps leaving less than the core read needs", async () => {
    const { store: inner, state } = memoryStore();
    const { store, ids } = cursorLog(inner);
    const scan = live();
    const r = await runForwardCollection({ store, scan, now, deadline: Date.now() + snapshotCoreHeadroomMs() - 5_000 });
    expect(r.snapshot).toMatchObject({ date: YESTERDAY, state: "starved" });
    expect(forwardSnapshotHealth(r)).toBe("failing");
    expect(r).toMatchObject({ ok: false, captured: [114513], not_located: [], busy: null, errors: [] });
    expect(acsCalls(scan)).toEqual([]);
    expect(state.snapshots.size).toBe(0);
    expect(ids).not.toContain(`set ${CURSOR_SNAPSHOT}`);
  });

  it("defers the stage on a busy budget: a wait, not a busy run", async () => {
    const { store } = memoryStore();
    const scan = live({ acsErrors: { [TEMPLATES.dsoRules]: new ScanBusyError("api.cantonnodes.com", "gate") } });
    const r = await runForwardCollection({ store, scan, now: early, deadline: later() });
    expect(r).toMatchObject({ ok: true, busy: null, errors: [], snapshot: "deferred", snapshot_error: null });
    expect(r.snapshot_deferred).toMatch(/^budget busy \(gate\), /);
    expect(r.captured).toEqual([114513]);
  });

  it("is not ok on a failed stage while every round is found, and a backoff counts neither way", async () => {
    const { store, state } = memoryStore();
    const failing = await runForwardCollection({ store, scan: live({ acsError: notFound() }), now: early, deadline: later() });
    expect(failing.not_located).toEqual([]);
    expect(failing.snapshot).toMatchObject({ state: "failed" });
    expect(failing.ok).toBe(false);
    expect(forwardSnapshotHealth(failing)).toBe("failing");

    // The attempt lives on the stage's own row; the forward cursor carries no trace of it.
    const attempt = state.cursors.get(CURSOR_SNAPSHOT);
    expect(attempt).toMatchObject({ last_date: YESTERDAY, detail: { attempts: 1 } });
    expect(Object.keys(state.cursors.get(CURSOR_FORWARD)!.detail).sort()).toEqual(["repair_attempts", "started_at"]);

    const waiting = await runForwardCollection({
      store, scan: live({ acsError: notFound() }), now: new Date(early.getTime() + 5 * 60_000), deadline: later(),
    });
    expect(waiting.snapshot).toMatchObject({ state: "waiting" });
    expect(forwardSnapshotHealth(waiting)).toBe("neutral");
    expect(waiting.ok).toBe(true);
    // The forward cursor was written again; the stage's row was not touched by it.
    expect(state.cursors.get(CURSOR_SNAPSHOT)).toEqual(attempt);
    expect(Object.keys(state.cursors.get(CURSOR_FORWARD)!.detail).sort()).toEqual(["repair_attempts", "started_at"]);
  });

  it("leaves the core read room inside the lock after the run's first call", () => {
    // The caller's deadline is the lock expiry less the margin (280 s). A stage asked
    // within 10 s of the claim (one open-and-issuing answer, no locate) still fits.
    expect(COLLECTOR_LOCK.holdMs - COLLECTOR_LOCK.marginMs - snapshotCoreHeadroomMs()).toBeGreaterThanOrEqual(10_000);
  });

  it("stays ok when only the day's license count gave up, spending no call on it", async () => {
    const { store, state } = memoryStore();
    const core: SnapshotRow = {
      date: YESTERDAY, record_time: "2026-09-24T00:00:00Z", migration_id: 4, source_host: "api.cantonnodes.com",
      method: "scan-1", last_round: 98370, reference_round: 98373, reference_price_usd: "0.1560",
      super_validators: 4, sv_voting_threshold: 3, featured_apps: 3, validator_licenses: null,
    };
    state.snapshots.set(YESTERDAY, core);
    state.cursors.set(CURSOR_SNAPSHOT, {
      id: CURSOR_SNAPSHOT, last_round: null, last_date: YESTERDAY, last_poll_at: "2026-09-24T04:00:00Z",
      detail: { attempts: SNAPSHOT_RETRY.maxAttempts, next_try_at: "2026-09-24T04:30:00Z", last_error: "404 not found" },
    });
    const scan = live();
    const r = await runForwardCollection({ store, scan, now, deadline: later() });
    expect(r.snapshot).toMatchObject({ date: YESTERDAY, state: "licenses_gave_up" });
    expect(forwardSnapshotHealth(r)).toBe("neutral");
    expect(r).toMatchObject({ ok: true, captured: [114513], busy: null, errors: [] });
    expect(acsCalls(scan)).toEqual([]);
    expect(state.snapshots.get(YESTERDAY)).toEqual(core);
  });

  it("is not ok while the stage has given up on the day, and still collects every round", async () => {
    const { store, state } = memoryStore();
    state.cursors.set(CURSOR_SNAPSHOT, {
      id: CURSOR_SNAPSHOT, last_round: null, last_date: YESTERDAY, last_poll_at: "2026-09-24T04:00:00Z",
      detail: { attempts: SNAPSHOT_RETRY.maxAttempts, next_try_at: "2026-09-24T04:30:00Z", last_error: "404 not found" },
    });
    const scan = live();
    const r = await runForwardCollection({ store, scan, now, deadline: later() });
    expect(r.snapshot).toMatchObject({ state: "gave_up" });
    expect(r).toMatchObject({ ok: false, captured: [114513], not_located: [], busy: null, errors: [] });
    expect(acsCalls(scan)).toEqual([]);
  });

  it("keeps an error thrown by the stage out of the run's errors, and is not ok on it", async () => {
    const { store: inner, state } = memoryStore();
    const store: RecordStore = {
      ...inner,
      getSnapshot: async () => {
        throw new Error("snapshot table unreadable");
      },
    };
    const r = await runForwardCollection({ store, scan: live(), now, deadline: later() });
    expect(r).toMatchObject({ ok: false, busy: null, errors: [], snapshot: null, snapshot_error: "snapshot table unreadable" });
    expect(forwardSnapshotHealth(r)).toBe("failing");
    expect(state.cursors.get(CURSOR_FORWARD)?.last_round).toBe(114513);
  });
});

describe("forwardStartIssuingHealth", () => {
  type Fields = Parameters<typeof forwardStartIssuingHealth>[0];
  /** A complete run that did all of its start-issuing work without a failure. */
  const quiet: Fields = {
    not_located: [], locate_errors: [], locate_deferred: [], repair_errors: [], repair_waiting: 0, repair_deferred: null,
    given_up: null, busy: null, errors: [],
  };
  const health = (over: Partial<Fields>) => forwardStartIssuingHealth({ ...quiet, ...over });
  const lost = { total: 1, first: 114513, last: 114513, runs_left: 3 };

  it("is healthy on a run that did its work without a failure", () => {
    expect(health({})).toEqual({ health: "healthy", detail: null });
  });

  it("fails on each failing field alone, and the detail names it", () => {
    expect(health({ not_located: [114513, 114514] })).toEqual({ health: "failing", detail: "not_located: 114513, 114514" });
    expect(health({ locate_errors: ["locate round 114513: 503"] }))
      .toEqual({ health: "failing", detail: "locate_errors: locate round 114513: 503" });
    expect(health({ repair_errors: ["repair round 114513: 503", "repair round 114514: 503"] }))
      .toEqual({ health: "failing", detail: "repair_errors: repair round 114513: 503 (and 1 more)" });
    expect(health({ given_up: lost })).toEqual({ health: "failing", detail: "given_up: round 114513" });
    expect(health({ given_up: { total: 4382, first: 110000, last: 114381, runs_left: 0 } }))
      .toEqual({ health: "failing", detail: "given_up: 4382 rounds from 110000 to 114381" });
  });

  it("names the first failing field, in the order not_located, locate_errors, repair_errors, given_up", () => {
    const all = { not_located: [114515], locate_errors: ["locate"], repair_errors: ["repair"], given_up: lost };
    expect(health(all).detail).toBe("not_located: 114515");
    expect(health({ ...all, not_located: [] }).detail).toBe("locate_errors: locate");
    expect(health({ ...all, not_located: [], locate_errors: [] }).detail).toBe("repair_errors: repair");
  });

  it("gives no signal when nothing failed but due work was left unanswered, so a failure streak is kept", () => {
    const waits: Array<Partial<Fields>> = [
      { repair_waiting: 1 },
      { locate_deferred: [114513] },
      { repair_deferred: "repair round 114513: budget busy (gate)" },
      { busy: "gate" },
      { errors: ["write cursor refused"] },
    ];
    for (const over of waits) expect(health(over), JSON.stringify(over)).toEqual({ health: "neutral", detail: null });
  });

  it("fails when a run both failed and waited", () => {
    expect(health({ repair_errors: ["repair"], repair_waiting: 1 }).health).toBe("failing");
    expect(health({ locate_errors: ["locate"], busy: "gate" }).health).toBe("failing");
    expect(health({ given_up: lost, locate_deferred: [114513] }).health).toBe("failing");
  });
});

describe("estimateStartMs", () => {
  it("interpolates between the nearest captured rounds on each side", () => {
    const known = new Map([
      [100, { start_issuing_at: "2026-10-01T00:00:00Z" }],
      [110, { start_issuing_at: "2026-10-01T01:40:00Z" }],
    ]);
    expect(new Date(estimateStartMs(105, known)!).toISOString()).toBe("2026-10-01T00:50:00.000Z");
    expect(estimateStartMs(105, new Map())).toBeNull();
  });

  it("extrapolates from one side only within repairAnchorRounds", () => {
    const known = new Map([[100, { start_issuing_at: "2026-10-01T00:00:00Z" }]]);
    const near = 100 + COLLECTOR_LIMITS.repairAnchorRounds;
    expect(estimateStartMs(near, known)).toBe(
      Date.parse("2026-10-01T00:00:00Z") + COLLECTOR_LIMITS.repairAnchorRounds * COLLECTOR_LIMITS.roundSpacingMs,
    );
    expect(estimateStartMs(near + 1, known)).toBeNull();
    expect(estimateStartMs(100 - COLLECTOR_LIMITS.repairAnchorRounds - 1, known)).toBeNull();
  });

  it("gives no estimate when both anchors are far, even with one on each side", () => {
    const known = new Map([
      [100, { start_issuing_at: "2026-10-01T00:00:00Z" }],
      [400, { start_issuing_at: "2026-10-03T03:20:00Z" }],
    ]);
    expect(estimateStartMs(250, known)).toBeNull();
    expect(estimateStartMs(399, known)).not.toBeNull();
  });
});
