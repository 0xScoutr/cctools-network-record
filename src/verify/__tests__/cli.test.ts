/**
 * The verify command as `pnpm verify` runs it (tsx), for the paths that end
 * before any file or Scan is read: --help and a usage error. No network.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [tsx, join(process.cwd(), "src", "verify", "cli.ts"), ...args], { encoding: "utf-8", timeout: 60_000 });

describe("the verify command", () => {
  it("prints its usage on stdout and exits 0 for --help, named as it is run", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pnpm verify --date YYYY-MM-DD");
    expect(r.stdout).toContain("pnpm verify --offline DIR");
    expect(r.stdout + r.stderr).not.toContain("network-record-verify");
  });

  it("exits 2 with the message and the usage on stderr for an unknown argument", () => {
    const r = run("--nonsense");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("error: unknown argument --nonsense");
    expect(r.stderr).toContain("pnpm verify --offline DIR");
  });
});
