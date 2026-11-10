/**
 * The supply collector's registry read along the Scan host list
 * (fetchCcRegistry): which registry each host serves, the Super Validators'
 * one place in the budget, and the reading that is too old to use. The budget
 * is stubbed so each test sees exactly what was asked of it; every request
 * goes to a stubbed global fetch for hosts under .invalid, through scanDial's
 * plain fetch path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { markScanCall, openScanGate, acquireScanSlot, releaseScanSlot, closeSvScanHost } = vi.hoisted(() => ({
  markScanCall: vi.fn(),
  openScanGate: vi.fn(),
  acquireScanSlot: vi.fn(async () => {}),
  releaseScanSlot: vi.fn(),
  closeSvScanHost: vi.fn(),
}));
vi.mock("../scan-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scan-budget")>()),
  markScanCall,
  openScanGate,
  acquireScanSlot,
  releaseScanSlot,
  closeSvScanHost,
}));

import { memoryCacheStore, setCacheStoreBackend } from "../../runtime/cache-store";
import { ccRegistryBases, fetchCcRegistry, runSupplyCollection, type SupplyReading, type SupplyWriter } from "../supply";

const SV_A = "scan.sv-8.global.canton.network.example.invalid";
const SV_B = "scan.sv-9.global.canton.network.example.invalid";
const LIST = `https://${SV_A}/api/scan, https://${SV_B}/api/scan, https://mirror.example.invalid`;
const reading = (hoursAgo: number) => ({
  instruments: [
    { id: "Amulet", name: "Canton Coin", symbol: "CC", totalSupply: "1.0", totalSupplyAsOf: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), decimals: 10, paused: false },
  ],
});
const ok = (hoursAgo = 1) => new Response(JSON.stringify(reading(hoursAgo)), { status: 200 });
const urls = (stub: ReturnType<typeof vi.fn>) => stub.mock.calls.map((c) => c[0]);

afterEach(() => {
  vi.unstubAllGlobals();
  markScanCall.mockClear();
  openScanGate.mockClear();
  acquireScanSlot.mockClear();
  releaseScanSlot.mockClear();
  closeSvScanHost.mockClear();
  delete process.env.SCAN_RECORD_HOSTS;
});

describe("the Canton Coin registry along the Scan host list", () => {
  it("finds the registry at the root of a Super Validator's host, not under /api/scan", () => {
    process.env.SCAN_RECORD_HOSTS = LIST;
    expect(ccRegistryBases()).toEqual([
      `https://${SV_A}/registry/metadata/v1`,
      `https://${SV_B}/registry/metadata/v1`,
      "https://mirror.example.invalid/registry/metadata/v1",
    ]);
  });

  it("is api.cantonnodes.com's with no setting, as before", () => {
    expect(ccRegistryBases()).toEqual(["https://api.cantonnodes.com/registry/metadata/v1"]);
  });

  it("reads the first Super Validator and says which registry served, through its one place in the budget", async () => {
    process.env.SCAN_RECORD_HOSTS = LIST;
    const stub = vi.fn(async () => ok());
    vi.stubGlobal("fetch", stub);
    const r = await fetchCcRegistry();
    expect(r).toMatchObject({ ok: true, registry: `https://${SV_A}/registry/metadata/v1` });
    expect(urls(stub)).toEqual([`https://${SV_A}/registry/metadata/v1/instruments`]);
    expect(acquireScanSlot).toHaveBeenCalledWith(SV_A, "cron");
    expect(releaseScanSlot).toHaveBeenCalledWith(SV_A);
  });

  it("goes on after a refusal, closing only that host and never retrying it", async () => {
    process.env.SCAN_RECORD_HOSTS = LIST;
    const stub = vi.fn().mockResolvedValueOnce(new Response("no", { status: 403 })).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", stub);
    const r = await fetchCcRegistry();
    expect(r).toMatchObject({ ok: true, registry: `https://${SV_B}/registry/metadata/v1` });
    expect(closeSvScanHost).toHaveBeenCalledWith(SV_A);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("stops asking Super Validators at a 429 and goes to the public host", async () => {
    process.env.SCAN_RECORD_HOSTS = LIST;
    acquireScanSlot.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      throw new Error("gate");
    });
    const stub = vi.fn().mockResolvedValueOnce(new Response("slow", { status: 429, headers: { "retry-after": "8" } })).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", stub);
    const r = await fetchCcRegistry();
    expect(openScanGate).toHaveBeenCalledWith(SV_A, "8");
    expect(urls(stub)).toEqual([`https://${SV_A}/registry/metadata/v1/instruments`, "https://mirror.example.invalid/registry/metadata/v1/instruments"]);
    expect(r).toMatchObject({ ok: true, registry: "https://mirror.example.invalid/registry/metadata/v1" });
  });

  it("reports no registry and the failure when every host failed", async () => {
    process.env.SCAN_RECORD_HOSTS = `https://${SV_A}/api/scan`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    expect(await fetchCcRegistry()).toMatchObject({ ok: false, registry: null, status: 403 });
  });

  it("with no Super Validator listed reads the first host's registry as it always did, outside the Super Validators' budget", async () => {
    const stub = vi.fn(async () => ok());
    vi.stubGlobal("fetch", stub);
    const r = await fetchCcRegistry();
    expect(urls(stub)).toEqual(["https://api.cantonnodes.com/registry/metadata/v1/instruments"]);
    expect(markScanCall).toHaveBeenCalledWith("api.cantonnodes.com", "cron");
    expect(acquireScanSlot).not.toHaveBeenCalled();
    expect(r.registry).toBe("https://api.cantonnodes.com/registry/metadata/v1");
  });

  describe("a reading too old to use", () => {
    it("goes on from a host 27 hours behind, without closing it", async () => {
      process.env.SCAN_RECORD_HOSTS = LIST;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok(27)).mockResolvedValueOnce(ok(1)));
      expect(await fetchCcRegistry()).toMatchObject({ ok: true, registry: `https://${SV_B}/registry/metadata/v1` });
      expect(closeSvScanHost).not.toHaveBeenCalled();
    });

    it("takes a host 3.5 hours behind", async () => {
      process.env.SCAN_RECORD_HOSTS = LIST;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok(3.5)));
      expect(await fetchCcRegistry()).toMatchObject({ ok: true, registry: `https://${SV_A}/registry/metadata/v1` });
    });
  });

  it("stores the reading under the host that served it", async () => {
    setCacheStoreBackend(memoryCacheStore());
    process.env.SCAN_RECORD_HOSTS = LIST;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("down", { status: 503 })).mockResolvedValueOnce(ok()));
    const rows: SupplyReading[] = [];
    const writer: SupplyWriter = {
      async recordSupplyReading(r) {
        rows.push(r);
        return true;
      },
    };
    const run = await runSupplyCollection({ writer });
    expect(run).toMatchObject({ ok: true, inserted: true, registry: `https://${SV_B}/registry/metadata/v1` });
    expect(rows.map((r) => r.source_host)).toEqual([SV_B]);
  });
});
