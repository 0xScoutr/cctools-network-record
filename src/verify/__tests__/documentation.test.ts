/**
 * The render check of methodology.json and datapackage.json over the recorded
 * day: a published copy whose prose differs is a warning, one that states
 * different facts about the data fails. No Scan, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentationFacts } from "../documentation";
import { dirPublished, type PublishedSource } from "../published";
import { verifyDay } from "../verify";

const DIR = join(process.cwd(), "fixtures", "verify", "2026-10-25");
const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as { date: string; recorded_at: string };
const published = (path: string) => readFileSync(join(DIR, "published", path), "utf-8");

/** The recorded files, with one of them changed as `edit` says, as the published copy. */
function edited(path: string, edit: (doc: Record<string, any>) => void): PublishedSource {
  const real = dirPublished(DIR);
  return {
    origin: real.origin,
    async get(p) {
      const f = await real.get(p);
      if (!f || p !== path) return f;
      const doc = JSON.parse(f.body);
      edit(doc);
      return { ...f, body: `${JSON.stringify(doc, null, 2)}\n` };
    },
  };
}

async function renderCheck(source: PublishedSource, path: string) {
  const report = await verifyDay({ date: meta.date, published: source, now: new Date(meta.recorded_at) });
  return report.checks.find((c) => c.part === "render" && c.name === path)!;
}

const section = (doc: Record<string, any>, id: string) => doc.sections.find((s: { id: string }) => s.id === id);

describe("the render check of the documentation files", () => {
  it("fails a datapackage.json that names another source host", async () => {
    const c = await renderCheck(edited("datapackage.json", (d) => { d.sources[0].path = "https://scan.example.invalid"; }), "datapackage.json");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("sources[0].path");
  });

  it("fails a datapackage.json that gives a field another unit", async () => {
    const c = await renderCheck(
      edited("datapackage.json", (d) => {
        const field = d.resources[0].schema.fields.find((f: { name: string }) => f.name === "supply_cc");
        field.unit = "USD";
      }),
      "datapackage.json",
    );
    expect(c.status).toBe("fail");
  });

  it("warns on a datapackage.json whose description alone differs", async () => {
    const c = await renderCheck(edited("datapackage.json", (d) => { d.description = "Another wording."; }), "datapackage.json");
    expect(c.status).toBe("warn");
  });

  it("fails a methodology.json whose field table gives another first date", async () => {
    const c = await renderCheck(
      edited("methodology.json", (d) => {
        const row = section(d, "daily-record").table.rows.find((r: string[]) => r[0] === "supply_cc");
        row[4] = "2026-08-01";
      }),
      "methodology.json",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("since");
  });

  it("fails a methodology.json whose sources section names another host", async () => {
    const c = await renderCheck(
      edited("methodology.json", (d) => {
        const sources = section(d, "sources");
        sources.paragraphs[0] = sources.paragraphs[0].replace("api.cantonnodes.com", "scan.example.invalid");
      }),
      "methodology.json",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("source_hosts");
  });

  it("warns on a methodology.json whose prose alone differs", async () => {
    const c = await renderCheck(
      edited("methodology.json", (d) => { section(d, "rules").paragraphs[0] = "Another wording of the first rule."; }),
      "methodology.json",
    );
    expect(c.status).toBe("warn");
  });

  it("reads the recorded files' facts: one source host, a first date per series, the reason codes", () => {
    const m = documentationFacts("methodology.json", published("methodology.json")) as {
      source_hosts: string[];
      fields: Array<{ column: string; since: string }>;
      reason_codes: string[];
    };
    expect(m.source_hosts).toEqual(["api.cantonnodes.com"]);
    expect(m.fields.find((f) => f.column === "supply_cc")?.since).toBe("2026-09-02");
    expect(m.reason_codes).toContain("round_missed");
    const p = documentationFacts("datapackage.json", published("datapackage.json")) as Record<string, any>;
    expect(p.sources).toEqual([{ path: "https://api.cantonnodes.com" }]);
    expect(p.description).toBeUndefined();
  });
});
