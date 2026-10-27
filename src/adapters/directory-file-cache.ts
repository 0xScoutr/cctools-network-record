/**
 * A FileCache on a local directory: every rendered file is written at its
 * published path (daily.csv, days/2026-10-25.json, ...) byte for byte, and
 * the manifest as .manifest.json beside them. For local runs: point a static
 * file server at the directory and it serves what the record serves.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Manifest } from "../open-record/contract";
import type { FileCache } from "../open-record/publish";

export const MANIFEST_FILE = ".manifest.json";

export function directoryFileCache(dir: string): FileCache {
  return {
    async manifest() {
      let text: string;
      try {
        text = await readFile(join(dir, MANIFEST_FILE), "utf-8");
      } catch (err) {
        return (err as { code?: unknown })?.code === "ENOENT" ? { status: "miss" } : { status: "error" };
      }
      try {
        return { status: "hit", value: JSON.parse(text) as Manifest };
      } catch {
        return { status: "error" };
      }
    },
    async putFiles(files) {
      for (const f of files) {
        const path = join(dir, f.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, f.body, "utf-8");
      }
    },
    async putManifest(manifest) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    },
  };
}
