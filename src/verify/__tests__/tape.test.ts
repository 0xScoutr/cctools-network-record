import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureScan } from "../../runtime/scan-settings";
import { memorySharedCache, setSharedCacheBackend, type SharedCacheBackend } from "../../runtime/shared-cache";
import { liveScanApi } from "../../scan-record/scan-client";
import { DEFAULT_SPACING_MS, pacedFetch, recordingFetch, reduceAcsPage, reduceUpdatesPage, replayFetch, VERIFY_SCAN_CLASS, type TapeEntry } from "../tape";

const tx = (id: string, at: string, choice?: string) => ({
  update_id: id,
  migration_id: 4,
  record_time: at,
  events_by_id: { [`${id}:0`]: { event_type: "exercised_event", choice: choice ?? "Other", template_id: "x:T" } },
});

describe("reduceUpdatesPage", () => {
  it("keeps every StartIssuing transaction whole and the last transaction as its record time", () => {
    const page = JSON.stringify({
      transactions: [
        tx("a", "2026-10-25T00:00:01Z"),
        tx("b", "2026-10-25T00:00:02Z", "AmuletRules_MiningRound_StartIssuing"),
        tx("c", "2026-10-25T00:00:03Z"),
        tx("d", "2026-10-25T00:00:04Z"),
      ],
    });
    const r = reduceUpdatesPage(page)!;
    const kept = (r.response as { transactions: Array<{ update_id: string; events_by_id: object }> }).transactions;
    expect(kept.map((t) => t.update_id)).toEqual(["b", "d"]);
    expect(kept[0]).toEqual(JSON.parse(page).transactions[1]);
    expect(kept[1]).toEqual({ update_id: "d", migration_id: 4, record_time: "2026-10-25T00:00:04Z", events_by_id: {} });
    expect(r.reduced).toMatchObject({ transactions: 4, kept: 2 });
    expect(r.reduced.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves a body that is not an updates page alone", () => {
    expect(reduceUpdatesPage("not json")).toBeNull();
    expect(reduceUpdatesPage(JSON.stringify({ created_events: [] }))).toBeNull();
  });
});

describe("recordingFetch and replayFetch", () => {
  it("replays recorded answers for the same request, in order, and fails on any other", async () => {
    const tape: TapeEntry[] = [];
    let n = 0;
    const live = (async () => new Response(JSON.stringify({ n: ++n }), { status: 200 })) as unknown as typeof fetch;
    const rec = recordingFetch(live, tape);
    const ask = (f: typeof fetch, body: object) =>
      f("https://scan.example.invalid/v2/state/acs", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
    expect(await ask(rec, { a: 1, b: 2 })).toEqual({ n: 1 });
    expect(await ask(rec, { a: 1, b: 2 })).toEqual({ n: 2 });
    const replay = replayFetch(tape);
    // The same body with its keys in another order is the same request.
    expect(await ask(replay, { b: 2, a: 1 })).toEqual({ n: 1 });
    expect(replay.unused()).toBe(1);
    expect(await ask(replay, { a: 1, b: 2 })).toEqual({ n: 2 });
    await expect(ask(replay, { a: 1, b: 2 })).rejects.toThrow(/no answer/);
  });
});

describe("pacedFetch", () => {
  it("waits out a 429 and retries, and gives each attempt its own timeout", async () => {
    const signals: AbortSignal[] = [];
    const answers = [new Response("", { status: 429, headers: { "retry-after": "0" } }), new Response("ok", { status: 200 })];
    const send = (async (_u: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return answers.shift()!;
    }) as unknown as typeof fetch;
    const f = pacedFetch({ spacingMs: 0, retries: 2, backoffMs: 1, send });
    const res = await f("https://scan.example.invalid/v0/migrations/last");
    expect(res.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  describe("by default", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts requests 20 s apart, the rate the public host sustained for the recorded day", async () => {
      expect(DEFAULT_SPACING_MS).toBe(20_000);
      vi.useFakeTimers();
      const starts: number[] = [];
      const send = (async () => {
        starts.push(Date.now());
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch;
      const f = pacedFetch({ retries: 0, backoffMs: 1, send });
      await f("https://scan.example.invalid/a");
      const second = f("https://scan.example.invalid/b");
      await vi.advanceTimersByTimeAsync(19_999);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(starts).toHaveLength(2);
      expect(starts[1] - starts[0]).toBe(20_000);
    });
  });

  it("returns the last 429 once its retries are spent", async () => {
    const send = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const f = pacedFetch({ spacingMs: 0, retries: 1, backoffMs: 1, send });
    expect((await f("https://scan.example.invalid/x")).status).toBe(429);
  });

  describe("on a Super Validator Scan", () => {
    const SV = "https://scan.sv-1.global.canton.network.example.invalid/api/scan";

    it("hands a 429 back at once, for the Scan client's budget to close them all", async () => {
      let sent = 0;
      const send = (async () => {
        sent++;
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }) as unknown as typeof fetch;
      const f = pacedFetch({ spacingMs: 0, retries: 6, backoffMs: 1, send });
      expect((await f(`${SV}/v0/dso`)).status).toBe(429);
      expect(sent).toBe(1);
    });

    it("throws a dropped connection at once", async () => {
      let sent = 0;
      const send = (async () => {
        sent++;
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      const f = pacedFetch({ spacingMs: 0, retries: 6, backoffMs: 1, send });
      await expect(f(`${SV}/v0/dso`)).rejects.toThrow("fetch failed");
      expect(sent).toBe(1);
    });
  });

  it("dials through scanDial by default: a plain fetch for a host with no forward", async () => {
    const stub = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await pacedFetch({ spacingMs: 0, retries: 0, backoffMs: 1 })("https://scan.example.invalid/v0/dso", { method: "GET" });
      expect(res.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(1);
      expect(stub.mock.calls[0][0]).toBe("https://scan.example.invalid/v0/dso");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a verification's budget class on a Super Validator Scan", () => {
  const SV = "https://scan.sv-1.global.canton.network.example.invalid/api/scan";
  let previous: SharedCacheBackend;

  beforeEach(() => {
    // A fresh process's budget for each run.
    previous = setSharedCacheBackend(memorySharedCache());
  });

  afterEach(() => {
    configureScan({});
    setSharedCacheBackend(previous);
  });

  /** Two reads in a row, as a verification makes them; how many reached the host. */
  async function twoReads(cls: Parameters<typeof liveScanApi>[0]): Promise<number> {
    let sent = 0;
    configureScan({
      hosts: [SV],
      fetch: (async () => {
        sent++;
        return new Response(JSON.stringify({ open_mining_rounds: {}, issuing_mining_rounds: {} }), { status: 200 });
      }) as typeof fetch,
    });
    const scan = liveScanApi(cls);
    for (let i = 0; i < 2; i++) await scan.openAndIssuing().catch(() => undefined);
    return sent;
  }

  it("is one that waits its turn, so a run goes past its second request", async () => {
    expect(VERIFY_SCAN_CLASS).toBe("cron");
    expect(await twoReads(VERIFY_SCAN_CLASS)).toBe(2);
  });

  it("is not the interactive class, which is refused at the second request", async () => {
    // The fresh process's budget: the first start set the next one 2 s later.
    expect(await twoReads("user")).toBe(1);
  });
});

describe("reduceAcsPage", () => {
  const page = {
    record_time: "2026-10-26T00:00:00Z",
    migration_id: 4,
    created_events: [
      {
        contract_id: "c1",
        template_id: "p:Splice.ValidatorLicense:ValidatorLicense",
        created_at: "2026-01-01T00:00:00Z",
        signatories: ["DSO::1220aa"],
        observers: ["some-validator-1::1220bb"],
        create_arguments: { validator: "some-validator-1::1220bb", metadata: { contactPoint: "someone@example.org" } },
      },
    ],
  };

  it("empties the arguments of a counted-only template and keeps the count and the page's hash", () => {
    const r = reduceAcsPage({ templates: ["splice-amulet:Splice.ValidatorLicense:ValidatorLicense"] }, page)!;
    const events = (r.response as typeof page).created_events;
    expect(events).toEqual([
      { contract_id: "c1", template_id: "p:Splice.ValidatorLicense:ValidatorLicense", created_at: "2026-01-01T00:00:00Z", create_arguments: {} },
    ]);
    expect((r.response as typeof page).record_time).toBe(page.record_time);
    expect(r.dropped.events).toBe(1);
    expect(r.dropped.json_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves a page the derivation reads the arguments of as served", () => {
    expect(reduceAcsPage({ templates: ["splice-amulet:Splice.Round:OpenMiningRound"] }, page)).toBeNull();
  });

  it("leaves no e-mail address in the recorded tape and no validator or app operator party on its counted pages", () => {
    const tape = readFileSync(join(process.cwd(), "fixtures", "verify", "2026-10-25", "scan-tape.jsonl"), "utf-8");
    expect(tape.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)).toBeNull();
    for (const line of tape.split(/\r?\n/).filter(Boolean)) {
      const e = JSON.parse(line) as { arguments_dropped?: unknown; response: { created_events?: Array<Record<string, unknown>> } };
      if (!e.arguments_dropped) continue;
      for (const ev of e.response.created_events ?? []) {
        // Its identity and nothing else: no signatories, observers or other field.
        const allowed = ["contract_id", "create_arguments", "created_at", "package_name", "template_id"];
        expect(Object.keys(ev).filter((k) => !allowed.includes(k))).toEqual([]);
        expect(Object.keys(ev)).toEqual(expect.arrayContaining(["contract_id", "create_arguments", "template_id"]));
        expect(ev.create_arguments).toEqual({});
      }
    }
  });
});
