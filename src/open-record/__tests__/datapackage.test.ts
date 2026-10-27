import { describe, expect, it } from "vitest";
import { DAILY_COLUMNS, LICENSE_SCOPE, SERIES, TRADEMARK_NOTICE } from "../contract";
import { renderDatapackage } from "../datapackage";

describe("datapackage.json (Frictionless Data Package v2)", () => {
  const doc = JSON.parse(renderDatapackage(["api.cantonnodes.com"], "g1"));

  it("declares the license, the source host and the schema version", () => {
    expect(doc.$schema).toBe("https://datapackage.org/profiles/2.0/datapackage.json");
    expect(doc.version).toBe("1.0.0");
    expect(doc.licenses).toEqual([{ name: "CC-BY-4.0", title: "Creative Commons Attribution 4.0 International", path: "https://creativecommons.org/licenses/by/4.0/" }]);
    expect(doc.sources[0].path).toBe("https://api.cantonnodes.com");
  });

  it("says the license covers CCTools' derived aggregates only, names the operator and carries the trademark notice", () => {
    expect(doc.description).toContain(LICENSE_SCOPE);
    expect(doc.rights).toBe(LICENSE_SCOPE);
    expect(doc.sources[0].title).toContain("Proof Group");
    expect(doc.sources[0].title).toContain("no published terms of service or data license");
    expect(doc.trademark_notice).toBe(TRADEMARK_NOTICE);
  });

  it("carries the trademark notice, word for word as the site footer does", () => {
    expect(doc.trademark_notice).toBe(
      "Canton is a registered trademark of Digital Asset (Switzerland) GmbH. Digital Asset is not affiliated with, and has not sponsored or endorsed, CCTools.",
    );
  });

  it("names the provider its one comparison refers to as Loop Data (formerly Lighthouse), by Five North, and says Lighthouse nowhere else", () => {
    const raw = renderDatapackage(["api.cantonnodes.com"], "g1");
    const bridge = "Loop Data (formerly Lighthouse), by Five North";
    expect(raw.split(bridge)).toHaveLength(2);
    expect(raw.split(bridge).join("")).not.toContain("Lighthouse");
  });

  it("describes every column of every CSV, with units on the series", () => {
    expect(doc.resources.map((r: { path: string }) => r.path)).toEqual(["daily.csv", "values.csv", "gaps.csv", "revisions.csv"]);
    const daily = doc.resources[0].schema;
    expect(daily.fields.map((f: { name: string }) => f.name)).toEqual([...DAILY_COLUMNS]);
    expect(daily.missingValues).toEqual([""]);
    const supply = daily.fields.find((f: { name: string }) => f.name === "supply_cc");
    expect(supply).toMatchObject({ type: "number", unit: "CC" });
    expect(daily.fields.find((f: { name: string }) => f.name === "rounds").type).toBe("integer");
    for (const name of ["app_reward_coupons", "validator_reward_coupons"]) {
      expect(daily.fields.find((f: { name: string }) => f.name === name), name).toMatchObject({ type: "number", unit: "coupons" });
    }
    expect(daily.fields.filter((f: { unit?: string }) => f.unit).length).toBe(SERIES.length);
  });

  it("carries no timestamp of its own, so it only changes when the schema or sources do", () => {
    expect(renderDatapackage(["api.cantonnodes.com"], "")).toBe(renderDatapackage(["api.cantonnodes.com"], ""));
    expect(JSON.stringify(doc)).not.toMatch(/"created"/);
  });
});
