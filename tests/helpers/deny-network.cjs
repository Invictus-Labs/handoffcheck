// Preload (node --require) that makes any outbound network attempt in the CLI process fail loudly and be logged.
// Used by the outbound-denied demo test. Loopback is denied too: the deterministic core needs no sockets at all.
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

const log = process.env.HC_DENY_LOG;
const record = (what) => {
  if (log) fs.appendFileSync(log, `${what}\n`);
};
const deny = (what) => {
  record(what);
  throw new Error(`outbound network denied by test harness: ${what}`);
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  deny(`net.connect ${JSON.stringify(args[0])}`);
  return origConnect.apply(this, args);
};
for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  if (typeof dns[fn] === "function") dns[fn] = (host) => deny(`dns.${fn} ${host}`);
  if (dns.promises && typeof dns.promises[fn] === "function") dns.promises[fn] = async (host) => deny(`dns.promises.${fn} ${host}`);
}
globalThis.fetch = async (input) => deny(`fetch ${String(input)}`);
for (const mod of ["http", "https", "http2", "dgram", "tls"]) {
  const m = require(`node:${mod}`);
  for (const k of ["request", "get", "connect", "createSocket"]) {
    if (typeof m[k] === "function") m[k] = () => deny(`${mod}.${k}`);
  }
}
