// One pass of the record's jobs against a local Postgres: the schema, the
// round collector, the supply collector, finalize, and the render into out/.
// Run it from the repository root. On a schedule, never let two runs overlap:
// the module locks are the caller's and this example takes none, so wrap it
// in flock or a similar lock, since both runs would open .record-db/:
//
//   pnpm exec tsx examples/run-pipeline.ts
//
// It reads public Scan (SCAN_RECORD_HOSTS, default https://api.cantonnodes.com)
// and keeps the database in .record-db/, so each run continues the last one.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite"; // or a node-postgres Pool
import { directoryFileCache } from "../src/adapters/directory-file-cache";
import { postgresRecordReader, postgresRecordStore, postgresSupplyWriter, type SqlClient } from "../src/adapters/postgres-store";
import { publishRecord } from "../src/open-record/publish";
import { COLLECTOR_LOCK, runForwardCollection } from "../src/scan-record/collector";
import { ROUND_TOTALS_SERIES_VERIFIED } from "../src/scan-record/config";
import { runFinalize } from "../src/scan-record/finalize";
import { liveScanApi } from "../src/scan-record/scan-client";
import { runSupplyCollection } from "../src/scan-record/supply";

const pg = await PGlite.create(".record-db");
// The schema files are idempotent, so every run applies them.
for (const file of ["plain-postgres-roles.sql", "schema.sql", "supply.sql"]) {
  await pg.exec(readFileSync(new URL(`../sql/${file}`, import.meta.url), "utf-8"));
}
const db: SqlClient = {
  query: async (text, params) => ({ rows: (await pg.query(text, params)).rows as Record<string, unknown>[] }),
};

const store = postgresRecordStore(db);
await runForwardCollection({
  store,
  scan: liveScanApi("record"),
  now: new Date(),
  deadline: Date.now() + COLLECTOR_LOCK.holdMs - COLLECTOR_LOCK.marginMs,
});
await runSupplyCollection({ writer: postgresSupplyWriter(db) });
await runFinalize({ store, now: new Date(), roundTotalsVerified: ROUND_TOTALS_SERIES_VERIFIED });
await publishRecord({ reader: postgresRecordReader(db), cache: directoryFileCache("out"), now: new Date() });
await pg.close();
