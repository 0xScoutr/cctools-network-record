import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above these constants, so the factory only wraps them
// and reads them at call time.
const acquireScanSlot = vi.fn(async (_host: string, _cls: string) => {});
const openScanGate = vi.fn((_host: string, _retryAfter: string | null) => 0);
const closeSvScanHost = vi.fn((_host: string) => {});
const releaseScanSlot = vi.fn((_host: string) => {});
vi.mock("../scan-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scan-budget")>()),
  acquireScanSlot: (host: string, cls: string) => acquireScanSlot(host, cls),
  openScanGate: (host: string, retryAfter: string | null) => openScanGate(host, retryAfter),
  closeSvScanHost: (host: string) => closeSvScanHost(host),
  releaseScanSlot: (host: string) => releaseScanSlot(host),
}));
vi.mock("../../runtime/usage", () => ({ trackApiUsage: vi.fn() }));
const shared = new Map<string, unknown>();
vi.mock("../../runtime/shared-cache", () => ({
  sharedGet: (k: string) => shared.get(k) ?? null,
  sharedSet: (k: string, v: unknown) => void shared.set(k, v),
}));

import { ScanBusyError } from "../scan-budget";
import {
  ScanHttpError,
  ScanShapeError,
  ScanTimeoutError,
  lastScanSource,
  liveScanApi,
  scanCallWorstCaseMs,
  scanRequest,
} from "../scan-client";

const calls: Array<{ url: string; init: RequestInit }> = [];
function respond(...responses: Array<Response | Error>) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const TWO_HOSTS = "https://scan.example.org, https://api.cantonnodes.com";
const FEATURED = "splice-amulet:Splice.Amulet:FeaturedAppRight";
const AT = "2026-10-06T00:00:00Z";
const event = (id: string) => ({ contract_id: id, template_id: "x:T", create_arguments: {} });
const acsPage = (ids: string[], nextPageToken: number | null, extra: Record<string, unknown> = {}) =>
  json({ record_time: AT, migration_id: 4, created_events: ids.map(event), next_page_token: nextPageToken, ...extra });
/** Reserved .invalid hosts (RFC 2606) for every liveScanApi read: a request the stub missed could not reach a real Scan. */
const INVALID_HOSTS = "https://scan.example.invalid, https://mirror.example.invalid";
/** A v2 page: opaque string token, no token key on the last page. */
const v2Page = (ids: string[], token?: string) =>
  json({ record_time: AT, migration_id: 4, created_events: ids.map(event), ...(token !== undefined ? { next_page_token: token } : {}) });
/** How a host that does not route /v2/state/acs answers (api.cantonnodes.com's plain-text 404). */
const notRouted = () => new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

beforeEach(() => {
  calls.length = 0;
  shared.clear();
  acquireScanSlot.mockClear();
  openScanGate.mockClear();
  closeSvScanHost.mockClear();
  releaseScanSlot.mockClear();
  delete process.env.SCAN_RECORD_HOSTS;
});
afterEach(() => vi.unstubAllGlobals());

