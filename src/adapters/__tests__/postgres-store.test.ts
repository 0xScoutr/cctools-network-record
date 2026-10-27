/**
 * The Postgres reference adapter against the real schema, in an in-process
 * Postgres (PGlite): no server, no network. The schema's own live check runs
 * first; then the same days are finalized and published through the Postgres
 * store and through the in-memory store, and every outcome must agree.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_FORWARD, RECORD_SQLSTATE, SERIES_NAMES, type GapRow, type ValueRow } from "../../open-record/contract";
import { publishRecord } from "../../open-record/publish";
import { finalizeDate } from "../../scan-record/finalize";
import { recordErrorCode, type RecordStore } from "../../scan-record/store";
import {
  HOST,
  NO_ROUND_TOTALS,
  SUPPLY_END,
  SUPPLY_START,
  dayOfRounds,
  snapshotRow,
} from "../../scan-record/__tests__/helpers/day-builders";
import { memoryFileCache, memoryRecordReader, memoryStore } from "../memory-store";
import { postgresRecordReader, postgresRecordStore, type SqlClient } from "../postgres-store";

const sql = (name: string) => readFileSync(join(process.cwd(), "sql", name), "utf-8");

async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create();
  for (const f of ["plain-postgres-roles.sql", "schema.sql", "supply.sql"]) await db.exec(sql(f));
  return db;
}

const client = (db: PGlite): SqlClient => ({
  query: async (text, params) => ({ rows: (await db.query(text, params)).rows as Record<string, unknown>[] }),
});

const DATE = "2026-10-05";
const MISSING_ROUND = 200070;
const ctx = {
  roundTotalsVerified: NO_ROUND_TOTALS,
  collectorStartDate: "2026-10-02",
  releasedHolds: new Map<string, string[]>(),
  keptFinals: new Set<string>(),
};

async function seed(store: RecordStore, setSupply: (instant: string, value: string) => Promise<void>, skip?: number) {
  const rounds = dayOfRounds(DATE, 200001).filter((r) => r.round !== skip);
  await store.upsertRoundCaptures(
    rounds.map((r) => ({
      round: r.round, start_issuing_at: r.start_issuing_at, tick_duration_us: r.tick_duration_us,
      issuance_config: r.issuance_config, app_rewards_cc: r.app_rewards_cc, validator_rewards_cc: r.validator_rewards_cc,
      sv_rewards_cc: r.sv_rewards_cc, dev_fund_cc: r.dev_fund_cc, faucet_rewards_cc: r.faucet_rewards_cc,
      unfeatured_app_rewards_cc: r.unfeatured_app_rewards_cc, unclaimed_rewards_cc: r.unclaimed_rewards_cc,
      split: r.split, issuing_contract_id: r.issuing_contract_id, update_id: r.update_id, migration_id: r.migration_id,
      source_host: r.source_host, method: r.method, repaired: r.repaired,
    })),
  );
  await store.upsertSnapshot(snapshotRow("2026-10-04", 200000));
  await store.upsertSnapshot(snapshotRow(DATE, 200140));
  await setSupply("2026-10-05T00:00:00Z", SUPPLY_START);
  await setSupply("2026-10-06T00:00:00Z", SUPPLY_END);
  await store.setCursor({ id: CURSOR_FORWARD, last_round: 200140, last_date: null, last_poll_at: null, detail: { started_at: "2026-10-01T12:00:00Z" } });
}

/** What both stores must agree on, without the instants each one stamps itself. */
const valueFacts = (rows: ValueRow[]) =>
  rows
    .map((v) => ({ series: v.series, value: v.value, status: v.status, source_host: v.source_host, method: v.method, as_of: v.as_of && new Date(v.as_of).toISOString() }))
    .sort((a, b) => (a.series < b.series ? -1 : 1));
