/**
 * How the Scan client reaches Scan: the ordered host list, the User-Agent and
 * the fetch implementation. Every field is optional:
 *   hosts      falls back to SCAN_RECORD_HOSTS (ordered, comma-separated
 *              https URLs), then to the default public host in scan-client.ts;
 *   userAgent  falls back to the package's own;
 *   fetch      falls back to the global fetch, looked up at call time.
 * The verify CLI sets all three: its hosts, a paced fetch, and, offline, a
 * fetch that replays a recorded tape.
 */

export interface ScanSettings {
  hosts?: readonly string[];
  userAgent?: string;
  fetch?: typeof fetch;
}

let settings: ScanSettings = {};

/** Replace the settings; returns the previous ones. */
export function configureScan(next: ScanSettings): ScanSettings {
  const previous = settings;
  settings = { ...next };
  return previous;
}

export function scanSettings(): Readonly<ScanSettings> {
  return settings;
}
