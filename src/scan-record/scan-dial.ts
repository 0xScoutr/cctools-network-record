/**
 * How one Scan call leaves the machine that runs the record.
 *
 * A Super Validator's Scan answers only the IPs on its allowlist, and the IP
 * admitted can be a validator node's rather than this machine's. So a host
 * named in SCAN_FORWARD_PORTS ("host=port,...") is dialled at that port on the
 * loopback, where a TCP forward through the node listens, and everything above
 * the socket stays what a direct call would be: the URL keeps the real name and
 * no port, TLS is end to end with the Super Validator (SNI and the certificate
 * check use the real name, so the node cannot read or alter the traffic), and
 * the Host header carries no port. Node's fetch cannot do that (it ignores a
 * Host header and takes SNI from the URL), which is why this path uses
 * node:https. The ports are the operator's setting and never leave this
 * module: an error that names the loopback address is replaced
 * (redactLocalAddress).
 *
 * A host not named there is a plain fetch.
 */

import https from "node:https";
import { gunzip } from "node:zlib";

/** "host=port,host=port" to a lookup; a bad entry throws, so a typo fails the run instead of dialling the world. */
export function scanForwardPorts(raw = process.env.SCAN_FORWARD_PORTS ?? ""): Map<string, number> {
  const ports = new Map<string, number>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [host, port, ...rest] = entry.split("=");
    const n = Number(port);
    if (!host || rest.length > 0 || !Number.isInteger(n) || n < 1024 || n > 65535) {
      throw new Error(`SCAN_FORWARD_PORTS entry "${entry}" is not host=port with an unprivileged port`);
    }
    ports.set(host, n);
  }
  return ports;
}

function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function responseOf(status: number, raw: NodeJS.Dict<string | string[]>, body: Buffer): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    // The body is already whole and decoded, so these no longer describe it.
    if (value === undefined || key === "content-encoding" || key === "content-length" || key === "transfer-encoding") continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
  }
  const empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : new Uint8Array(body), { status, headers });
}

/** An IPv4 address with its port ("127.0.0.1:PORT"), as Node's connect errors name the forward's local end. */
const LOCAL_ADDRESS = /\b\d{1,3}(?:\.\d{1,3}){3}:\d+\b/g;

/** `text` with every IPv4 address and port replaced, so SCAN_FORWARD_PORTS never reaches a log line or an answer. */
export function redactLocalAddress(text: string): string {
  return text.replace(LOCAL_ADDRESS, "the forward's local port");
}

/**
 * A forward's error without the loopback address and port it names ("connect ECONNREFUSED 127.0.0.1:PORT"): a new
 * Error with the same name, the redacted message and the same `code`, and no `address`, `port` or stack of the old
 * one. Every other error, and every error whose message names no address, is handed on unchanged.
 */
function withoutLocalAddress(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const message = redactLocalAddress(err.message);
  if (message === err.message && !("port" in err)) return err;
  const clean = new Error(message) as NodeJS.ErrnoException;
  clean.name = err.name;
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined) clean.code = code;
  return clean;
}

/** An answer longer than a caller's DialLimits.maxBytes, on the wire or once decompressed. */
export class ScanBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Scan answer over ${maxBytes} bytes`);
    this.name = "ScanBodyTooLargeError";
  }
}

/** Limits a caller may set on one dial. Unset, nothing changes: the record's own reads dial without them. */
export interface DialLimits {
  /** Refuse an answer whose body passes this many bytes, compressed on the wire or decompressed. */
  maxBytes?: number;
}

function throughForward(target: URL, port: number, init: RequestInit, limits: DialLimits = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  const body = typeof init.body === "string" ? init.body : undefined;
  return new Promise((resolve, reject) => {
    // A timeout must read as fetch's does: the signal's own reason, a TimeoutError. Any other error leaves without the
    // forward's local port (withoutLocalAddress).
    const fail = (err: unknown) => reject(signal?.aborted ? signal.reason : withoutLocalAddress(err));
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        family: 4,
        servername: target.hostname,
        method: init.method ?? "GET",
        path: `${target.pathname}${target.search}`,
        // A known length, as fetch sends: without one Node frames a body as chunked, which a server may refuse (411).
        headers: {
          ...headersOf(init),
          host: target.hostname,
          "accept-encoding": "gzip",
          ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const max = limits.maxBytes;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (max !== undefined && received > max) {
            res.destroy();
            req.destroy();
            return reject(new ScanBodyTooLargeError(max));
          }
          chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const status = res.statusCode ?? 502;
          if (res.headers["content-encoding"] !== "gzip") return resolve(responseOf(status, res.headers, body));
          // maxOutputLength stops a small answer that inflates past the limit (zlib's ERR_BUFFER_TOO_LARGE).
          gunzip(body, max === undefined ? {} : { maxOutputLength: max }, (err, plain) => {
            if (err && max !== undefined && (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") return reject(new ScanBodyTooLargeError(max));
            return err ? fail(err) : resolve(responseOf(status, res.headers, plain));
          });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

/**
 * A fetch, except for a host named in SCAN_FORWARD_PORTS, which goes through its forward. `limits` applies to the
 * forward only, where the whole answer is held here before the caller sees it; a caller of the plain fetch path caps
 * its own read of the body.
 */
export function scanDial(url: string, init: RequestInit, limits?: DialLimits): Promise<Response> {
  const target = new URL(url);
  const port = scanForwardPorts().get(target.hostname);
  return port === undefined ? fetch(url, init) : throughForward(target, port, init, limits);
}
