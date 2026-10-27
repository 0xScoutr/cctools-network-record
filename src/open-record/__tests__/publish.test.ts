import { describe, expect, it } from "vitest";
import { RECORD_FIRST_DATE, addDays, dayFilePath, type Manifest, type StoredFile, type ValueRow } from "../contract";
import { generationIdFor, publishRecord, type FileCache, type RecordReader } from "../publish";
import { sha256Hex } from "../render";
import { fullDay, vrow } from "./helpers/rows";

// The published range starts at RECORD_FIRST_DATE, so the fixture days are
// counted from it: D0 and D1 are the whole range.
const D0 = RECORD_FIRST_DATE;
const D1 = addDays(D0, 1);

function harness(initial: ValueRow[]) {
  const state = {
    values: initial,
    dirty: "2026-10-06T02:35:00.000Z" as string | null,
    manifest: null as Manifest | null,
    manifestBroken: false,
    stored: new Map<string, StoredFile>(),
    writes: [] as string[][],
  };
  const reader: RecordReader = {
    values: async () => state.values,
    gaps: async () => [],
    revisions: async () => [],
    dirtyAt: async () => state.dirty,
  };
  const cache: FileCache = {
    manifest: async () =>
      state.manifestBroken ? { status: "error" } : state.manifest ? { status: "hit", value: state.manifest } : { status: "miss" },
    putFiles: async (files) => {
      state.writes.push(files.map((f) => f.path));
      for (const f of files) state.stored.set(f.path, f);
    },
    putManifest: async (m) => {
      state.manifest = m;
    },
  };
  return { state, reader, cache };
}

const days = () => [...fullDay(D0), ...fullDay(D1)];
const at = (iso: string) => new Date(iso);

describe("publishRecord", () => {
  it("names generations by time", () => {
    expect(generationIdFor(at("2026-10-06T02:40:00.123Z"))).toBe("g20261006T024000Z");
  });

  it("writes every file on the first render, then the manifest", async () => {
    const h = harness(days());
    const r = await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    expect(r).toMatchObject({ ok: true, generation_id: "g20261006T024000Z", latest_final_date: D1, files: 9 });
    expect(h.state.writes[0]).toEqual([
      "daily.csv", "daily.json", "values.csv", "gaps.csv", "revisions.csv", "datapackage.json", "methodology.json",
      dayFilePath(D0), dayFilePath(D1),
    ]);
    const daily = h.state.stored.get("daily.json")!;
    expect(daily.sha256).toBe(sha256Hex(daily.body));
    expect(JSON.parse(daily.body).generation_id).toBe("g20261006T024000Z");
    expect(h.state.manifest).toMatchObject({
      generation_id: "g20261006T024000Z", first_date: D0, last_date: D1,
      latest_final_date: D1, latest_provisional_date: null, dirty_at_rendered: "2026-10-06T02:35:00.000Z",
      source_hosts: ["api.cantonnodes.com"],
    });
    expect(h.state.manifest!.generations[0].files["daily.csv"]).toBe(h.state.stored.get("daily.csv")!.sha256);
  });

  it("skips a clean record without reading it", async () => {
    const h = harness(days());
    await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    h.state.values = [];
    const r = await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T03:40:00Z") });
    expect(r.skipped).toBe("clean");
    expect(h.state.writes).toHaveLength(1);
  });

  it("re-renders a clean record once the last render is 24 hours old", async () => {
    const h = harness(days());
    await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    const r = await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-07T02:40:00Z") });
    expect(r.skipped).toBeUndefined();
    expect(r.changed).toEqual([]);
    expect(h.state.manifest).toMatchObject({ generation_id: "g20261006T024000Z", rendered_at: "2026-10-07T02:40:00Z" });
  });

  it("writes no file when a dirty mark changed nothing, and keeps the generation", async () => {
    const h = harness(days());
    await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    h.state.dirty = "2026-10-06T03:35:00.000Z";
    const r = await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T03:40:00Z") });
    expect(r.changed).toEqual([]);
    expect(h.state.writes).toHaveLength(1);
    expect(h.state.manifest).toMatchObject({
      generation_id: "g20261006T024000Z", generated_at: "2026-10-06T02:40:00Z",
      dirty_at_rendered: "2026-10-06T03:35:00.000Z", rendered_at: "2026-10-06T03:40:00Z",
    });
  });

  it("rewrites only the files a changed value touches", async () => {
    const h = harness(days());
    await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    h.state.values = [...fullDay(D0), ...fullDay(D1, "final", { featured_apps: "128.0000000000" })];
    h.state.dirty = "2026-10-06T03:35:00.000Z";
    const r = await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T03:40:00Z") });
    expect(r.changed).toEqual(["daily.csv", "daily.json", "values.csv", dayFilePath(D1)]);
    expect(h.state.manifest!.files[dayFilePath(D0)].generation_id).toBe("g20261006T024000Z");
    expect(h.state.manifest!.files[dayFilePath(D1)].generation_id).toBe("g20261006T034000Z");
    expect(h.state.manifest!.generations.map((g) => g.generation_id)).toEqual(["g20261006T034000Z", "g20261006T024000Z"]);
  });

  it("names only the hosts of published values, as daily.json does", async () => {
    // A null row can still carry a source_host (the schema's provenance check
    // allows it); a null names no source.
    const withdrawn = { ...vrow(D1, "featured_apps", null), source_host: "scan.other.example" };
    const h = harness([...fullDay(D0), ...fullDay(D1).filter((v) => v.series !== "featured_apps"), withdrawn]);
    await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    expect(h.state.manifest!.source_hosts).toEqual(["api.cantonnodes.com"]);
    expect(h.state.stored.get("datapackage.json")!.body).not.toContain("scan.other.example");
  });

  it("marks the last day provisional until it settles", async () => {
    const h = harness([...fullDay(D0), ...fullDay(D1, "provisional")]);
    await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    expect(h.state.manifest).toMatchObject({ latest_final_date: D0, latest_provisional_date: D1 });
  });

  it("never overwrites anything when the manifest cannot be read", async () => {
    const h = harness(days());
    h.state.manifestBroken = true;
    const r = await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    expect(r.ok).toBe(false);
    expect(h.state.writes).toHaveLength(0);
    expect(h.state.manifest).toBeNull();
  });

  it("never publishes an empty record", async () => {
    const h = harness([]);
    const r = await publishRecord({ reader: h.reader, cache: h.cache, now: at("2026-10-06T02:40:00Z") });
    expect(r).toMatchObject({ ok: false, error: "no values to publish" });
    expect(h.state.writes).toHaveLength(0);
    expect(h.state.manifest).toBeNull();
  });

  it("keeps the last 24 generations", async () => {
    const h = harness(days());
    for (let i = 0; i < 30; i++) {
      h.state.values = [...fullDay(D0), ...fullDay(D1, "final", { featured_apps: `${130 + i}.0000000000` })];
      h.state.dirty = `d${i}`;
      await publishRecord({ reader: h.reader, cache: h.cache, now: new Date(Date.parse("2026-10-06T02:40:00Z") + i * 3_600_000) });
    }
    expect(h.state.manifest!.generations).toHaveLength(24);
    expect(h.state.manifest!.generations[0].generation_id).toBe("g20261007T074000Z");
  });
});
