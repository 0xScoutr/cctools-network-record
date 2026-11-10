import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SCAN_RECORD_SPACING_MS = "200";
process.env.SCAN_RECORD_MAX_WAIT_MS = "300";
process.env.SCAN_BACKFILL_YIELD_MS = "300";

let b: typeof import("../scan-budget");

beforeAll(async () => {
  vi.resetModules();
  b = await import("../scan-budget");
});

afterAll(() => {
  delete process.env.SCAN_RECORD_SPACING_MS;
  delete process.env.SCAN_RECORD_MAX_WAIT_MS;
  delete process.env.SCAN_BACKFILL_YIELD_MS;
});

describe("Scan call budget", () => {
  it("never delays or refuses class 1 and other cron callers, even behind an open gate", async () => {
    b.openScanGate("h1", "30");
    const t0 = Date.now();
    await b.acquireScanSlot("h1", "user");
    await b.acquireScanSlot("h1", "cron");
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("refuses record calls while the 429 gate is open", async () => {
    b.openScanGate("h2", "10");
    await expect(b.acquireScanSlot("h2", "record")).rejects.toMatchObject({ name: "ScanBusyError", reason: "gate" });
  });

  it("spaces record calls on one shared schedule", async () => {
    await b.acquireScanSlot("h3", "record");
    const t0 = Date.now();
    await b.acquireScanSlot("h3", "record");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it("refuses a record call when the queue already runs past the longest wait", async () => {
    const first = b.acquireScanSlot("h11", "record");
    const second = b.acquireScanSlot("h11", "record");
    const third = b.acquireScanSlot("h11", "record");
    await expect(third).rejects.toMatchObject({ name: "ScanBusyError", reason: "queue" });
    await first;
    await second;
  });

  it("refuses a queued record call when the 429 gate opens while it waits", async () => {
    await b.acquireScanSlot("h9", "record");
    const queued = b.acquireScanSlot("h9", "record");
    setTimeout(() => b.openScanGate("h9", "10"), 50);
    await expect(queued).rejects.toMatchObject({ name: "ScanBusyError", reason: "gate" });
  });

  it("keeps backfill inside 02:00 to 06:00 UTC", async () => {
    await expect(
      b.acquireScanSlot("h4", "backfill", Date.parse("2026-10-12T12:00:00Z")),
    ).rejects.toMatchObject({ reason: "window" });
  });

  it("judges a caller's own window, across midnight too, and keeps 02:00 to 06:00 for every caller that passes none", () => {
    const at = (hhmm: string) => Date.parse(`2026-10-12T${hhmm}:00Z`);
    const wide = { startHour: 22, endHour: 10 };
    expect(["21:59", "22:00", "23:59", "00:00", "05:00", "09:59", "10:00", "12:00"].map((t) => b.inBackfillWindow(at(t), wide))).toEqual([
      false, true, true, true, true, true, false, false,
    ]);
    expect(["01:59", "02:00", "05:59", "06:00", "23:00"].map((t) => b.inBackfillWindow(at(t)))).toEqual([false, true, true, false, false]);
    expect(b.inBackfillWindow(at("03:00"), { startHour: 5, endHour: 5 })).toBe(false);
  });

  it("admits a backfill at 23:00 UTC only for a caller that passes a window holding it", async () => {
    const now = Date.parse("2026-10-12T23:00:00Z");
    await expect(b.acquireScanSlot("h4w", "backfill", now)).rejects.toMatchObject({ reason: "window" });
    await b.acquireScanSlot("h4w", "backfill", now, { startHour: 22, endHour: 10 });
    // The window is the backfill's alone: a record call ignores it.
    await expect(b.acquireScanSlot("h4x", "record", Date.parse("2026-10-12T12:00:00Z"), { startHour: 2, endHour: 3 })).resolves.toBeUndefined();
  });

  it("judges a caller's own window again after the queue wait: refused past its end, admitted across midnight", async () => {
    const wide = { startHour: 22, endHour: 10 };
    await b.acquireScanSlot("h12w", "record");
    await expect(b.acquireScanSlot("h12w", "backfill", Date.parse("2026-10-12T09:59:59.990Z"), wide)).rejects.toMatchObject({ reason: "window" });
    await b.acquireScanSlot("h13w", "record");
    await expect(b.acquireScanSlot("h13w", "backfill", Date.parse("2026-10-12T23:59:59.990Z"), wide)).resolves.toBeUndefined();
  });

  it("refuses a queued backfill that would dial after 06:00 UTC", async () => {
    const now = Date.parse("2026-10-12T05:59:59.990Z");
    await b.acquireScanSlot("h12", "record");
    await expect(b.acquireScanSlot("h12", "backfill", now)).rejects.toMatchObject({ reason: "window" });
  });

  it("never makes backfill wait for the record's own calls: they share the queue", async () => {
    const now = Date.parse("2026-10-12T03:00:00Z");
    b.markScanCall("h5a", "record", now - 50);
    const t0 = Date.now();
    await b.acquireScanSlot("h5a", "backfill", now);
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it("makes backfill wait out a scheduled caller's quiet period, then go", async () => {
    const now = Date.parse("2026-10-12T03:00:00Z");
    b.markScanCall("h5b", "cron", now - 100);
    const t0 = Date.now();
    await b.acquireScanSlot("h5b", "backfill", now);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it("makes backfill yield when the scheduled caller keeps dialling during the wait", async () => {
    const now = Date.parse("2026-10-12T03:00:00Z");
    b.markScanCall("h5c", "cron", now - 100);
    setTimeout(() => b.markScanCall("h5c", "cron", now + 50), 50);
    await expect(b.acquireScanSlot("h5c", "backfill", now)).rejects.toMatchObject({ reason: "yield" });
  });

  it("makes a queued backfill yield when a scheduled caller starts during the queue wait", async () => {
    const now = Date.parse("2026-10-12T03:00:00Z");
    await b.acquireScanSlot("h10", "record");
    const queued = b.acquireScanSlot("h10", "backfill", now);
    setTimeout(() => b.markScanCall("h10", "cron", now + 50), 50);
    await expect(queued).rejects.toMatchObject({ name: "ScanBusyError", reason: "yield" });
  });

  it("believes Retry-After within bounds, and falls back to 30 s without one", () => {
    const now = Date.now();
    expect(b.openScanGate("h6", "99999", now)).toBe(now + 3_600_000);
    expect(b.openScanGate("h7", null, now)).toBe(now + 30_000);
    expect(b.openScanGate("h8", "2", now)).toBe(now + 5_000);
    expect(b.scanGateUntil("h7", now)).toBe(now + 30_000);
  });

  it("reads Retry-After as an HTTP-date too", () => {
    const now = Date.now();
    const at = new Date(now + 120_000).toUTCString();
    expect(b.openScanGate("h14", at, now)).toBe(Date.parse(at));
  });

  it("never shortens a gate that is already open for longer", () => {
    const now = Date.now();
    expect(b.openScanGate("h13", "600", now)).toBe(now + 600_000);
    expect(b.openScanGate("h13", null, now)).toBe(now + 600_000);
    expect(b.scanGateUntil("h13", now)).toBe(now + 600_000);
  });

  it("bounds a call's wait: the queue for the record, the quiet period too for the backfill, none for user and cron", () => {
    expect(b.scanSlotMaxWaitMs("record")).toBe(300);
    expect(b.scanSlotMaxWaitMs("backfill")).toBe(600);
    expect(b.scanSlotMaxWaitMs("cron")).toBe(0);
    expect(b.scanSlotMaxWaitMs("user")).toBe(0);
  });
});

describe("Super Validator Scans: one budget for all of them", () => {
  const SV_A = "scan.sv-1.global.canton.network.example.invalid";
  const SV_B = "scan.sv-2.global.canton.network.example.invalid";

  it("names the host without its port, so a local forward never reaches source_host", () => {
    expect(b.hostOf(`https://${SV_A}:8443/api/scan`)).toBe(SV_A);
    expect(b.hostOf("https://api.cantonnodes.com/v0/dso")).toBe("api.cantonnodes.com");
  });

  it("recognises the network's own list of Scans, and nothing else", () => {
    const list = [
      "scan.sv-2.global.canton.network.digitalasset.com",
      "scan.sv.global.canton.network.sv-nodeops.com",
      "scan.sv-1.global.canton.network.lcv.mpch.io",
      "scan.sv-1.global.canton.network.c7.digital",
      "scan.sv-1.global.canton.network.digitalasset.com",
      "scan.sv-1.global.canton.network.proofgroup.xyz",
      "scan.sv-1.global.canton.network.sync.global",
      "scan.sv-1.global.canton.network.tradeweb.com",
      "scan.sv-1.global.canton.network.mpch.io",
      "scan.sv-1.global.canton.network.fivenorth.io",
      "scan.sv-2.global.canton.network.cumberland.io",
      "scan.sv-1.global.canton.network.cumberland.io",
      "scan.sv-1.global.canton.network.orb1lp.mpch.io",
    ];
    expect(list.filter(b.isSvScanHost)).toEqual(list);
    expect(b.isSvScanHost("api.cantonnodes.com")).toBe(false);
    expect(b.isSvScanHost("scan.example.org")).toBe(false);
  });

  describe("from a clean slate", () => {
    let fresh: typeof import("../scan-budget");

    beforeEach(async () => {
      const cache = await import("../../runtime/shared-cache");
      fresh = b;
      for (const key of ["scan:gate:sv-egress", "scan:next-slot:sv-egress", "scan:sv-egress:in-flight", "scan:sv-egress:strikes", `scan:host-down:${SV_A}`, `scan:host-down:${SV_B}`]) {
        cache.sharedDelete(key);
      }
      process.env.SCAN_RECORD_MAX_WAIT_MS = "300";
    });

    afterEach(() => {
      process.env.SCAN_RECORD_MAX_WAIT_MS = "300";
      delete process.env.SCAN_RECORD_SV_SPACING_MS;
    });

    it("holds every class to one request at a time, across hosts, until the call is released", async () => {
      await fresh.acquireScanSlot(SV_A, "cron");
      await expect(fresh.acquireScanSlot(SV_B, "record")).rejects.toMatchObject({ name: "ScanBusyError", reason: "queue" });
      await expect(fresh.acquireScanSlot(SV_B, "cron")).rejects.toMatchObject({ name: "ScanBusyError", reason: "queue" });
      fresh.releaseScanSlot(SV_A);
    });

    it("keeps the hard floor between two starts on the Super Validators, whatever the settings say", async () => {
      process.env.SCAN_RECORD_SV_SPACING_MS = "0";
      process.env.SCAN_RECORD_MAX_WAIT_MS = "5000";
      expect(fresh.svScanSpacingMs()).toBe(2_000);
      await fresh.acquireScanSlot(SV_A, "record");
      fresh.releaseScanSlot(SV_A);
      const t0 = Date.now();
      await fresh.acquireScanSlot(SV_B, "record");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900);
      fresh.releaseScanSlot(SV_B);
    });

    it("lets a setting raise the spacing", () => {
      process.env.SCAN_RECORD_SV_SPACING_MS = "5000";
      expect(fresh.svScanSpacingMs()).toBe(5_000);
    });

    it("closes every Super Validator Scan at the first 429 from one, for every class, and leaves a public host alone", async () => {
      fresh.openScanGate(SV_A, "60");
      for (const cls of ["record", "cron", "user"] as const) {
        await expect(fresh.acquireScanSlot(SV_B, cls)).rejects.toMatchObject({ name: "ScanBusyError", reason: "gate" });
      }
      expect(fresh.scanGateUntil("api.cantonnodes.com")).toBeNull();
      await fresh.acquireScanSlot("api.cantonnodes.com", "cron");
    });

    it("frees the one place when a queued call is refused after taking it", async () => {
      process.env.SCAN_RECORD_MAX_WAIT_MS = "5000";
      await fresh.acquireScanSlot(SV_A, "record");
      fresh.releaseScanSlot(SV_A);
      // Waits about 2 s for its start with the place held, and the gate opens meanwhile.
      const queued = fresh.acquireScanSlot(SV_B, "record");
      setTimeout(() => fresh.openScanGate(SV_A, "5"), 100);
      await expect(queued).rejects.toMatchObject({ reason: "gate" });
      process.env.SCAN_RECORD_MAX_WAIT_MS = "300";
      await expect(fresh.acquireScanSlot(SV_B, "record")).rejects.toMatchObject({ reason: "gate" });
      // Not "queue": nothing holds the place.
    });

    it("never makes an interactive call wait: a held place or a start not yet due refuses at once", async () => {
      process.env.SCAN_RECORD_MAX_WAIT_MS = "5000";
      await fresh.acquireScanSlot(SV_A, "cron");
      let t0 = Date.now();
      await expect(fresh.acquireScanSlot(SV_B, "user")).rejects.toMatchObject({ name: "ScanBusyError", reason: "queue" });
      expect(Date.now() - t0).toBeLessThan(100);
      fresh.releaseScanSlot(SV_A);
      // The place is free now, and the next start is about 2 s away.
      t0 = Date.now();
      await expect(fresh.acquireScanSlot(SV_B, "user")).rejects.toMatchObject({ name: "ScanBusyError", reason: "queue" });
      expect(Date.now() - t0).toBeLessThan(100);
      // That refusal gave the one place back: a cron caller can still take it.
      await fresh.acquireScanSlot(SV_B, "cron");
      fresh.releaseScanSlot(SV_B);
    });

    it("holds a 429 for hours, whatever Retry-After says, and longer each time, because the allowlisted IP's access is a privilege", () => {
      const now = Date.now();
      const HOUR = 3_600_000;
      // A Retry-After of 2 s, and none: the first closes for an hour either way.
      expect(fresh.openScanGate(SV_A, "2", now)).toBe(now + HOUR);
      const later = now + 2 * HOUR;
      expect(fresh.openScanGate(SV_B, null, later)).toBe(later + 6 * HOUR);
      const third = later + 7 * HOUR;
      expect(fresh.openScanGate(SV_A, "30", third)).toBe(third + 24 * HOUR);
      const fourth = third + 25 * HOUR;
      expect(fresh.openScanGate(SV_A, "30", fourth)).toBe(fourth + 24 * HOUR);
    });

    it("believes a Retry-After longer than its own backoff", () => {
      const now = Date.now();
      expect(fresh.openScanGate(SV_A, "10800", now)).toBe(now + 3 * 3_600_000);
    });

    it("leaves a public host's gate as it was: seconds, not hours", () => {
      const now = Date.now();
      expect(fresh.openScanGate("api.cantonnodes.com", "2", now)).toBe(now + 5_000);
    });

    it("closes only the host that failed some other way", async () => {
      fresh.closeSvScanHost(SV_A);
      await expect(fresh.acquireScanSlot(SV_A, "record")).rejects.toMatchObject({ name: "ScanBusyError", reason: "gate" });
      await fresh.acquireScanSlot(SV_B, "record");
      fresh.releaseScanSlot(SV_B);
    });

    it("leaves any other host's budget exactly as it was", async () => {
      await fresh.acquireScanSlot("scan.example.org", "cron");
      fresh.releaseScanSlot("scan.example.org");
      await fresh.acquireScanSlot(SV_A, "cron");
      fresh.releaseScanSlot("scan.example.org");
      await expect(fresh.acquireScanSlot(SV_B, "cron")).rejects.toMatchObject({ reason: "queue" });
      fresh.releaseScanSlot(SV_A);
    });
  });
});

describe("Scan call budget when the shared cache cannot be opened", () => {
  let broken: typeof import("../scan-budget");
  let previous: import("../../runtime/shared-cache").SharedCacheBackend;

  beforeAll(async () => {
    // A backend whose every read and write fails, as a store that cannot be opened.
    vi.resetModules();
    broken = await import("../scan-budget");
    const cache = await import("../../runtime/shared-cache");
    const fail = (): never => {
      throw new Error("shared cache unavailable");
    };
    previous = cache.setSharedCacheBackend({ get: fail, set: fail, delete: fail, transaction: fail });
  });

  afterAll(async () => {
    (await import("../../runtime/shared-cache")).setSharedCacheBackend(previous);
  });

  it("refuses record and backfill calls instead of dialling unspaced", async () => {
    await expect(broken.acquireScanSlot("h20", "record")).rejects.toMatchObject({ name: "ScanBusyError", reason: "gate" });
    await expect(
      broken.acquireScanSlot("h20", "backfill", Date.parse("2026-10-12T03:00:00Z")),
    ).rejects.toMatchObject({ name: "ScanBusyError", reason: "gate" });
  });

  it("still lets user and cron callers through at once", async () => {
    const t0 = Date.now();
    await broken.acquireScanSlot("h20", "user");
    await broken.acquireScanSlot("h20", "cron");
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe("Scan call budget when the shared schedule cannot be written", () => {
  let m: typeof import("../scan-budget");

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("../../runtime/shared-cache", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../runtime/shared-cache")>()),
      sharedReserveSlotStrict: () => ({ ok: false, reason: "error" }),
    }));
    m = await import("../scan-budget");
  });

  afterAll(() => {
    vi.doUnmock("../../runtime/shared-cache");
  });

  it("refuses record calls as queued out instead of going now", async () => {
    await expect(m.acquireScanSlot("h21", "record")).rejects.toMatchObject({ name: "ScanBusyError", reason: "queue" });
  });
});
