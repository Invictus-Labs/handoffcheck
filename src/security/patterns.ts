/**
 * Production-credential and network-destination patterns shared by preflight (reject) and the redactor (remove).
 * A match that contains the synthetic marker is a declared planted fake and is never a finding.
 */

export const SYNTHETIC_MARKER = "HCFAKE";

export interface CredentialPattern {
  kind: string;
  /** Global regex. For redaction the whole match is replaced unless `group` selects a capture. */
  re: RegExp;
  /** Capture group holding just the secret (redacted in place), if the match includes context. */
  group?: number;
}

/*
 * Regex-DoS safety (untrusted workload stdout/stderr, scripts and artifacts reach these patterns synchronously):
 *  1. every quantifier in every pattern below is bounded ({n,m}, never `*`, `+` or `{n,}`), so no single match attempt
 *     can scan more than a few KiB and no match is longer than MAX_MATCH_CHARS; tests enforce this structurally;
 *  2. token bodies whose character class contains their own start boundary use a lookbehind instead of `\b`, so a run
 *     like `eyJ-eyJ-...` offers one start position, not one per repeat;
 *  3. there are no adjacent optional whitespace runs (`\s*(?:x)?\s*`), whose ambiguous splits backtrack quadratically;
 *  4. scanning goes through {@link boundedMatchAll}, which runs each regex over windows of at most SCAN_WINDOW_CHARS.
 * Consequence: tokens longer than a pattern's bound are not matched (or only their bounded prefix is); the bounds sit well
 * above the real formats. Private keys are exempt from this: only their header and END marker are matched, and the body is
 * removed by offset ({@link privateKeySpans}), fail closed to the end of the text when no END marker follows.
 */
/** `-----BEGIN <label> PRIVATE KEY-----` (PEM, OpenSSH, PGP `... PRIVATE KEY BLOCK`). Detection matches the header alone. */
export const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]{1,32} ){0,8}PRIVATE KEY(?: BLOCK)?-----/g;
/** The matching END marker; only ever used to close a span opened by {@link PRIVATE_KEY_BEGIN}. */
export const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]{1,32} ){0,8}PRIVATE KEY(?: BLOCK)?-----/g;

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // header only: a key body is never matched by a regex (whose bound or window edge could cut it short). Redaction removes
  // whole spans from {@link privateKeySpans} instead.
  { kind: "private-key", re: PRIVATE_KEY_BEGIN },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g },
  { kind: "stripe-live-key", re: /\b[sr]k_live_[A-Za-z0-9]{16,255}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "llm-api-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,1024}\b/g },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // `-` is part of the segment class, so `\b` would allow a start after every `-` in `eyJ-eyJ-...`: use a lookbehind
  { kind: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,4096}/g }
];

/**
 * `scheme://user:password@host`: the password is a credential unless the host is loopback.
 * The scheme is bounded (at most 32 chars, i.e. its last 32 chars when longer) so a long `a.a.a...` run cannot make
 * every start position rescan the whole run (quadratic, event-loop freeze on untrusted output).
 */