const gapFacts = (rows: GapRow[]) =>
  rows
    .map((g) => ({ series: g.series, reason_code: g.reason_code, reason: g.reason, status: g.status, resolved: g.resolved_at != null }))
    .sort((a, b) => `${a.series}|${a.reason_code}|${a.resolved}`.localeCompare(`${b.series}|${b.reason_code}|${b.resolved}`));

describe("sql/schema.sql in Postgres", () => {
  it("passes its own live check, which rolls everything back", async () => {
    const db = await freshDb();
    const check = sql("check-schema.sql");
    const start = check.indexOf("do $check$");
    const end = check.indexOf("$check$;", start + 10) + "$check$;".length;
    await expect(db.query(check.slice(start, end))).rejects.toMatchObject({
      message: "RECORD CHECK (rolled back): all checks ok",
    });
    const counts = (await db.query(check.slice(end).replace(/--.*$/gm, "").trim())).rows;
    expect(counts).toEqual([{ values_left: 0, revisions_left: 0, gaps_left: 0 }]);
    await db.close();
  });
});

describe("postgresRecordStore", () => {
  let db: PGlite;
  let pg: RecordStore;

  beforeAll(async () => {
    db = await freshDb();
    pg = postgresRecordStore(client(db));
  });
  afterAll(async () => {
    await db.close();
  });

  it("round-trips rounds, snapshots, cursors and supply as text, never as a double", async () => {
    await seed(pg, async (instant, value) => {
      await db.query("insert into network_record_supply (supply_as_of, total_supply, source_host) values ($1, $2, $3)", [instant, value, HOST]);
    });
    const rounds = await pg.getRounds(200001, 200002);
    expect(rounds.map((r) => r.round)).toEqual([200001, 200002]);
    expect(rounds[0].tick_duration_us).toBe(600_000_000);
    expect(rounds[0].app_rewards_cc).toMatch(/^\d+\.\d{20}$/);
    expect(rounds[0].split?.summary).toBeDefined();
    expect((await pg.getRoundsStartedBetween(`${DATE}T00:00:00Z`, "2026-10-06T00:00:00Z")).length).toBe(140);
    expect(await pg.getSnapshot(DATE)).toMatchObject({ date: DATE, last_round: 200140, validator_licenses: 1400, reference_price_usd: "0.119296" });
    expect(await pg.getSupplyAt("2026-10-05T00:00:00Z")).toEqual({ value: SUPPLY_START, source_host: HOST });
    expect((await pg.getCursor(CURSOR_FORWARD))?.detail).toEqual({ started_at: "2026-10-01T12:00:00Z" });
    expect(await pg.listSnapshotDates("2026-10-01", "2026-10-31")).toEqual(["2026-10-04", DATE]);
  });

  it("keeps a stored license count when a later write carries none, and refuses to insert over a stored day", async () => {
    await pg.upsertSnapshot({ ...snapshotRow(DATE, 200140), validator_licenses: null });
    expect((await pg.getSnapshot(DATE))?.validator_licenses).toBe(1400);
    expect(await pg.insertSnapshot(snapshotRow(DATE, 200140))).toBe(false);
    expect(await pg.insertSnapshot(snapshotRow("2026-10-03", 199860))).toBe(true);
    expect(await pg.listSnapshotsMissingLicenses("2026-10-01", "2026-10-31")).toEqual([]);
  });

  it("refuses a direct change of a final value with RN001, by code", async () => {
    await pg.upsertValues([
      { date: "2026-10-01", series: "rounds", value: "140", status: "final", source_host: HOST, method: "scan-1", as_of: "2026-10-02T00:00:00Z", retrieved_at: "2026-10-02T02:35:00Z", finalized_at: "2026-10-02T02:35:00Z" },
    ]);
    const err = await pg
      .upsertValues([{ date: "2026-10-01", series: "rounds", value: "141", status: "final", source_host: HOST, method: "scan-1", as_of: "2026-10-02T00:00:00Z", retrieved_at: "2026-10-02T03:35:00Z", finalized_at: "2026-10-02T03:35:00Z" }])
      .catch((e: unknown) => e);
    expect(recordErrorCode(err)).toBe(RECORD_SQLSTATE.FINAL_CHANGED);
    expect(await pg.revise("2026-10-01", "rounds", "141", "correction", "a test correction")).toBe(1);
    expect((await pg.getValues("2026-10-01"))[0]).toMatchObject({ value: "141.0000000000", revision: 1 });
  });
});

