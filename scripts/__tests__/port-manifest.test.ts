/**
 * scripts/port-manifest.mjs run from a copy of the package whose path has a
 * space and an accent, as a checkout under a user's home directory can.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "port manifest \u00e7 "));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

const script = join(dir, "scripts", "port-manifest.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf-8", timeout: 30_000 });
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("port-manifest.mjs", () => {
  it("writes and checks the manifest from a path with a space and an accent", () => {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(process.cwd(), "scripts", "port-manifest.mjs"), script);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "copy", version: "0.0.1" }));
    mkdirSync(join(dir, "src", "a"), { recursive: true });
    writeFileSync(join(dir, "src", "a", "one.ts"), "export const one = 1;\r\n");
    mkdirSync(join(dir, "sql"));
    writeFileSync(join(dir, "sql", "two.sql"), "select 2;\n");

    const write = run();
    expect(write.stderr).toBe("");
    expect(write.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "port-manifest.json"), "utf-8"));
    expect(manifest).toEqual({
      package: "copy",
      version: "0.0.1",
      files: { "src/a/one.ts": sha("export const one = 1;\n"), "sql/two.sql": sha("select 2;\n") },
    });
    expect(run("--check").status).toBe(0);

    writeFileSync(join(dir, "sql", "two.sql"), "select 3;\n");
    const stale = run("--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("out of date");
  });
});
