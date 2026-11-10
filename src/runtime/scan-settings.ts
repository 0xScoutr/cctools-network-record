/**
 * How the Scan client reaches Scan: the ordered host list, the User-Agent and
 * the fetch implementation. Every field is optional:
 *   hosts      falls back to SCAN_RECORD_HOSTS (ordered, comma-separated
 *              https URLs), then to the default public host in scan-client.ts;
 *   userAgent  falls back to the package's own;
 *   fetch      falls back to scanDial (scan-record/scan-dial.ts): the global
 *              fetch, looked up at call time, or the host's forward when
 *              SCAN_FORWARD_PORTS names it. A fetch set here replaces both, so
 *              it dials through scanDial itself when it should reach a
 *              forwarded host.
 * The verify CLI sets two of them: its hosts and a paced fetch over scanDial
 * (offline, a fetch that replays a recorded tape); the User-Agent stays the
 * package's own.
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