export const CONNECTION_STRING = /[a-z][a-z0-9+.-]{0,31}:\/\/([^\s:@/]{1,256}):([^\s@/]{1,1024})@(\[[0-9a-fA-F:]{1,45}\]|[^\s/:?#'"]{1,255})/gi;

/** Context patterns redacted from logs and evidence (not preflight rejections: plain words appear in docs). */
export const CONTEXT_REDACTIONS: readonly CredentialPattern[] = [
  // one bounded whitespace run on each side of the optional scheme word: never two optional runs next to each other
  { kind: "authorization-header", re: /\b(authorization\s{0,64}:\s{0,64}(?:(?:bearer|basic|token)\s{1,64})?)([^\s'"]{1,8192})/gi, group: 2 },
  { kind: "secret-assignment", re: /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s{0,64}[=:]\s{0,64}['"]?)([^\s'"&,;]{3,4096})/gi, group: 2 },
  { kind: "planted-secret", re: /HCFAKE[A-Za-z0-9_-]{0,1024}/g }
];

/** Upper bound on the length of any match of any pattern in this module (all quantifiers are bounded). */
export const MAX_MATCH_CHARS = 32 * 1024;
/** Each regex execution sees at most this many characters of input, however long the scanned text is. */
export const SCAN_WINDOW_CHARS = 128 * 1024;
/** Characters of context kept before a window start, so `\b` and lookbehinds see the real preceding character. */
const SCAN_LEAD_CHARS = 256;

/**
 * Every match of `re` in `text`, exactly as `text.matchAll(re)` would report them (non-overlapping, left to right, absolute
 * `index`), but each regex execution only ever sees a window of at most SCAN_WINDOW_CHARS characters. Windows overlap by
 * MAX_MATCH_CHARS, and a match is taken from a window only when it starts early enough to end inside it, so no match is
 * cut short by a window edge (all patterns are bounded by MAX_MATCH_CHARS).
 */
export function boundedMatchAll(text: string, re: RegExp): RegExpExecArray[] {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out: RegExpExecArray[] = [];
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    const ws = Math.max(0, pos - SCAN_LEAD_CHARS);
    const we = Math.min(n, ws + SCAN_WINDOW_CHARS);
    const last = we === n;
    const safe = last ? n : we - MAX_MATCH_CHARS;
    const win = ws === 0 && last ? text : text.slice(ws, we);
    g.lastIndex = pos - ws;
    let next = safe;
    for (;;) {
      const m = g.exec(win);
      if (m === null) break;
      const abs = ws + m.index;
      if (abs >= safe) break;
      m.index = abs;
      out.push(m);
      if (m[0].length === 0) g.lastIndex += 1;
      next = Math.max(next, abs + m[0].length);
    }
    pos = next;
  }
  return out;
}

/** `text.replace(re, fn)` over {@link boundedMatchAll}: the same replacements, with every regex execution window-bounded. */
export function boundedReplace(text: string, re: RegExp, fn: (m: RegExpExecArray) => string): string {
  const matches = boundedMatchAll(text, re);
  if (matches.length === 0) return text;
  const parts: string[] = [];
  let at = 0;
  for (const m of matches) {
    parts.push(text.slice(at, m.index), fn(m));
    at = m.index + m[0].length;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

export interface PrivateKeySpan {
  start: number;
  /** Exclusive end: just past the END marker, or the end of the text when no END marker follows. */
  end: number;
  terminated: boolean;
}

/**
 * The spans of `text` that hold private keys, for redaction. Each span runs from a BEGIN header to the first END marker after
 * it; when no END marker follows (a truncated stream, or a block cut anywhere), it runs to the end of the text (fail closed).
 * A header inside an earlier span is part of that span. Only the bounded header and END patterns are regex-matched (through
 * {@link boundedMatchAll}); the body is located by absolute offsets, so its length and the scan-window edges cannot leave any
 * of it outside the span. Linear: one pass over the headers and the END markers.
 */
export function privateKeySpans(text: string): PrivateKeySpan[] {
  const begins = boundedMatchAll(text, PRIVATE_KEY_BEGIN);
  if (begins.length === 0) return [];
  const ends = boundedMatchAll(text, PRIVATE_KEY_END);
  const spans: PrivateKeySpan[] = [];
  let e = 0;
  let covered = 0;
  for (const b of begins) {
    const start = b.index as number;
    if (start < covered) continue;
    const bodyStart = start + b[0].length;
    while (e < ends.length && (ends[e]?.index as number) < bodyStart) e += 1;
    const end = ends[e];
    if (end === undefined) {
      spans.push({ start, end: text.length, terminated: false });
      break;
    }
    covered = (end.index as number) + end[0].length;
    spans.push({ start, end: covered, terminated: true });
    e += 1;
  }
  return spans;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export interface CredentialMatch {
  kind: string;
  index: number;
}

/** Scan text for production credential patterns. Matches containing the synthetic marker are skipped. */
export function findCredentials(text: string): CredentialMatch[] {
  const found: CredentialMatch[] = [];
  for (const p of CREDENTIAL_PATTERNS) {
    for (const m of boundedMatchAll(text, p.re)) {
      // the planted-fake marker excuses a token, but never a private key block (a marker inside a PEM body is not a declaration)
      if (p.kind !== "private-key" && m[0].includes(SYNTHETIC_MARKER)) continue;
      found.push({ kind: p.kind, index: m.index as number });
    }
  }
  for (const m of boundedMatchAll(text, CONNECTION_STRING)) {
    const password = m[2] as string;
    const host = m[3] as string;
    if (m[0].includes(SYNTHETIC_MARKER)) continue;
    if (isLoopbackHost(host)) continue;
    found.push({ kind: "connection-string-password", index: m.index as number });
  }
  return found;
}

export interface Destination {
  host: string;
  port: string | null;
  source: "url" | "tool" | "ipv4" | "socket";
}

const URL_RE = /[a-z][a-z0-9+.-]{0,31}:\/\/(?:[^\s/@'"]{1,256}@)?(\[[0-9a-fA-F:]{1,45}\]|[^\s/:?#'"`)<>]{1,255})(?::(\d{1,5}))?/gi;
/** The rest of the command line after a network tool (bounded: arguments past 4096 characters are not inspected). */
const TOOL_RE = /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|rsync|telnet|ftp|sftp|ping|dig|nslookup|host)\b([^\n;|&]{0,4096})/g;
/** DNS name (labels of at most 63, at most 127 labels), dotted IPv4 or localhost; only ever tested on short tokens. */
const HOSTLIKE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,126}[A-Za-z]{2,63}$|^(?:\d{1,3}\.){3}\d{1,3}$|^localhost$/;
const MAX_HOST_TOKEN = 512;
/** Common programmatic idioms (heuristic): /dev/tcp/HOST/PORT, python socket.create_connection/connect((HOST, PORT)), node net.connect. */
const DEV_TCP = /\/dev\/(?:tcp|udp)\/([A-Za-z0-9.:-]{1,255})\/(\d{1,5})/g;
const PY_SOCKET = /\b(?:create_connection|connect(?:_ex)?|sendto)\(\s{0,16}\(\s{0,16}["']([^"'\s]{1,255})["']\s{0,16},\s{0,16}(\d{1,5})/g;
const NODE_SOCKET = /\b(?:net|tls|http2)\.(?:connect|createConnection)\(\s{0,16}(?:\{[^}]{0,512}?host\s{0,16}:\s{0,16}["']([^"'\s]{1,255})["'][^}]{0,512}?\}|(\d{1,5})\s{0,16},\s{0,16}["']([^"'\s]{1,255})["'])/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Every regex this module applies to untrusted text, for the structural and adversarial-timing tests. */
export const SCAN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  ...CREDENTIAL_PATTERNS.map((p) => ({ name: `credential:${p.kind}`, re: p.re })),
  { name: "credential:private-key-end", re: PRIVATE_KEY_END },
  { name: "connection-string", re: CONNECTION_STRING },
  ...CONTEXT_REDACTIONS.map((p) => ({ name: `context:${p.kind}`, re: p.re })),
  { name: "destination:url", re: URL_RE },
  { name: "destination:tool", re: TOOL_RE },
  { name: "destination:hostlike", re: HOSTLIKE },
  { name: "destination:dev-tcp", re: DEV_TCP },
  { name: "destination:py-socket", re: PY_SOCKET },
  { name: "destination:node-socket", re: NODE_SOCKET },
  { name: "destination:ipv4", re: IPV4 }
];

/** Static detection of explicit network destinations in a manifest string or script body. */
export function findDestinations(text: string): Destination[] {
  const out: Destination[] = [];
  for (const m of boundedMatchAll(text, URL_RE)) {
    out.push({ host: (m[1] as string).toLowerCase(), port: m[2] ?? null, source: "url" });
  }
  for (const m of boundedMatchAll(text, TOOL_RE)) {
    for (const raw of (m[1] as string).split(/\s+/)) {
      if (!raw || raw.startsWith("-") || raw.length > MAX_HOST_TOKEN) continue;
      const token = raw.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "").replace(/['"`]/g, "");
      const [hostPart, portPart] = token.split(/[:/]/);
      if (hostPart && HOSTLIKE.test(hostPart)) {
        out.push({ host: hostPart.toLowerCase(), port: portPart && /^\d{1,5}$/.test(portPart) ? portPart : null, source: "tool" });
      }
    }
  }
  for (const m of boundedMatchAll(text, DEV_TCP)) out.push({ host: (m[1] as string).toLowerCase(), port: m[2] as string, source: "socket" });
  for (const m of boundedMatchAll(text, PY_SOCKET)) out.push({ host: (m[1] as string).toLowerCase(), port: m[2] as string, source: "socket" });
  for (const m of boundedMatchAll(text, NODE_SOCKET)) out.push({ host: ((m[1] ?? m[3]) as string).toLowerCase(), port: m[2] ?? null, source: "socket" });
  for (const m of boundedMatchAll(text, IPV4)) {
    const octets = m[0].split(".").map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) out.push({ host: m[0], port: null, source: "ipv4" });
  }
  return out;
}

/** `allow` entries: `host`, `host:port` or `*.suffix`. Loopback is always allowed. */
export function isDestinationAllowed(d: Destination, allow: readonly string[]): boolean {
  if (isLoopbackHost(d.host)) return true;
  for (const raw of allow) {
    const entry = raw.toLowerCase();
    if (entry.startsWith("*.")) {
      if (d.host.endsWith(entry.slice(1))) return true;
      continue;
    }
    const [h, p] = entry.split(":");
    if (h === d.host && (p === undefined || p === d.port)) return true;
  }
  return false;
}
