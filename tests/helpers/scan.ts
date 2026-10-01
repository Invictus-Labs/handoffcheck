import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** All files under a directory (recursive), as absolute paths. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}

/** Files (relative to dir) whose raw bytes contain any needle. Used for "secret never appears anywhere" checks. */
export function filesContaining(dir: string, needles: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of walkFiles(dir)) {
    const bytes = readFileSync(file);
    if (needles.some((n) => bytes.includes(n))) hits.push(file.slice(dir.length + 1));
  }
  return hits;
}

/** Capture network attempts in-process (net sockets, DNS, fetch). The deterministic core must make none. */
export async function withNetworkDenied<T>(fn: () => Promise<T>): Promise<{ value: T; attempts: string[] }> {
  const net = (await import("node:net")).default;
  const dns = (await import("node:dns")).default;
  const attempts: string[] = [];
  const origConnect = net.Socket.prototype.connect;
  const origLookup = dns.lookup;
  const origFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: unknown, ...args: unknown[]) {
    attempts.push(`net.connect ${JSON.stringify(args[0])}`);
    throw new Error("network denied by test");
  } as typeof net.Socket.prototype.connect;
  dns.lookup = ((host: string) => {
    attempts.push(`dns.lookup ${host}`);
    throw new Error("network denied by test");
  }) as unknown as typeof dns.lookup;
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(`fetch ${String(input)}`);
    throw new Error("network denied by test");
  }) as typeof fetch;
  try {
    return { value: await fn(), attempts };
  } finally {
    net.Socket.prototype.connect = origConnect;
    dns.lookup = origLookup;
    globalThis.fetch = origFetch;
  }
}
