# cctools-network-record

The code that produces the **CCTools daily record of the Canton Network**, and a
`verify` command that lets anyone check a published day against public Scan.

The record is one row per UTC day of network state: mining rounds, issuance by
category, supply, the Super Validators' reference price, Super Validators,
featured apps and validator licenses. It is published as keyless files under
CC BY 4.0:

| File | What it holds |
|---|---|
| [daily.csv](https://api.cctools.network/api/open/network-record/v1/daily.csv), [daily.json](https://api.cctools.network/api/open/network-record/v1/daily.json) | one row per day, every series |
| [values.csv](https://api.cctools.network/api/open/network-record/v1/values.csv) | one row per day and series, with its source host, method and as-of time |
| [gaps.csv](https://api.cctools.network/api/open/network-record/v1/gaps.csv) | why each empty value is empty |
| [revisions.csv](https://api.cctools.network/api/open/network-record/v1/revisions.csv) | every change to a value after it became final |
| `days/YYYY-MM-DD.json` | one day, with its citation ([example](https://api.cctools.network/api/open/network-record/v1/days/2026-10-25.json)) |
| [datapackage.json](https://api.cctools.network/api/open/network-record/v1/datapackage.json) | Frictionless Data Package: fields, units, license, sources |
| [methodology.json](https://api.cctools.network/api/open/network-record/v1/methodology.json) | the methodology, rendered from the same code |
| [status.json](https://api.cctools.network/api/open/network-record/v1/status.json) | freshness, and the sha256 of every file for the last 24 generations |

The human-readable record is at <https://cctools.network/network>.

## What this repository contains

```
src/scan-record/   reading Scan and turning it into a day's values
  scan-client.ts     Scan HTTP: /v2/updates, /v2/state/acs (v0 as fallback), shape checks
  scan-budget.ts     one call budget per Scan host: spacing, the shared 429 gate
  rounds.ts          StartIssuing captures and each round's issuance split
  acs.ts, snapshot.ts the ACS snapshot series at D+1 00:00:00Z
  collector.ts       forward collection every five minutes, with targeted repair
  backfill.ts        snapshot reads for past days, and the license completion pass
  day-values.ts      one day computed from raw inputs, with every sanity gate
  finalize.ts        the single writer of values and gaps: provisional, final, revisions
  health.ts          the alarm latches around those jobs
src/open-record/   the published files
  contract.ts        every published name, unit, column, reason code and file
  render.ts, day-file.ts, datapackage.ts, methodology.ts, publish.ts, serve.ts
src/adapters/      storage: Postgres reference, in-memory, Supabase, a file directory
src/runtime/       the seams a deployment plugs into: shared state, alerts, Scan settings
src/verify/        the verify command
sql/               the schema, its live check, and the supply table of the reference adapter
fixtures/verify/   one published day and the Scan answers that re-derive it, for offline runs
```

## How a day is collected

A day is a UTC day D: `[D 00:00:00Z, D+1 00:00:00Z)`.

* **Rounds.** A mining round belongs to day D when the record time of its
  `AmuletRules_MiningRound_StartIssuing` exercise falls in D. `last_round(D)` is
  the highest `IssuingMiningRound` in the ACS snapshot at D+1 00:00:00Z, and
  `first_round(D)` is the previous day's `last_round + 1`. Both are published so
  anyone can recompute a day.
* **Issuance by category** is read from each round's StartIssuing exercise:
  the coupon totals of its `summary` times the per-coupon rates of the
  `IssuingMiningRound` it creates, and the `UnclaimedReward` and
  `UnclaimedDevelopmentFundCoupon` it creates, each read from its own event,
  never as a remainder. Amounts are exact decimals (BigInt at 20 places,
  published at 10). Every round must add up to the issuance its own config
  schedules (`amuletToIssuePerYear x tickDuration / 365 days`) within the
  rounding of its rates.
* **Snapshot series** (Super Validators, voting threshold, featured apps,
  validator licenses, the reference price) come from the one ACS snapshot at
  D+1 00:00:00Z, read from a single Scan host.
* **Supply** is the Scan token registry's `totalSupply` whose
  `totalSupplyAsOf` is exactly D+1 00:00:00Z, read at that instant.

The collector writes raw inputs only (`network_record_rounds`,
`network_record_snapshots`). `finalize.ts` is the single writer of the
published values: a value is provisional until D+1 02:00 UTC, then final, and
the day is promised final by D+1 03:00 UTC. A value that fails a sanity gate
(a round count outside 120 to 160, rounds that do not follow the previous day,
a count that moves more than 20% in a day, a round whose split does not add up)
is held provisional and alarmed, never published as a confident number. An
empty value always has a reason in `gaps.csv`. A final value changes only
through `revise_network_record()`, which logs the change in `revisions.csv`;
the schema enforces it.

## Verify a published day

Requires Node 20 or later and pnpm.

```sh
pnpm install
pnpm verify --date 2026-10-25
```

The command reads the published files and checks three things:

1. **Files.** Every file read has the sha256 that `status.json` lists for it
   (a day file: the ETag it was served with), so what was checked is what is
   served.
2. **Render.** Rendered again by this package's code from the published rows
   (`values.csv`, `gaps.csv`, `revisions.csv`), every file is byte for byte
   the published one. `methodology.json` and `datapackage.json` also carry
   prose rendered from the code, which a published copy can predate until the
   next render: when one of them differs, what it states about the data (the
   source hosts, each series' first date, method versions, fields and units,
   reason codes) must still be the same, or the check fails; a difference in
   the prose alone is a warning.
3. **Scan.** The day is re-derived from public Scan with the collector's own
   code: the ACS snapshots at D 00:00:00Z and D+1 00:00:00Z, then the
   StartIssuing exercise of every round from `first_round` to `last_round`,
   found on `/v2/updates`, then `computeDay`. Every published value must equal
   the re-derived one, and so must its as-of time.

Scan's registry serves only the current supply, so a past day's `supply_cc`
cannot be read again: the command takes it from the published file and says
so, and `net_supply_change_cc` is recomputed from the published supply of D
and D-1. The report lists both in a fourth section of their own, so the Scan
section counts only values re-derived from Scan.

The default Scan host is `https://api.cantonnodes.com`, the public host the
record reads (it is named on every value). It rate limits per client IP, so
the command spaces its requests (`--spacing-ms`, default 20000, 20 s) and
waits out a 429. Re-deriving one day takes about 215 requests (for
2026-10-25: the migration id, 8 ACS pages and 206 `/v2/updates` pages), so a
run takes at least 72 minutes at the default spacing. The default comes from
the run that recorded 2026-10-25: at the earlier spacing of 6.5 s, its 215
requests needed 23 minutes of spacing but took 76 minutes (about 2.8 a
minute), so about 53 minutes went to waiting out 429s. That rate was measured
on that run; the host publishes no limit. Any other Scan that serves the Splice Scan
API can be named with `--scan-host`, with a shorter `--spacing-ms` if it
allows more.

### Offline

```sh
pnpm verify:offline
# the same as
pnpm verify --offline fixtures/verify/2026-10-25
```

`--record DIR` keeps everything an online run read: the published files at
their paths with the headers they were served with, and a tape of the Scan
answers (`scan-tape.jsonl`). `--offline DIR` repeats the same checks over
them, with the same Scan client code and no network. The tape keeps what the
derivation reads and states what it left out:

* ACS pages of `DsoRules`, `OpenMiningRound` and `IssuingMiningRound` as served;
* ACS pages of `FeaturedAppRight` and `ValidatorLicense`, which the record only
  counts, with each event's `create_arguments` emptied: they name validator
  and app operators and carry the contact e-mail each validator registered,
  which a repository should not republish. The entry keeps the event count and
  the sha256 of the page as served;
* `/v2/updates` pages with each transaction that holds a StartIssuing exercise,
  unmodified, and the page's last transaction reduced to its `record_time`
  (where the page ends). The entry keeps how many transactions the page had and
  the sha256 of the page as served.

Other options: `--skip-scan` (files and render only), `--migration-id N`
(the synchronizer migration the day's snapshots were taken under; default
the current one), `--strict` (warnings fail too), `--json`.

## Run the pipeline

The jobs take a `RecordStore` and a `ScanApi`:

```ts
import { PGlite } from "@electric-sql/pglite"; // or a node-postgres Pool
import { postgresRecordStore, postgresRecordReader } from "./src/adapters/postgres-store";
import { directoryFileCache } from "./src/adapters/directory-file-cache";
import { runForwardCollection, COLLECTOR_LOCK } from "./src/scan-record/collector";
import { runFinalize } from "./src/scan-record/finalize";
import { ROUND_TOTALS_SERIES_VERIFIED } from "./src/scan-record/config";
import { liveScanApi } from "./src/scan-record/scan-client";
import { publishRecord } from "./src/open-record/publish";

const pg = await PGlite.create();
const db = { query: async (text: string, params?: unknown[]) => ({ rows: (await pg.query(text, params)).rows as Record<string, unknown>[] }) };
const store = postgresRecordStore(db);
await runForwardCollection({ store, scan: liveScanApi("record"), now: new Date(), deadline: Date.now() + COLLECTOR_LOCK.holdMs - COLLECTOR_LOCK.marginMs });
await runFinalize({ store, now: new Date(), roundTotalsVerified: ROUND_TOTALS_SERIES_VERIFIED });
await publishRecord({ reader: postgresRecordReader(db), cache: directoryFileCache("out"), now: new Date() });
```

The schedule the record runs on: the collector every five minutes, finalize
hourly at :35, render hourly at :40, the snapshot backfill every five minutes
from 02:00 to 06:00 UTC. Apply `sql/plain-postgres-roles.sql` (not needed on
Supabase), `sql/schema.sql` and `sql/supply.sql` first, then run
`sql/check-schema.sql`, which must fail with
`RECORD CHECK (rolled back): all checks ok`.

The runtime seams default to one process: `runtime/shared-cache.ts` (the Scan
gate, the call queue and the job locks) and `runtime/cache-store.ts` keep
state in memory, `runtime/alerts.ts` writes alerts to the console. A
deployment with several workers plugs in shared backends.

## Tests

```sh
pnpm typecheck
pnpm test
```

The suite needs no network and no database server: Scan is stubbed or
replayed, and the Postgres tests run the real schema, its live check and the
reference adapter in an in-process Postgres (PGlite). CI runs the type check,
the tests and the offline verify on every push.

## License

The code is licensed under the Apache License, Version 2.0 (`LICENSE`,
`NOTICE`). The published data is licensed under CC BY 4.0: it covers the
daily aggregates CCTools derives and their documentation, not the underlying
Scan data, which the Scan host serves under its own terms.

Canton is a registered trademark of Digital Asset (Switzerland) GmbH. Digital
Asset is not affiliated with, and has not sponsored or endorsed, CCTools.
