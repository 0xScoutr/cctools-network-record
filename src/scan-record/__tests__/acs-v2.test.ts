import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above these constants, so the factories only wrap them
// and read them at call time (the pattern of scan-client.test.ts).
const acquireScanSlot = vi.fn<(host: string, cls: string) => Promise<void>>(async () => {});
const openScanGate = vi.fn<(host: string, retryAfter: string | null) => number>(() => 0);
vi.mock("../scan-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scan-budget")>()),
  acquireScanSlot: (host: string, cls: string) => acquireScanSlot(host, cls),
  openScanGate: (host: string, retryAfter: string | null) => openScanGate(host, retryAfter),
}));
vi.mock("../../runtime/usage", () => ({ trackApiUsage: vi.fn() }));
const shared = new Map<string, unknown>();
vi.mock("../../runtime/shared-cache", () => ({
  sharedGet: (k: string) => shared.get(k) ?? null,
  sharedSet: (k: string, v: unknown) => void shared.set(k, v),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES } from "../acs";
import { ScanBusyError } from "../scan-budget";
import { ScanHttpError, ScanShapeError, acsEndpointAbsent, liveScanApi, scanCallWorstCaseMs, scanRequest } from "../scan-client";
import { readSnapshot } from "../snapshot";
import { FIXTURES, loadFixture } from "./helpers/fake-scan";

/**
 * Every request goes to a reserved .invalid host (RFC 2606): a stub that did
 * not attach would fail to resolve, never reach a real Scan. The stub also
 * refuses any other host, and afterEach fails the test that tried one.
 */
const HOST_A = "scan-a.example.invalid";
const HOST_B = "scan-b.example.invalid";
const V2 = "/v2/state/acs";
const V0 = "/v0/state/acs";
const FEATURED = TEMPLATES.featuredApp;
const AT = "2026-10-05T00:00:00Z";

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const refused: string[] = [];
type Answer = Response | Error;

function stub(answer: (path: string, body: Record<string, unknown>) => Answer) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (!u.hostname.endsWith(".invalid")) {
      refused.push(u.hostname);
      throw new Error(`the test stub refuses ${u.hostname}: only .invalid hosts`);
    }
    const body = JSON.parse(String(init.body ?? "null")) as Record<string, unknown>;
    calls.push({ url, body });
    const next = answer(u.pathname, body);
    if (next instanceof Error) throw next;
    return next;
  });
}
/** Answers in the order queued, whatever was asked. */
function queue(...answers: Answer[]) {
  stub((path) => answers.shift() ?? new Error(`no answer queued for ${path}`));
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** What api.cantonnodes.com (a Go router) answers for a path it does not route (raw headers, 2026-10-05 22:52 UTC). */
const notRouted = () => new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
/**
 * What api.cantonnodes.com answered to POST /v2/state/acs for a record time
 * with no snapshot (2026-10-05T00:00:01Z, migration 4, 2026-10-06 00:41 UTC):
 * 404, application/json, the Scan's own error passed through. Kept verbatim.
 */
const NO_SNAPSHOT_BODY = readFileSync(join(FIXTURES, "acs-v2-no-snapshot-404-2026-10-06.json"), "utf-8");
const noSnapshot = () => new Response(NO_SNAPSHOT_BODY, { status: 404, headers: { "content-type": "application/json" } });

const event = (id: string) => ({ contract_id: id, template_id: "aa11:Splice.Amulet:FeaturedAppRight", create_arguments: {} });
/** A v0 page: whole-number token, explicit null on the last page (api.cantonnodes.com, probe of 2026-09-25). */
const v0Page = (ids: string[], token: number | null) =>
  json({ record_time: AT, migration_id: 4, created_events: ids.map(event), next_page_token: token });
/** A v2 page: opaque string token, no token key on the last page (scan.yaml at tag 0.9.0, AcsResponseV2). */
const v2Page = (ids: string[], token?: string) =>
  json({ record_time: AT, migration_id: 4, created_events: ids.map(event), ...(token !== undefined ? { next_page_token: token } : {}) });
/**
 * The first page api.cantonnodes.com answered to POST /v2/state/acs on
 * 2026-10-05 23:33 UTC (FeaturedAppRight at 2026-10-05T00:00:00Z, migration 4,
 * page_size 1), trimmed to the fields the record reads.
 */
const probePage = loadFixture("acs-v2-featured-app-page-2026-10-05.json") as {
  record_time: string;
  next_page_token: string;
  created_events: Array<{ contract_id: string }>;
};

beforeEach(() => {
  calls.length = 0;
  refused.length = 0;
  shared.clear();
  acquireScanSlot.mockClear();
  openScanGate.mockClear();
  process.env.SCAN_RECORD_HOSTS = `https://${HOST_A}`;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SCAN_RECORD_HOSTS;
  expect(refused).toEqual([]);
});

describe("the test stub", () => {
  it("answers in place of the network, before any read below relies on it", async () => {
    queue(json({ stubbed: true }));
    const r = await scanRequest<{ stubbed: boolean }>(V2, { method: "POST", body: { page_size: 1 }, cls: "record" });
    expect(r).toEqual({ host: HOST_A, body: { stubbed: true } });
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V2}`]);
  });
});

describe("ACS reads: /v2/state/acs first, /v0/state/acs only where v2 is not served", () => {
  it("pages v2 with its opaque string token until the token is absent, from the probe's real first page", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    queue(json(probePage), v2Page(["second"]));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r.host).toBe(HOST_A);
    expect(r.endpoint).toBe(V2);
    expect(r.events.map((e) => e.contract_id)).toEqual([probePage.created_events[0].contract_id, "second"]);
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V2}`, `https://${HOST_A}${V2}`]);
    expect(calls[0].body).toEqual({ migration_id: 4, record_time: AT, page_size: 1000, templates: [FEATURED] });
    expect(calls[1].body).toEqual({ migration_id: 4, record_time: AT, page_size: 1000, templates: [FEATURED], after: probePage.next_page_token });
    // The log names the endpoint that answered, for every read.
    expect(info).toHaveBeenCalledWith(`[scan-record] ACS FeaturedAppRight at ${AT}: 2 contracts from ${HOST_A}${V2}`);
    info.mockRestore();
  });

  it("reads a host that does not route v2 through v0, and asks v0 directly while it remembers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queue(notRouted(), v0Page(["a"], 7), v0Page(["b"], null));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r).toMatchObject({ host: HOST_A, endpoint: V0 });
    expect(r.events.map((e) => e.contract_id)).toEqual(["a", "b"]);
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V2}`, `https://${HOST_A}${V0}`, `https://${HOST_A}${V0}`]);
    expect(calls[2].body.after).toBe(7);
    expect(warn).toHaveBeenCalledWith(`[scan-record] ${HOST_A} does not serve ${V2} (404); asking ${V0} there`);
    warn.mockRestore();

    calls.length = 0;
    queue(v0Page(["c"], null));
    const again = await liveScanApi("record").acsSnapshot(4, AT, TEMPLATES.dsoRules);
    expect(again.endpoint).toBe(V0);
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V0}`]);
  });

  it.each([
    ["405", () => new Response("method not allowed", { status: 405 })],
    ["501", () => json({ error: "not implemented" }, 501)],
  ])("reads v0 after a %s from v2", async (_status, answer) => {
    queue(answer(), v0Page(["a"], null));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r.endpoint).toBe(V0);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([V2, V0]);
  });

  it("never switches to v0 on a 429 from v2: it opens the gate, reports busy and asks v2 again next time", async () => {
    queue(json({}, 429, { "retry-after": "7" }));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toBeInstanceOf(ScanBusyError);
    expect(openScanGate).toHaveBeenCalledWith(HOST_A, "7");
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V2}`]);

    calls.length = 0;
    queue(v2Page(["a"]));
    expect((await liveScanApi("record").acsSnapshot(4, AT, FEATURED)).endpoint).toBe(V2);
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V2}`]);
  });

  it.each([
    ["a 503", () => new Response("upstream unavailable", { status: 503 }), 503],
    ["a 500", () => json({ error: "internal" }, 500), 500],
    ["Scan's own 404 for a record time with no snapshot", noSnapshot, 404],
  ])("keeps %s from v2 a failed read: no v0 call, nothing remembered", async (_what, answer, status) => {
    queue(answer());
    const err = await liveScanApi("record").acsSnapshot(4, AT, FEATURED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScanHttpError);
    expect(err).toMatchObject({ status, path: V2, host: HOST_A });
    expect(calls).toHaveLength(1);

    calls.length = 0;
    queue(v2Page(["a"]));
    expect((await liveScanApi("record").acsSnapshot(4, AT, FEATURED)).endpoint).toBe(V2);
  });

  it("reads api.cantonnodes.com's real answer for a record time with no snapshot as the endpoint's own, never as v2 absent", async () => {
    expect(JSON.parse(NO_SNAPSHOT_BODY)).toEqual({ error: "Failed to find ACS snapshot for migration id 4 at 2026-10-05T00:00:01Z" });
    expect(acsEndpointAbsent(new ScanHttpError(HOST_A, V2, 404, NO_SNAPSHOT_BODY))).toBe(false);
    queue(noSnapshot());
    const err = await liveScanApi("record").acsSnapshot(4, "2026-10-05T00:00:01Z", FEATURED).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ScanHttpError", status: 404, path: V2, host: HOST_A, detail: NO_SNAPSHOT_BODY });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([V2]);
  });

  it("goes back to v2 on the same read when the v0 it remembered stops being served there", async () => {
    queue(notRouted(), v0Page(["a"], null));
    await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    calls.length = 0;
    queue(notRouted(), v2Page(["b"]));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r).toMatchObject({ host: HOST_A, endpoint: V2 });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([V0, V2]);

    calls.length = 0;
    queue(v2Page(["c"]));
    await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([V2]);
  });

  it("fails a read that neither endpoint serves, with the second answer", async () => {
    queue(notRouted(), notRouted());
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toMatchObject({ status: 404, path: V0 });
    expect(calls).toHaveLength(2);
  });

  it("asks v0 on the host that did not route v2, not on the next one in the list", async () => {
    process.env.SCAN_RECORD_HOSTS = `https://${HOST_A}, https://${HOST_B}`;
    queue(notRouted(), v0Page(["a"], null));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r.host).toBe(HOST_A);
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V2}`, `https://${HOST_A}${V0}`]);
  });

  it("keeps every v2 page on the first page's host and endpoint: a 429 there reports busy, never v0 or another host", async () => {
    process.env.SCAN_RECORD_HOSTS = `https://${HOST_A}, https://${HOST_B}`;
    queue(v2Page(["a"], "dG9rZW4="), json({}, 429), v0Page(["b"], null));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toBeInstanceOf(ScanBusyError);
    expect(calls.map((c) => c.url)).toEqual([`https://${HOST_A}${V2}`, `https://${HOST_A}${V2}`]);
    expect(acquireScanSlot).not.toHaveBeenCalledWith(HOST_B, "record");
  });

  it("holds the v0 call to the deadline too, and remembers v2's absence so the next run asks v0 first", async () => {
    const t0 = Date.parse("2026-10-06T00:15:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      stub(() => {
        now.mockReturnValue(t0 + 30_000); // the v2 answer came after a 30 s slot
        return notRouted();
      });
      const deadline = t0 + scanCallWorstCaseMs("record") + 10_000;
      const err = await liveScanApi("record").acsSnapshot(4, AT, FEATURED, undefined, deadline).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScanBusyError);
      expect((err as ScanBusyError).reason).toBe("queue");
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual([V2]);
    } finally {
      now.mockRestore();
    }
    calls.length = 0;
    queue(v0Page(["a"], null));
    expect((await liveScanApi("record").acsSnapshot(4, AT, FEATURED)).endpoint).toBe(V0);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([V0]);
  });
});

