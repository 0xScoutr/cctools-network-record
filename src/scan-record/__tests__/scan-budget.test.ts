import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
