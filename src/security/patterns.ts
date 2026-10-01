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

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)?/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe-live-key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "llm-api-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }
];

/** `scheme://user:password@host`: the password is a credential unless the host is loopback. */
export const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+):([^\s@/]+)@(\[[0-9a-fA-F:]+\]|[^\s/:?#'"]+)/gi;

/** Context patterns redacted from logs and evidence (not preflight rejections: plain words appear in docs). */
export const CONTEXT_REDACTIONS: readonly CredentialPattern[] = [
  { kind: "authorization-header", re: /\b(authorization\s*:\s*(?:bearer|basic|token)?\s*)([^\s'"]+)/gi, group: 2 },
  { kind: "secret-assignment", re: /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*['"]?)([^\s'"&,;]{3,})/gi, group: 2 },
  { kind: "planted-secret", re: /HCFAKE[A-Za-z0-9_-]*/g }
];

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
    for (const m of text.matchAll(new RegExp(p.re.source, p.re.flags))) {
      // the planted-fake marker excuses a token, but never a private key block (a marker inside a PEM body is not a declaration)
      if (p.kind !== "private-key" && m[0].includes(SYNTHETIC_MARKER)) continue;
      found.push({ kind: p.kind, index: m.index as number });
    }
  }
  for (const m of text.matchAll(new RegExp(CONNECTION_STRING.source, CONNECTION_STRING.flags))) {
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

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]+@)?(\[[0-9a-fA-F:]+\]|[^\s/:?#'"`)<>]+)(?::(\d{1,5}))?/gi;
const TOOL_RE = /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|rsync|telnet|ftp|sftp|ping|dig|nslookup|host)\b([^\n;|&]*)/g;
const HOSTLIKE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$|^localhost$/;
/** Common programmatic idioms (heuristic): /dev/tcp/HOST/PORT, python socket.create_connection/connect((HOST, PORT)), node net.connect. */
const DEV_TCP = /\/dev\/(?:tcp|udp)\/([A-Za-z0-9.:-]+)\/(\d{1,5})/g;
const PY_SOCKET = /\b(?:create_connection|connect(?:_ex)?|sendto)\(\s*\(\s*["']([^"'\s]+)["']\s*,\s*(\d{1,5})/g;
const NODE_SOCKET = /\b(?:net|tls|http2)\.(?:connect|createConnection)\(\s*(?:\{[^}]*?host\s*:\s*["']([^"'\s]+)["'][^}]*?\}|(\d{1,5})\s*,\s*["']([^"'\s]+)["'])/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Static detection of explicit network destinations in a manifest string or script body. */
export function findDestinations(text: string): Destination[] {
  const out: Destination[] = [];
  for (const m of text.matchAll(URL_RE)) {
    out.push({ host: (m[1] as string).toLowerCase(), port: m[2] ?? null, source: "url" });
  }
  for (const m of text.matchAll(TOOL_RE)) {
    for (const raw of (m[1] as string).split(/\s+/)) {
      if (!raw || raw.startsWith("-")) continue;
      const token = raw.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "").replace(/['"`]/g, "");
      const [hostPart, portPart] = token.split(/[:/]/);
      if (hostPart && HOSTLIKE.test(hostPart)) {
        out.push({ host: hostPart.toLowerCase(), port: portPart && /^\d{1,5}$/.test(portPart) ? portPart : null, source: "tool" });
      }
    }
  }
  for (const m of text.matchAll(DEV_TCP)) out.push({ host: (m[1] as string).toLowerCase(), port: m[2] as string, source: "socket" });
  for (const m of text.matchAll(PY_SOCKET)) out.push({ host: (m[1] as string).toLowerCase(), port: m[2] as string, source: "socket" });
  for (const m of text.matchAll(NODE_SOCKET)) out.push({ host: ((m[1] ?? m[3]) as string).toLowerCase(), port: m[2] ?? null, source: "socket" });
  for (const m of text.matchAll(IPV4)) {
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
