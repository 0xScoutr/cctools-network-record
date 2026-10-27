/**
 * The supply collector (supply.ts): the registry reader's failure rules, and
 * a run that stores Canton Coin's reading where getSupplyAt reads it back.
 *
 * Every request goes to a stubbed fetch for a host under .invalid, through
 * runtime/scan-settings.ts. No recording of the registry endpoint is kept, so
 * the answer below is shaped as the CCTools deployment's own tests answer for
 * Canton Coin, with the published supply_cc of 2026-10-25 (values.csv), as of
 * 2026-10-26T00:00:00Z.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postgresRecordStore, postgresSupplyWriter, type SqlClient } from "../../adapters/postgres-store";
import { setAlertSink, consoleAlertSink, type AlertSink } from "../../runtime/alerts";
import { memoryCacheStore, setCacheStoreBackend } from "../../runtime/cache-store";
import { configureScan } from "../../runtime/scan-settings";
import { scanGateUntil } from "../scan-budget";
import { DEFAULT_USER_AGENT } from "../scan-client";
import {
  CC_INSTRUMENT_ID,
  fetchRegistryInstruments,
  runSupplyCollection,
  type SupplyReading,
  type SupplyWriter,
} from "../supply";

const HOST = "https://scan.example.invalid";
const REGISTRY = `${HOST}/registry/metadata/v1`;
const CC = {
  id: "Amulet",
  name: "Canton Coin",
  symbol: "CC",
  totalSupply: "39922370813.3258635595",
  totalSupplyAsOf: "2026-10-26T00:00:00Z",
  decimals: 10,
  paused: false,
  supportedApis: { "splice-api-token-metadata-v1": 1 },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let calls: Array<{ url: string; init: RequestInit }>;
let answers: Array<Response | Error>;

function stubRegistry(...queue: Array<Response | Error>) {
  answers = queue;
  calls = [];
  configureScan({
    hosts: [HOST],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = answers.length > 1 ? answers.shift()! : answers[0];
      if (next instanceof Error) throw next;
      return next.clone();
    }) as typeof fetch,
  });
}

/** Runs a promise that sleeps between retries without waiting in real time. */
async function withTimers<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

function memoryWriter(): SupplyWriter & { rows: Map<string, SupplyReading> } {
  const rows = new Map<string, SupplyReading>();
  return {
    rows,
    async recordSupplyReading(r) {
      const key = new Date(r.supply_as_of).toISOString();
      if (rows.has(key)) return false;
      rows.set(key, r);
      return true;
    },
  };
}

let sent: Array<{ title: string; text: string }>;
let previousSink: AlertSink;

