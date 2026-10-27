// The sha256 of every source file of the package (src/, sql/), with line
// ends normalised to LF, in port-manifest.json. A deployment that keeps its
// own copy of these modules pins this manifest's sha256 to tell when the two
// copies drifted apart (docs/drift-check.md).
//   node scripts/port-manifest.mjs           write port-manifest.json
//   node scripts/port-manifest.mjs --check   fail if it is out of date
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: a pathname keeps a space or an accent
// percent-encoded, and on Windows puts a slash before the drive letter.
const root = fileURLToPath(new URL("..", import.meta.url));
const roots = ["src", "sql"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const files = {};
for (const r of roots) {
  for (const path of walk(join(root, r))) {
    const text = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
    files[relative(root, path).split(sep).join("/")] = createHash("sha256").update(text, "utf8").digest("hex");
  }
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const manifest = `${JSON.stringify({ package: pkg.name, version: pkg.version, files }, null, 2)}\n`;
const target = join(root, "port-manifest.json");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf-8").replace(/\r\n/g, "\n");
  } catch {
    /* missing counts as out of date */
  }
  if (current !== manifest) {
    console.error("port-manifest.json is out of date: run `pnpm manifest` and commit it");
    process.exit(1);
  }
  console.log(`port-manifest.json is current (${Object.keys(files).length} files)`);
} else {
  writeFileSync(target, manifest);
  console.log(`wrote port-manifest.json (${Object.keys(files).length} files)`);
}