describe("v2 page shape: a page that cannot be trusted is a failure, never a short count", () => {
  it.each([
    ["a whole-number token", 17],
    ["an object token", { after: 1 }],
  ])("refuses %s", async (_what, token) => {
    queue(json({ record_time: AT, migration_id: 4, created_events: [event("a")], next_page_token: token }));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toBeInstanceOf(ScanShapeError);
  });

  it.each([
    ["an explicit null token", null],
    ["an empty token", ""],
  ])("reads %s as the last page", async (_what, token) => {
    queue(json({ record_time: AT, migration_id: 4, created_events: [event("a")], next_page_token: token }));
    expect((await liveScanApi("record").acsSnapshot(4, AT, FEATURED)).events).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["without a token", undefined],
    ["with an empty token", ""],
  ])("refuses a full page %s", async (_what, token) => {
    queue(v2Page(Array.from({ length: 1000 }, (_, i) => `c${i}`), token));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toThrow(/full page/);
  });

  it("refuses an answer without created_events, for another migration or for another record time", async () => {
    for (const body of [
      { record_time: AT, migration_id: 4 },
      { record_time: AT, migration_id: 3, created_events: [] },
      { record_time: "2026-10-04T21:00:00Z", migration_id: 4, created_events: [] },
    ]) {
      queue(json(body));
      await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toBeInstanceOf(ScanShapeError);
    }
  });

  it("stops after five v2 pages", async () => {
    queue(...["1", "2", "3", "4", "5"].map((t) => v2Page([`c${t}`], `t${t}`)), v2Page(["c6"]));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toThrow(/ran past 5 pages/);
    expect(calls).toHaveLength(5);
  });
});