beforeEach(() => {
  setCacheStoreBackend(memoryCacheStore());
  sent = [];
  previousSink = setAlertSink({
    async send({ title, text }) {
      sent.push({ title, text });
      return true;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  configureScan({});
  setAlertSink(previousSink ?? consoleAlertSink);
});

describe("fetchRegistryInstruments", () => {
  it("returns the instruments, supply kept as decimal text, and names itself", async () => {
    stubRegistry(json({ instruments: [CC], nextPageToken: null }));
    const r = await fetchRegistryInstruments(REGISTRY);
    expect(r).toMatchObject({ ok: true, status: 200, error: null });
    expect(r.instruments).toEqual([
      { id: "Amulet", name: "Canton Coin", symbol: "CC", totalSupply: "39922370813.3258635595", totalSupplyAsOf: "2026-10-26T00:00:00Z", decimals: 10, paused: false },
    ]);
    expect(calls.map((c) => c.url)).toEqual([`${REGISTRY}/instruments`]);
    expect((calls[0].init.headers as Record<string, string>)["User-Agent"]).toBe(DEFAULT_USER_AGENT);
  });

  it("treats an empty instruments list as a failure, not as no tokens", async () => {
    stubRegistry(json({ instruments: [], nextPageToken: null }));
    const r = await fetchRegistryInstruments(REGISTRY);
    expect(r).toMatchObject({ ok: false, status: 200 });
    expect(r.error).toContain("no instruments");
  });

  it("retries a 429, opening the host's gate, and succeeds when the host relents", async () => {
    vi.useFakeTimers();
    stubRegistry(json({}, 429, { "retry-after": "6" }), json({ instruments: [CC] }));
    const r = await withTimers(fetchRegistryInstruments(REGISTRY));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(scanGateUntil("scan.example.invalid", 0)).not.toBeNull();
  });

  it("gives up after its three backoffs, reporting the status", async () => {
    vi.useFakeTimers();
    stubRegistry(json({}, 503));
    const r = await withTimers(fetchRegistryInstruments(REGISTRY));
    expect(r).toMatchObject({ ok: false, status: 503, error: "HTTP 503" });
    expect(calls).toHaveLength(4);
  });

  it("does not retry a 404, and never throws when the host is unreachable", async () => {
    stubRegistry(json({}, 404));
    expect(await fetchRegistryInstruments(REGISTRY)).toMatchObject({ ok: false, status: 404 });
    expect(calls).toHaveLength(1);
    vi.useFakeTimers();
    stubRegistry(new Error("ECONNRESET"));
    expect(await withTimers(fetchRegistryInstruments(REGISTRY))).toMatchObject({ ok: false, error: "ECONNRESET" });
  });

  it("drops a malformed instrument, and keeps one that reports no supply", async () => {
    stubRegistry(json({ instruments: [CC, null, { name: "no id" }, "nonsense", { id: "X" }] }));
    const r = await fetchRegistryInstruments(REGISTRY);
    expect(r.instruments.map((i) => i.id)).toEqual(["Amulet", "X"]);
    expect(r.instruments[1]).toMatchObject({ totalSupply: null, totalSupplyAsOf: null });
  });
});

describe("runSupplyCollection", () => {
  it("stores Canton Coin's reading from the first Scan host's registry, once per instant", async () => {
    stubRegistry(json({ instruments: [{ ...CC, id: "Other", totalSupply: "1.0" }, CC] }));
    const writer = memoryWriter();
    const first = await runSupplyCollection({ writer });
    expect(first).toEqual({
      ok: true,
      registry: REGISTRY,
      reading: { supply_as_of: "2026-10-26T00:00:00Z", total_supply: "39922370813.3258635595", source_host: "scan.example.invalid" },
      inserted: true,
      no_supply_reported: false,
      error: null,
    });
    // A replica repeating the same reading: stored already, still a good run.
    const again = await runSupplyCollection({ writer });
    expect(again).toMatchObject({ ok: true, inserted: false });
    expect([...writer.rows.keys()]).toEqual(["2026-10-26T00:00:00.000Z"]);
    expect(CC_INSTRUMENT_ID).toBe("Amulet");
  });

  it("stores nothing and is not a failure when the registry reports no supply", async () => {
    stubRegistry(json({ instruments: [{ id: "Amulet", name: "Canton Coin", symbol: "CC" }] }));
    const writer = memoryWriter();
    expect(await runSupplyCollection({ writer })).toMatchObject({ ok: true, no_supply_reported: true, reading: null });
    expect(writer.rows.size).toBe(0);
  });

  it("fails a run whose registry lacks the instrument or does not answer, or whose write fails", async () => {
    const writer = memoryWriter();
    stubRegistry(json({ instruments: [{ ...CC, id: "Other" }] }));
    expect(await runSupplyCollection({ writer })).toMatchObject({ ok: false, error: "instrument Amulet absent from registry" });
    stubRegistry(json({}, 404));
    expect(await runSupplyCollection({ writer })).toMatchObject({ ok: false, error: "HTTP 404" });
    stubRegistry(json({ instruments: [CC] }));
    const broken: SupplyWriter = { recordSupplyReading: async () => { throw new Error("disk full"); } };
    expect(await runSupplyCollection({ writer: broken })).toMatchObject({ ok: false, inserted: false, error: "write failed: disk full" });
    expect(writer.rows.size).toBe(0);
  });

  it("alerts once after four failing runs in a row, and once on recovery", async () => {
    const writer = memoryWriter();
    stubRegistry(json({}, 404));
    for (let i = 0; i < 4; i++) await runSupplyCollection({ writer });
    await runSupplyCollection({ writer });
    expect(sent.map((s) => s.title)).toEqual(["Asset supply feed degraded"]);
    expect(sent[0].text).toContain("CC registry (registry:CC): 4 consecutive failing runs; HTTP 404");
    stubRegistry(json({ instruments: [CC] }));
    await runSupplyCollection({ writer });
    expect(sent.map((s) => s.title)).toEqual(["Asset supply feed degraded", "Asset supply feed recovered"]);
  });
});

describe("the collector's reading in Postgres", () => {
  it("is what getSupplyAt reads back for the end of the day, digit for digit", async () => {
    const db = await PGlite.create();
    try {
      for (const f of ["plain-postgres-roles.sql", "schema.sql", "supply.sql"]) {
        await db.exec(readFileSync(join(process.cwd(), "sql", f), "utf-8"));
      }
      const client: SqlClient = { query: async (text, params) => ({ rows: (await db.query(text, params)).rows as Record<string, unknown>[] }) };
      stubRegistry(json({ instruments: [CC] }));
      const writer = postgresSupplyWriter(client);
      expect(await runSupplyCollection({ writer })).toMatchObject({ ok: true, inserted: true });
      expect(await runSupplyCollection({ writer })).toMatchObject({ ok: true, inserted: false });
      const store = postgresRecordStore(client);
      expect(await store.getSupplyAt("2026-10-26T00:00:00Z")).toEqual({ value: "39922370813.3258635595", source_host: "scan.example.invalid" });
      expect(await store.getSupplyAt("2026-10-25T00:00:00Z")).toBeNull();
    } finally {
      await db.close();
    }
  });
});
