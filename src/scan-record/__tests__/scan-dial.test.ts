/**
 * The forward path against a real local TLS server: what reaches the far end is what a direct call would send, and a
 * certificate for another name is refused, so the hop in the middle cannot read or alter the traffic.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { redactLocalAddress, ScanBodyTooLargeError, scanDial, scanForwardPorts } from "../scan-dial";

const NAME = "scan.sv-9.global.canton.network.example.invalid";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-dial-test-"));

function certFor(name: string): { key: string; cert: string } {
  const keyPath = path.join(dir, `${name}.key`);
  const certPath = path.join(dir, `${name}.crt`);
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`, "-keyout", keyPath, "-out", certPath],
    { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } },
  );
  return { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
}

interface Seen {
  host: string | undefined;
  servername: string | false | undefined;
  method: string | undefined;
  url: string | undefined;
  body: string;
  contentType: string | undefined;
  acceptEncoding: string | undefined;
  contentLength: string | undefined;
  transferEncoding: string | undefined;
}

let good: { key: string; cert: string };
let server: https.Server;
let otherNameServer: https.Server;
let seen: Seen[] = [];
let port = 0;
let otherPort = 0;
const previousCa = https.globalAgent.options.ca;

function serve(creds: { key: string; cert: string }): https.Server {
  return https.createServer(creds, (req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      seen.push({
        host: req.headers.host,
        servername: (req.socket as unknown as { servername?: string | false }).servername,
        method: req.method,
        url: req.url,
        body: Buffer.concat(parts).toString("utf8"),
        contentType: req.headers["content-type"],
        acceptEncoding: String(req.headers["accept-encoding"]),
        contentLength: req.headers["content-length"],
        transferEncoding: req.headers["transfer-encoding"],
      });
      if (req.url === "/slow") return; // Never answers.
      if (req.url === "/throttled") {
        res.writeHead(429, { "retry-after": "7" });
        return res.end("slow down");
      }
      const payload = JSON.stringify({ ok: 1 });
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ pad: "x".repeat(4_000) }));
      }
      if (req.url === "/gzip-big") {
        // About 120 bytes on the wire, 100 KB once inflated.
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        return res.end(gzipSync(JSON.stringify({ pad: "0".repeat(100_000) })));
      }
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        return res.end(gzipSync(payload));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
}

const listen = (s: https.Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

beforeAll(async () => {
  good = certFor(NAME);
  const other = certFor("other.example.invalid");
  // Trust both, so the second is refused for its name and not for its issuer.
  https.globalAgent.options.ca = [good.cert, other.cert];
  server = serve(good);
  otherNameServer = serve(other);
  port = await listen(server);
  otherPort = await listen(otherNameServer);
});

afterEach(() => {
  seen = [];
  delete process.env.SCAN_FORWARD_PORTS;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  https.globalAgent.options.ca = previousCa;
  try {
    // Either server is absent when beforeAll failed before it listened.
    for (const s of [server, otherNameServer]) s?.closeAllConnections();
    await Promise.all([server, otherNameServer].filter(Boolean).map((s) => new Promise((r) => s.close(r))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

describe("scanForwardPorts", () => {
  it("reads host=port pairs", () => {
    expect([...scanForwardPorts(`${NAME}=1024, b.example.invalid=65535`)]).toEqual([[NAME, 1024], ["b.example.invalid", 65535]]);
    expect(scanForwardPorts("").size).toBe(0);
  });

  it.each(["no-port", "a=80", "a=1023", "a=65536", "a=70000", "a=b", "a=1=2", "=1024"])("refuses %s", (entry) => {
    expect(() => scanForwardPorts(entry)).toThrow(/SCAN_FORWARD_PORTS/);
  });

  it("names a bad entry by its host, never by its port", () => {
    expect(() => scanForwardPorts(`${NAME}=99999`)).toThrow(`SCAN_FORWARD_PORTS has an entry for ${NAME} that is not host=port`);
    for (const entry of [`${NAME}=99999`, `${NAME}=1024=1025`, "=1024", `${NAME}:1025`]) {
      let message = "";
      try {
        scanForwardPorts(entry);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, entry).toMatch(/SCAN_FORWARD_PORTS/);
      expect(message, entry).not.toMatch(/99999|1024|1025/);
    }
  });
});

describe("scanDial", () => {
  it("is a plain fetch for a host with no forward", async () => {
    const stub = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", stub);
    await scanDial(`https://${NAME}/api/scan/v0/dso`, { method: "GET" });
    expect(stub).toHaveBeenCalledWith(`https://${NAME}/api/scan/v0/dso`, { method: "GET" });
  });

  it("sends the far end what a direct call would, with the real name in SNI and Host and no port", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${port}`;
    const res = await scanDial(`https://${NAME}/api/scan/v2/updates?x=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "cctools-network-record/0.1" },
      body: '{"page_size":1}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(seen[0]).toEqual({
      host: NAME,
      servername: NAME,
      method: "POST",
      url: "/api/scan/v2/updates?x=1",
      body: '{"page_size":1}',
      contentType: "application/json",
      acceptEncoding: "gzip",
      contentLength: "15",
      transferEncoding: undefined,
    });
  });

  it("sends a GET with no body framing", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${port}`;
    await scanDial(`https://${NAME}/api/scan/v0/dso`, { method: "GET" });
    expect(seen[0].transferEncoding).toBeUndefined();
    expect(seen[0].body).toBe("");
  });

  it("refuses a certificate for another name: TLS is end to end, not with the forward", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${otherPort}`;
    await expect(scanDial(`https://${NAME}/api/scan/v0/dso`, { method: "GET" })).rejects.toThrow(/altnames|Hostname|certificate/i);
    expect(seen).toHaveLength(0);
  });

  it("decodes a gzip answer", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${port}`;
    const res = await scanDial(`https://${NAME}/gzip`, { method: "GET" });
    expect(await res.json()).toEqual({ ok: 1 });
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("hands a throttle's status and Retry-After through", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${port}`;
    const res = await scanDial(`https://${NAME}/throttled`, { method: "GET" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    await res.body?.cancel();
  });

  it("reports our timeout as fetch does, a TimeoutError", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${port}`;
    await expect(scanDial(`https://${NAME}/slow`, { method: "GET", signal: AbortSignal.timeout(100) })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("rejects when nothing listens on the forward's port (the forward is down)", async () => {
    // A port nothing holds: one a listener just gave back.
    const s = serve(good);
    const p = await listen(s);
    await new Promise((r) => s.close(r));
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${p}`;
    const err = await scanDial(`https://${NAME}/api/scan/v0/dso`, { method: "GET" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ECONNREFUSED/);
    expect((err as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
    // The forward's local port never leaves: not in the message, the stack, a property or the inspected object.
    const all = `${(err as Error).message} ${(err as Error).stack} ${JSON.stringify(err)} ${inspect(err)}`;
    expect(all).not.toContain(String(p));
    expect(all).not.toContain("127.0.0.1");
    expect(err).not.toHaveProperty("port");
    expect(err).not.toHaveProperty("address");
  });
});

describe("scanDial limits (an opt-in byte cap)", () => {
  it("refuses an answer longer than maxBytes on the wire, and reads it whole without limits", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${port}`;
    await expect(scanDial(`https://${NAME}/big`, { method: "GET" }, { maxBytes: 1_000 })).rejects.toBeInstanceOf(ScanBodyTooLargeError);
    const res = await scanDial(`https://${NAME}/big`, { method: "GET" });
    expect((await res.json()).pad).toHaveLength(4_000);
    const roomy = await scanDial(`https://${NAME}/big`, { method: "GET" }, { maxBytes: 10_000 });
    expect(roomy.status).toBe(200);
  });

  it("refuses a small gzip answer that inflates past maxBytes", async () => {
    process.env.SCAN_FORWARD_PORTS = `${NAME}=${port}`;
    await expect(scanDial(`https://${NAME}/gzip-big`, { method: "GET" }, { maxBytes: 10_000 })).rejects.toBeInstanceOf(ScanBodyTooLargeError);
    const res = await scanDial(`https://${NAME}/gzip-big`, { method: "GET" });
    expect((await res.json()).pad).toHaveLength(100_000);
  });
});

describe("redactLocalAddress", () => {
  it("replaces an address and port, and leaves a message without one as it was", () => {
    expect(redactLocalAddress(`connect ECONNREFUSED 127.0.0.1:${port}`)).toBe("connect ECONNREFUSED the forward's local port");
    expect(redactLocalAddress("read ECONNRESET")).toBe("read ECONNRESET");
    expect(redactLocalAddress("Hostname/IP does not match certificate's altnames")).toBe("Hostname/IP does not match certificate's altnames");
  });
});