describe("the record's consumer", () => {
  type Page = Record<string, unknown> & { created_events: unknown[]; next_page_token?: unknown };
  const v0Snapshot = loadFixture("acs-snapshot-2026-06-01.json") as Record<string, Page>;
  /** The same contracts as v0Snapshot, as v2 pages; FeaturedAppRight and ValidatorLicense span two pages. */
  const v2Snapshot = loadFixture("acs-snapshot-2026-06-01-v2.json") as Record<string, Page[]>;
  const templateOf = (body: Record<string, unknown>) => (body.templates as string[])[0];

  it("gets the same snapshot row from v2 pages as from the equivalent v0 pages", async () => {
    stub((path, body) => {
      if (path !== V2) return notRouted();
      const pages = v2Snapshot[templateOf(body)];
      const at = pages.findIndex((p, i) => (i === 0 ? body.after === undefined : pages[i - 1].next_page_token === body.after));
      return at >= 0 ? json(pages[at]) : noSnapshot();
    });
    const fromV2 = await readSnapshot(liveScanApi("record"), 4, "2026-06-01", { withLicenses: true });
    expect(new Set(calls.map((c) => new URL(c.url).pathname))).toEqual(new Set([V2]));
    expect(calls).toHaveLength(7);

    shared.clear();
    calls.length = 0;
    stub((path, body) => (path === V0 ? json(v0Snapshot[templateOf(body)]) : notRouted()));
    const fromV0 = await readSnapshot(liveScanApi("record"), 4, "2026-06-01", { withLicenses: true });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([V2, V0, V0, V0, V0, V0]);

    expect(fromV2).toEqual(fromV0);
    expect(fromV2).toEqual({
      date: "2026-06-01", record_time: "2026-06-02T00:00:00Z", migration_id: 4, source_host: HOST_A,
      method: "scan-1", last_round: 98370, reference_round: 98373, reference_price_usd: "0.1560",
      super_validators: 4, sv_voting_threshold: 3, featured_apps: 3, validator_licenses: 2,
    });
  });
});
