# Drift check

Until the CCTools deployment imports this package, it keeps its own copy of
these modules. Two checks bound how far the two copies can drift apart, and
this page says exactly what each one guarantees:

* **The lock check** (a proposal for the deployment's CI, not applied yet)
  pins hashes on both sides. It makes every change to a record module in the
  deployment visible as a change to a lock that names a package commit. It
  does not compare the deployment's code with the package's: nothing checks
  that the named commit holds the same change.
* **The published-record check** (this repository's CI,
  `.github/workflows/published-record.yml`) renders the files the deployment
  published again with this package's code, byte for byte, every day. It
  catches a renderer that drifted, whatever the lock says, but only in what
  the render covers.

Neither proves on its own that the public code is the code that serves the
record. A comparison of each deployment module with the package file at the
pinned commit would close the gap; it needs both sources, so it belongs to
the deployment's repository.

## What is mapped

Each module of the deployment's copy maps to one or two files here:

| Deployment module | This package |
|---|---|
| `scan-record/acs.ts`, `config.ts`, `day-values.ts`, `decimal.ts`, `rounds.ts`, `snapshot.ts`, `collector.ts`, `backfill.ts`, `finalize.ts`, `health.ts`, `scan-budget.ts`, `scan-client.ts`, `round-totals-verified.json` | `src/scan-record/` (same names) |
| `scan-record/store.ts` | `src/scan-record/store.ts` (interface) and `src/adapters/supabase-store.ts` |
| `assets/registry.ts` and the Canton Coin part of the deployment's asset supply job | `src/scan-record/supply.ts` |
| `open-record/contract.ts`, `datapackage.ts`, `day-file.ts`, `methodology.ts`, `publish.ts`, `render.ts`, `serve.ts` | `src/open-record/` (same names) |
| `open-record/reader.ts` | `src/adapters/supabase-reader.ts` |
| the record migration | `sql/schema.sql` |
| the migration's live check | `sql/check-schema.sql` |

The supply row is outside the lock check below: the check hashes files under
one root and lists only `scan-record/` and `open-record/`, and the
deployment's supply job serves other registrars too, so only its Canton Coin
part was ported. Guarantees 1 and 2 cover the module rows under
`scan-record/` and `open-record/`; the `sql/` rows are not hashed by it.

The two copies are not byte-identical: here, internal dependencies sit behind
the seams in `src/runtime/`, and comments describe the package rather than the
deployment. That is why neither check below compares the copies' text.

## The lock check (proposal, in the deployment's repository)

It pins both sides:

* this package's `port-manifest.json` lists the sha256 of every file under
  `src/` and `sql/` (`pnpm manifest`; CI fails when it is out of date);
* the deployment keeps a lock file with the sha256 of each of its modules
  above, the package commit they were last ported to, and the sha256 of that
  commit's `port-manifest.json`.

What a passing run guarantees, and only that:

1. every record module in the deployment has the hash the lock pins, so a
   change to one fails CI unless the same change updates the lock;
2. no record module exists that the lock does not list;
3. the lock names a package commit whose `port-manifest.json` is the one
   pinned, so that commit exists and its file set is the one the lock saw.

What it does not guarantee: that the package commit holds the deployment's
change. Updating the lock is the porter's statement that it does. A lock
updated without a port, or with a port that changes behaviour, passes; the
change still shows in review as a lock change next to the module change.

### The lock file

```json
{
  "package": "0xScoutr/cctools-network-record",
  "commit": "<package commit the modules were last ported to>",
  "port_manifest_sha256": "<sha256 of port-manifest.json at that commit>",
  "root": "<directory of the record modules in the deployment>",
  "files": {
    "scan-record/decimal.ts": "<sha256, LF line ends>",
    "...": "..."
  }
}
```

### The script

```js
// check-network-record-drift.mjs, run by the deployment's CI.
// Fails when a record module changed without the lock changing with it,
// when a module was added or removed without the lock knowing, or when the
// lock points at a package commit whose manifest is not the one pinned. It
// does not compare a module with the package's file at that commit.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const lock = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const sha = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
const problems = [];

// 1. Every module as the lock last saw it.
for (const [path, want] of Object.entries(lock.files)) {
  let got;
  try {
    got = sha(readFileSync(join(lock.root, path), "utf-8"));
  } catch {
    problems.push(`${path}: in the lock, missing from the code`);
    continue;
  }
  if (got !== want) problems.push(`${path}: changed since the lock was last updated (lock ${want.slice(0, 12)}, now ${got.slice(0, 12)})`);
}

// 2. No module the lock does not know about.
for (const dir of ["scan-record", "open-record"]) {
  for (const name of readdirSync(join(lock.root, dir))) {
    if (name === "__tests__") continue;
    if (!(`${dir}/${name}` in lock.files)) problems.push(`${dir}/${name}: not in the lock (port it, or list it as not shared)`);
  }
}

// 3. The pinned package commit and its manifest.
const res = await fetch(`https://raw.githubusercontent.com/${lock.package}/${lock.commit}/port-manifest.json`, {
  headers: process.env.PACKAGE_READ_TOKEN ? { Authorization: `Bearer ${process.env.PACKAGE_READ_TOKEN}` } : {},
});
if (!res.ok) problems.push(`package commit ${lock.commit}: port-manifest.json answered ${res.status}`);
else if (sha(await res.text()) !== lock.port_manifest_sha256) problems.push(`package commit ${lock.commit}: port-manifest.json is not the pinned one`);