describe("the Postgres and in-memory stores agree through finalize and publish", () => {
  let db: PGlite;
  let pg: RecordStore;
  const mem = memoryStore();

  beforeAll(async () => {
    db = await freshDb();
    pg = postgresRecordStore(client(db));
    await seed(pg, async (instant, value) => {
      await db.query("insert into network_record_supply (supply_as_of, total_supply, source_host) values ($1, $2, $3)", [instant, value, HOST]);
    }, MISSING_ROUND);
    await seed(mem.store, async (instant, value) => void mem.state.supply.set(instant, value), MISSING_ROUND);
  });
  afterAll(async () => {
    await db.close();
  });

  for (const now of ["2026-10-06T00:35:00Z", "2026-10-06T02:35:00Z"]) {
    it(`gives the same values and gaps at ${now}`, async () => {
      const a = await finalizeDate(DATE, { store: pg, now: new Date(now), ...ctx });
      const b = await finalizeDate(DATE, { store: mem.store, now: new Date(now), ...ctx });
      expect(a.series).toEqual(b.series);
      expect(valueFacts(await pg.getValues(DATE))).toEqual(valueFacts(await mem.store.getValues(DATE)));
      expect(gapFacts(await pg.getGaps(DATE))).toEqual(gapFacts(await mem.store.getGaps(DATE)));
    });
  }

  it("fills the missed round's final nulls through the same logged backfill revisions", async () => {
    const late = dayOfRounds(DATE, 200001).find((r) => r.round === MISSING_ROUND)!;
    const write = { ...late } as Record<string, unknown>;
    for (const k of ["opens_at", "closed_at", "amulet_price"]) delete write[k];
    await pg.upsertRoundCaptures([write as never]);
    await mem.store.upsertRoundCaptures([write as never]);
    const a = await finalizeDate(DATE, { store: pg, now: new Date("2026-10-06T03:35:00Z"), ...ctx });
    const b = await finalizeDate(DATE, { store: mem.store, now: new Date("2026-10-06T03:35:00Z"), ...ctx });
    expect(a.series).toEqual(b.series);
    expect(a.series.app_rewards_cc.state).toBe("revised");
    expect(valueFacts(await pg.getValues(DATE))).toEqual(valueFacts(await mem.store.getValues(DATE)));
    const revisions = (await db.query("select series, old_value::text as old, new_value::text as new, kind, method from network_record_revisions where date = $1 order by series", [DATE])).rows;
    expect(revisions.map((r) => (r as { series: string }).series)).toEqual(
      mem.state.revisions.filter((r) => r.date === DATE).map((r) => r.series).sort(),
    );
  });

  it("publishes the same day file values from either reader", async () => {
    const now = new Date("2026-10-14T03:40:00Z");
    const pgFiles = memoryFileCache();
    const memFiles = memoryFileCache();
    expect((await publishRecord({ reader: postgresRecordReader(client(db)), cache: pgFiles, now })).ok).toBe(true);
    expect((await publishRecord({ reader: memoryRecordReader(mem.state), cache: memFiles, now })).ok).toBe(true);
    const day = (c: ReturnType<typeof memoryFileCache>) => JSON.parse(c.files.get(`days/${DATE}.json`)!.body);
    const values = (d: { values: Record<string, { value: unknown; status: string; source_host: string | null }> }) =>
      Object.fromEntries(SERIES_NAMES.map((s) => [s, d.values[s] && [d.values[s].value, d.values[s].status, d.values[s].source_host]]));
    expect(values(day(pgFiles))).toEqual(values(day(memFiles)));
    expect(day(pgFiles).status).toBe("final");
  });
});
