# Drift check (proposal)

Status: proposal, not applied. Until the CCTools deployment imports this
package, it keeps its own copy of these modules. This check makes the
deployment's CI fail when its copy and this package diverge, so the public
code is always the code that produces the published files.

## What is compared

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

The two copies are not byte-identical: here, internal dependencies sit behind
the seams in `src/runtime/`, and comments describe the package rather than the
deployment. So the check does not compare the copies with each other. It pins
both sides:

* this package's `port-manifest.json` lists the sha256 of every file under
  `src/` and `sql/` (`pnpm manifest`; CI fails when it is out of date);
* the deployment keeps a lock file with the sha256 of each of its modules
  above, the package commit they were last ported to, and the sha256 of that
  commit's `port-manifest.json`.

## The lock file (in the deployment's repository)

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

## The check

```js
// check-network-record-drift.mjs, run by the deployment's CI.
// Fails when a record module changed without being ported to the package,
// when a module was added or removed without the lock knowing, or when the
// lock points at a package commit whose manifest is not the one pinned.
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
  if (got !== want) problems.push(`${path}: changed since the last port (lock ${want.slice(0, 12)}, now ${got.slice(0, 12)})`);
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
  console.error(`The record modules and the public package have drifted apart:\n- ${problems.join("\n- ")}`);
  console.error("Port the change to the package, push it there, then update the lock in the same change as the module.");
  process.exit(1);
}
console.log(`record modules match the package at ${lock.commit.slice(0, 12)}`);
```

The CI step runs it on every push that touches the record modules, the
migration or the lock:

```yaml
- name: Record modules match the public package
  run: node scripts/check-network-record-drift.mjs network-record.lock.json
  env:
    PACKAGE_READ_TOKEN: ${{ secrets.PACKAGE_READ_TOKEN }}   # only while the package repository is private
```

## The workflow it enforces

1. A change to a record module in the deployment fails this check.
2. The same change is ported to this package (with its tests), committed and
   pushed here; `pnpm manifest` updates `port-manifest.json`.
3. The deployment's change updates the lock in the same commit: the new module
   hashes, the package commit, and the new manifest hash.

A reviewer of either side can then see that the code serving the record is the
public code at a named commit. The check goes away when the deployment imports
this package and the internal dependencies become implementations of the
`src/runtime/` seams.

## A second, behavioural check

Hashes prove the copies were updated together, not that they behave the same.
The offline verify adds that: after a port, record a fresh day with
`pnpm verify --date <yesterday> --record fixtures/verify/<yesterday>`, so the
package's render must reproduce the files the deployment published that day,
byte for byte, and its Scan derivation must reproduce every value.
