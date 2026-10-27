/**
 * The README's "Run the pipeline" block is examples/run-pipeline.ts word for
 * word, so the type check covers what a reader copies; and the schema files
 * that example applies on every run apply twice to one database with the
 * schema's live check still passing. No network: the example itself is not
 * run, since it reads public Scan.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf-8").replace(/\r\n/g, "\n");

describe("examples/run-pipeline.ts", () => {
  it("is the README's pipeline block, word for word", () => {
    const section = read("README.md").split("\n## Run the pipeline\n")[1] ?? "";
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    expect(block).toBe(read("examples", "run-pipeline.ts"));
  });

  it("applies its schema files twice to one database, and the live check still passes", async () => {
    const db = await PGlite.create();
    try {
      for (let run = 0; run < 2; run++) {
        for (const file of ["plain-postgres-roles.sql", "schema.sql", "supply.sql"]) await db.exec(read("sql", file));
      }
      const check = read("sql", "check-schema.sql");
      const start = check.indexOf("do $check$");
      const end = check.indexOf("$check$;", start + 10) + "$check$;".length;
      await expect(db.query(check.slice(start, end))).rejects.toMatchObject({ message: "RECORD CHECK (rolled back): all checks ok" });
    } finally {
      await db.close();
    }
  });
});