if (problems.length > 0) {
  console.error(`The record modules and the lock disagree:\n- ${problems.join("\n- ")}`);
  console.error("Port the change to the package, push it there, then update the lock in the same change as the module.");
  process.exit(1);
}
console.log(`record modules are the ones the lock pins, at package commit ${lock.commit.slice(0, 12)}`);
```

The CI step runs it on every push that touches the record modules, the
migration or the lock:

```yaml
- name: Record modules match the lock
  run: node scripts/check-network-record-drift.mjs network-record.lock.json
  env:
    PACKAGE_READ_TOKEN: ${{ secrets.PACKAGE_READ_TOKEN }}   # only while the package repository is private
```

### The workflow it asks for

1. A change to a record module in the deployment fails this check.
2. The same change is ported to this package (with its tests), committed and
   pushed here; `pnpm manifest` updates `port-manifest.json`.
3. The deployment's change updates the lock in the same commit: the new module
   hashes, the package commit, and the new manifest hash.

A reviewer of the deployment's change then sees which package commit it
claims to match, and has to read that commit to know the port is faithful.
The check goes away when the deployment imports this package and the
internal dependencies become implementations of the `src/runtime/` seams.

## The published-record check (this repository)

`.github/workflows/published-record.yml` runs every day at 06:17 UTC, and by
hand for any day. GitHub turns off scheduled workflows in a public repository
after 60 days without activity, so a quiet repository stops this check
without saying so; re-enable it from the Actions tab:

```sh
pnpm verify --date <yesterday> --skip-scan --strict
```

It reads the files the deployment published, so it needs the network and is
kept out of the default `ci` workflow, which runs with none. It checks each
file's sha256 against `status.json` and renders every file again from the
published rows with this package's code. With `--strict` a warning fails
too, the prose of `methodology.json` and `datapackage.json` included: the
day's last render (about 02:40 UTC, before the D+1 03:00 promise) is over
three hours old by 06:17, longer than the files' Cache-Control lets an edge
serve a copy (an hour, and another hour stale while it revalidates, unless
the origin is failing), so a difference means the deployment rendered with
code other than this package's.

What it covers: everything `src/open-record/` renders from the published
rows, on the data the record holds that day. What it does not cover: the
Scan derivation (`--skip-scan`; re-deriving a day from the public Scan host
takes over an hour, see the README), code paths the day's data does not
exercise, and a deployment change that has not reached a render yet. A
render at an unusual hour (a revision outside the daily cycle) can also
leave an edge copy of the previous generation within the window and fail a
run; the next day's run shows whether it lasted.

The Scan derivation is checked by hand after a port: record a fresh day with
`pnpm verify --date <yesterday> --record fixtures/verify/<yesterday>`, so the
package's derivation must reproduce every value the deployment published that
day; pointing `verify:offline` (`package.json`) at the new directory keeps
CI checking it offline from then on.