describe("scanRequest", () => {
  it("posts JSON with our User-Agent through the budget and returns the host", async () => {
    respond(json({ ok: 1 }));
    const r = await scanRequest<{ ok: number }>("/v2/updates", { method: "POST", body: { page_size: 1 }, cls: "record" });
    expect(r).toEqual({ host: "api.cantonnodes.com", body: { ok: 1 } });
    expect(acquireScanSlot).toHaveBeenCalledWith("api.cantonnodes.com", "record");
    expect(calls[0].url).toBe("https://api.cantonnodes.com/v2/updates");
    expect((calls[0].init.headers as Record<string, string>)["User-Agent"]).toMatch(/^cctools-network-record\//);
    expect(calls[0].init.body).toBe('{"page_size":1}');
  });

  it("opens the shared gate on a 429, releases the unread body and reports busy instead of retrying", async () => {
    const throttled = json({}, 429, { "retry-after": "7" });
    respond(throttled);
    await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toBeInstanceOf(ScanBusyError);
    expect(openScanGate).toHaveBeenCalledWith("api.cantonnodes.com", "7");
    expect(throttled.bodyUsed).toBe(true);
  });

  it("treats a dropped connection as a throttle", async () => {
    respond(new TypeError("fetch failed"));
    await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toBeInstanceOf(ScanBusyError);
    expect(openScanGate).toHaveBeenCalledWith("api.cantonnodes.com", "30");
  });

  it("reports our own timeout as a failure, not a throttle, and leaves the gate shut", async () => {
    respond(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const err = await scanRequest("/v0/state/acs", { method: "POST", body: {}, cls: "record" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScanTimeoutError);
    expect(err).not.toBeInstanceOf(ScanBusyError);
    expect(openScanGate).not.toHaveBeenCalled();
  });

  it("surfaces any other status as a ScanHttpError", async () => {
    respond(new Response("404 page not found", { status: 404 }));
    await expect(scanRequest("/v0/state/acs", { method: "POST", body: {}, cls: "record" })).rejects.toMatchObject({
      name: "ScanHttpError",
      status: 404,
    });
    expect(ScanHttpError).toBeDefined();
  });

  it("rejects a 200 whose body is not JSON as a shape error", async () => {
    respond(new Response("<html>maintenance</html>", { status: 200 }));
    await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toBeInstanceOf(ScanShapeError);
  });

  it("uses the hosts in SCAN_RECORD_HOSTS, in order", async () => {
    process.env.SCAN_RECORD_HOSTS = "https://scan.example.org/, https://api.cantonnodes.com";
    respond(json({}));
    const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
    expect(r.host).toBe("scan.example.org");
  });

  it("refuses a SCAN_RECORD_HOSTS entry that is not an https URL, without dialling", async () => {
    process.env.SCAN_RECORD_HOSTS = "scan.example.org, https://api.cantonnodes.com";
    respond(json({}));
    await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toThrow(/not an https URL/);
    expect(calls).toHaveLength(0);
  });

  it("falls back to the next host when the budget refuses the first", async () => {
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    acquireScanSlot.mockImplementationOnce(async (host: string) => {
      throw new ScanBusyError(host, "queue");
    });
    respond(json({ ok: 1 }));
    const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
    expect(r.host).toBe("api.cantonnodes.com");
    expect(calls.map((c) => c.url)).toEqual(["https://api.cantonnodes.com/v0/dso"]);
  });

  it("falls back to the next host after a 429 on the first", async () => {
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    respond(json({}, 429), json({ ok: 1 }));
    const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
    expect(r.host).toBe("api.cantonnodes.com");
    expect(openScanGate).toHaveBeenCalledWith("scan.example.org", null);
    expect(calls.map((c) => c.url)).toEqual(["https://scan.example.org/v0/dso", "https://api.cantonnodes.com/v0/dso"]);
  });

  it("goes on to the next host when the first refuses or fails, without opening the 429 gate", async () => {
    for (const status of [403, 500, 502, 503, 504]) {
      calls.length = 0;
      process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
      respond(new Response("no", { status }), json({ ok: 1 }));
      const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
      expect(r.host).toBe("api.cantonnodes.com");
      expect(calls).toHaveLength(2);
    }
    expect(openScanGate).not.toHaveBeenCalled();
  });

  it("goes on to the next host after a timeout, which opens no gate", async () => {
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    respond(new DOMException("The operation was aborted due to timeout", "TimeoutError"), json({ ok: 1 }));
    const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
    expect(r.host).toBe("api.cantonnodes.com");
    expect(openScanGate).not.toHaveBeenCalled();
  });

  it("goes on to the next host when a 200 is not JSON (a maintenance page)", async () => {
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    respond(new Response("<html>maintenance</html>", { status: 200 }), json({ ok: 1 }));
    const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
    expect(r.host).toBe("api.cantonnodes.com");
  });

  it("stops at a real answer: a 404 from the first host is not a failed host", async () => {
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    respond(new Response('{"error":"Failed to find ACS snapshot"}', { status: 404 }), json({ ok: 1 }));
    await expect(scanRequest("/v2/state/acs", { method: "POST", body: {}, cls: "record" })).rejects.toMatchObject({
      name: "ScanHttpError",
      status: 404,
      host: "scan.example.org",
    });
    expect(calls).toHaveLength(1);
  });

  it("says in the log when it goes on to another host", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    respond(new Response("no", { status: 403 }), json({ ok: 1 }));
    await scanRequest("/v0/dso", { method: "GET", cls: "record" });
    expect(warn.mock.calls.flat().join(" ")).toContain("scan.example.org did not serve /v0/dso (HTTP 403); asking api.cantonnodes.com");
    warn.mockRestore();
  });

  it("reports the last host's failure when every host failed", async () => {
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    respond(new Response("no", { status: 403 }), new Response("down", { status: 503 }));
    await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toMatchObject({
      name: "ScanHttpError",
      status: 503,
      host: "api.cantonnodes.com",
    });
  });

  describe("on Super Validator hosts", () => {
    const SV_A = "scan.sv-8.global.canton.network.example.invalid";
    const SV_B = "scan.sv-9.global.canton.network.example.invalid";
    const SV_LIST = `https://${SV_A}/api/scan, https://${SV_B}/api/scan, https://mirror.example.invalid`;

    it("asks under the /api/scan prefix and credits the bare host", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      respond(json({ ok: 1 }));
      const r = await scanRequest("/v2/updates", { method: "POST", body: {}, cls: "record" });
      expect(calls[0].url).toBe(`https://${SV_A}/api/scan/v2/updates`);
      expect(r.host).toBe(SV_A);
      expect(releaseScanSlot).toHaveBeenCalledWith(SV_A);
    });

    it("refuses a Super Validator entry without the prefix, or with a port, without dialling", async () => {
      process.env.SCAN_RECORD_HOSTS = `https://${SV_A}`;
      respond(json({}));
      await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toThrow(/\/api\/scan/);
      process.env.SCAN_RECORD_HOSTS = `https://${SV_A}:8443/api/scan`;
      await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toThrow(/SCAN_FORWARD_PORTS/);
      expect(calls).toHaveLength(0);
    });

    it("refuses a typo in SCAN_FORWARD_PORTS before dialling, instead of reading it as a host that is down", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      process.env.SCAN_FORWARD_PORTS = `${SV_A}=not-a-port`;
      try {
        respond(json({}));
        await expect(scanRequest("/v0/dso", { method: "GET", cls: "record" })).rejects.toThrow(/SCAN_FORWARD_PORTS/);
        expect(calls).toHaveLength(0);
      } finally {
        delete process.env.SCAN_FORWARD_PORTS;
      }
    });

    it("closes only the failed host on a refusal, a dropped connection or a timeout, and tries the next Super Validator", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      respond(new Response("no", { status: 403 }), json({ ok: 1 }));
      const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
      expect(r.host).toBe(SV_B);
      expect(closeSvScanHost).toHaveBeenCalledWith(SV_A);

      closeSvScanHost.mockClear();
      calls.length = 0;
      respond(new TypeError("fetch failed"), json({ ok: 1 }));
      expect((await scanRequest("/v0/dso", { method: "GET", cls: "record" })).host).toBe(SV_B);
      expect(closeSvScanHost).toHaveBeenCalledWith(SV_A);

      closeSvScanHost.mockClear();
      calls.length = 0;
      respond(new DOMException("timed out", "TimeoutError"), json({ ok: 1 }));
      expect((await scanRequest("/v0/dso", { method: "GET", cls: "record" })).host).toBe(SV_B);
      expect(closeSvScanHost).toHaveBeenCalledWith(SV_A);
      expect(openScanGate).not.toHaveBeenCalled();
    });

    it("stops dialling Super Validators at the first 429, and goes to the public host", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      // What the real budget does once the gate is open: every Super Validator refuses.
      acquireScanSlot.mockImplementationOnce(async () => {}).mockImplementationOnce(async (host: string) => {
        throw new ScanBusyError(host, "gate");
      });
      respond(json({}, 429, { "retry-after": "9" }), json({ ok: 1 }));
      const r = await scanRequest("/v0/dso", { method: "GET", cls: "record" });
      expect(openScanGate).toHaveBeenCalledWith(SV_A, "9");
      expect(calls.map((c) => c.url)).toEqual([`https://${SV_A}/api/scan/v0/dso`, "https://mirror.example.invalid/v0/dso"]);
      expect(r.host).toBe("mirror.example.invalid");
    });

    it.each([400, 404, 411])("goes on after an HTTP %i from a Super Validator: it may not hold what was asked, and another may", async (status) => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      respond(new Response('{"error":"no"}', { status }), json({ ok: 1 }));
      const r = await scanRequest("/v2/state/acs", { method: "POST", body: {}, cls: "record" });
      expect(r.host).toBe(SV_B);
      // It answered, so it stays in the rotation for everything else.
      expect(closeSvScanHost).not.toHaveBeenCalled();
    });

    it("reads a day's snapshot from the next host when the first has only a stale one, and stays there for the rest of the read", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      const noSnapshot = () => new Response(`{"error":"Failed to find ACS snapshot for migration id 4 at ${AT}"}`, { status: 404 });
      respond(noSnapshot(), v2Page(["a"], "t1"), v2Page(["b"]));
      const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
      expect(r.host).toBe(SV_B);
      expect(r.events.map((e) => e.contract_id)).toEqual(["a", "b"]);
      expect(calls.map((c) => new URL(c.url).hostname)).toEqual([SV_A, SV_B, SV_B]);
    });

    it("reports the last host's answer when every host answered 404", async () => {
      process.env.SCAN_RECORD_HOSTS = `https://${SV_A}/api/scan, https://${SV_B}/api/scan`;
      respond(new Response('{"error":"no"}', { status: 404 }), new Response('{"error":"no"}', { status: 404 }));
      await expect(scanRequest("/v2/state/acs", { method: "POST", body: {}, cls: "record" })).rejects.toMatchObject({ status: 404, host: SV_B });
    });

    it("frees the Super Validators' one place after every answer, a failure included", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      respond(new Response("no", { status: 503 }), new TypeError("fetch failed"), json({ ok: 1 }));
      await scanRequest("/v0/dso", { method: "GET", cls: "record" });
      expect(releaseScanSlot.mock.calls.map((c) => c[0])).toEqual([SV_A, SV_B, "mirror.example.invalid"]);
    });

    it("does not free a place it never got", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      acquireScanSlot.mockImplementationOnce(async (host: string) => {
        throw new ScanBusyError(host, "queue");
      });
      respond(json({ ok: 1 }));
      await scanRequest("/v0/dso", { method: "GET", cls: "record" });
      expect(releaseScanSlot.mock.calls.map((c) => c[0])).toEqual([SV_B]);
    });

    it("keeps a pinned read on its host, failure or not: a page token is a position in that Scan", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      respond(new Response("down", { status: 503 }), json({ ok: 1 }));
      await expect(scanRequest("/v0/dso", { method: "GET", cls: "record", host: SV_A })).rejects.toMatchObject({ status: 503 });
      expect(calls).toHaveLength(1);
    });

    it("remembers nothing when the list names no Super Validator: with no setting nothing moves", async () => {
      delete process.env.SCAN_RECORD_HOSTS;
      respond(json({ ok: 1 }));
      await scanRequest("/v0/dso", { method: "GET", cls: "record" });
      expect(lastScanSource()).toBeNull();
    });

    it("remembers which host served last, for the source alarm", async () => {
      process.env.SCAN_RECORD_HOSTS = SV_LIST;
      respond(new Response("no", { status: 403 }), json({ ok: 1 }));
      await scanRequest("/v0/dso", { method: "GET", cls: "record" });
      expect(lastScanSource()?.host).toBe(SV_B);
    });
  });

  it("asks only the pinned host and reports busy instead of falling back", async () => {
    process.env.SCAN_RECORD_HOSTS = TWO_HOSTS;
    respond(json({}, 429), json({ ok: 1 }));
    await expect(
      scanRequest("/v0/dso", { method: "GET", cls: "record", host: "scan.example.org" }),
    ).rejects.toBeInstanceOf(ScanBusyError);
    expect(calls.map((c) => c.url)).toEqual(["https://scan.example.org/v0/dso"]);
    expect(acquireScanSlot).not.toHaveBeenCalledWith("api.cantonnodes.com", "record");
  });

  it("refuses a pinned host that is not configured", async () => {
    respond(json({ ok: 1 }));
    await expect(scanRequest("/v0/dso", { method: "GET", cls: "record", host: "scan.example.org" })).rejects.toThrow(
      /not in SCAN_RECORD_HOSTS/,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a call whose worst case would pass the deadline, before the budget or the network", async () => {
    respond(json({ ok: 1 }));
    const deadline = Date.now() + scanCallWorstCaseMs("record") - 1_000;
    const err = await scanRequest("/v0/dso", { method: "GET", cls: "record", deadline }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScanBusyError);
    expect((err as ScanBusyError).reason).toBe("queue");
    expect(acquireScanSlot).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("dials a call whose worst case still ends before the deadline", async () => {
    respond(json({ ok: 1 }));
    const deadline = Date.now() + scanCallWorstCaseMs("record") + 60_000;
    expect(await scanRequest("/v0/dso", { method: "GET", cls: "record", deadline })).toEqual({
      host: "api.cantonnodes.com",
      body: { ok: 1 },
    });
  });
});

describe("liveScanApi", () => {
  beforeEach(() => {
    process.env.SCAN_RECORD_HOSTS = INVALID_HOSTS;
  });
  afterEach(() => {
    expect(calls.map((c) => new URL(c.url).hostname).filter((h) => !h.endsWith(".invalid"))).toEqual([]);
  });

  it("checks the deadline again before every ACS page", async () => {
    const t0 = Date.parse("2026-10-06T00:01:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        now.mockReturnValue(t0 + 30_000); // the first page took 30 s
        return v2Page(["a"], "dG9rZW4=");
      });
      const deadline = t0 + scanCallWorstCaseMs("record") + 10_000;
      const err = await liveScanApi("record").acsSnapshot(4, AT, FEATURED, undefined, deadline).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScanBusyError);
      expect((err as ScanBusyError).reason).toBe("queue");
      expect(calls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("follows v0 ACS pages until next_page_token is null, on a host that does not serve v2", async () => {
    respond(notRouted(), acsPage(["a"], 17), acsPage(["b"], null));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r).toMatchObject({ host: "scan.example.invalid", endpoint: "/v0/state/acs" });
    expect(r.events.map((e) => e.contract_id)).toEqual(["a", "b"]);
    expect(JSON.parse(String(calls[2].init.body))).toMatchObject({ after: 17, page_size: 1000, record_time: AT });
  });

  it("keeps every ACS page on the first page's host: a 429 there never sends its token to another host", async () => {
    respond(v2Page(["a"], "dG9rZW4="), json({}, 429), v2Page(["b"]));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toBeInstanceOf(ScanBusyError);
    expect(calls.map((c) => c.url)).toEqual(["https://scan.example.invalid/v2/state/acs", "https://scan.example.invalid/v2/state/acs"]);
    expect(acquireScanSlot).not.toHaveBeenCalledWith("mirror.example.invalid", "record");
  });

  it("pins the later ACS pages to whichever host answered the first", async () => {
    acquireScanSlot.mockImplementationOnce(async (host: string) => {
      throw new ScanBusyError(host, "queue");
    });
    respond(v2Page(["a"], "dG9rZW4="), v2Page(["b"]));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r.host).toBe("mirror.example.invalid");
    expect(r.events.map((e) => e.contract_id)).toEqual(["a", "b"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://mirror.example.invalid/v2/state/acs",
      "https://mirror.example.invalid/v2/state/acs",
    ]);
  });

  it("asks only the caller's host from the first ACS page and reports busy there instead of falling back", async () => {
    respond(json({}, 429), v2Page(["a"]));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED, "scan.example.invalid")).rejects.toBeInstanceOf(
      ScanBusyError,
    );
    expect(calls.map((c) => c.url)).toEqual(["https://scan.example.invalid/v2/state/acs"]);
    expect(acquireScanSlot).not.toHaveBeenCalledWith("mirror.example.invalid", "record");
  });

  it("reads every ACS page from the caller's host, even when it is not the first in the list", async () => {
    respond(v2Page(["a"], "dG9rZW4="), v2Page(["b"]));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED, "mirror.example.invalid");
    expect(r.host).toBe("mirror.example.invalid");
    expect(calls.map((c) => c.url)).toEqual([
      "https://mirror.example.invalid/v2/state/acs",
      "https://mirror.example.invalid/v2/state/acs",
    ]);
  });

  it("refuses an ACS answer without created_events instead of counting zero", async () => {
    respond(json({ record_time: AT, migration_id: 4, next_page_token: null }));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toBeInstanceOf(ScanShapeError);
  });

  it("refuses an ACS answer for another record_time", async () => {
    respond(acsPage(["a"], null, { record_time: "2026-10-05T21:00:00Z" }));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toThrow(/record_time/);
  });

  it("accepts the same record_time written another way", async () => {
    respond(acsPage(["a"], null, { record_time: "2026-10-06T00:00:00.000000Z" }));
    const r = await liveScanApi("record").acsSnapshot(4, AT, FEATURED);
    expect(r.events).toHaveLength(1);
  });

  it("refuses an ACS answer for another migration", async () => {
    respond(acsPage(["a"], null, { migration_id: 3 }));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toThrow(/migration_id/);
  });

  it("refuses a v0 ACS page without the next_page_token key", async () => {
    respond(notRouted(), json({ record_time: AT, migration_id: 4, created_events: [event("a")] }));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toThrow(/next_page_token/);
  });

  it("refuses a full ACS page that carries no next_page_token", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    respond(acsPage(ids, null));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toThrow(/full page/);
  });

  it("stops after ACS_MAX_PAGES pages", async () => {
    respond(v2Page(["a"], "MQ=="), v2Page(["b"], "Mg=="), v2Page(["c"], "Mw=="), v2Page(["d"], "NA=="), v2Page(["e"], "NQ=="), v2Page(["f"]));
    await expect(liveScanApi("record").acsSnapshot(4, AT, FEATURED)).rejects.toThrow(/ran past 5 pages/);
    expect(calls).toHaveLength(5);
  });

  it("holds the migration, open-and-issuing and updates reads to the deadline, refusing before the network", async () => {
    respond(json({ migration_id: 4 }), json({ open_mining_rounds: {}, issuing_mining_rounds: {} }), json({ transactions: [] }));
    const deadline = Date.now() + scanCallWorstCaseMs("record") - 1_000;
    const api = liveScanApi("record");
    for (const read of [() => api.migrationId(deadline), () => api.openAndIssuing(deadline), () => api.updatesAfter(4, AT, 100, deadline)]) {
      const err = await read().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScanBusyError);
      expect((err as ScanBusyError).reason).toBe("queue");
    }
    expect(acquireScanSlot).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses an updates answer without a transactions array instead of reading 'nothing new'", async () => {
    respond(json({ updates: [] }));
    await expect(liveScanApi("record").updatesAfter(4, AT, 100)).rejects.toBeInstanceOf(ScanShapeError);
  });

  it("returns the transactions of an updates answer, even when there are none yet", async () => {
    respond(json({ transactions: [] }));
    expect(await liveScanApi("record").updatesAfter(4, AT, 100)).toEqual({ host: "scan.example.invalid", transactions: [] });
  });

  it("refuses an open-and-issuing answer without its round maps", async () => {
    respond(json({ open_mining_rounds: {} }));
    await expect(liveScanApi("record").openAndIssuing()).rejects.toBeInstanceOf(ScanShapeError);
  });

  it("caches the migration id for an hour", async () => {
    respond(json({ migration_id: 4 }));
    const api = liveScanApi("record");
    expect(await api.migrationId()).toBe(4);
    expect(await api.migrationId()).toBe(4);
    expect(calls).toHaveLength(1);
  });

  it.each([null, "", "4", -1, 4.5])("refuses migration_id %j instead of reading it as a number", async (value) => {
    respond(json({ migration_id: value }));
    await expect(liveScanApi("record").migrationId()).rejects.toBeInstanceOf(ScanShapeError);
    expect(shared.has("scan:migration-id")).toBe(false);
  });
});
