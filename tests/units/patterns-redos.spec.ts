// Regex-DoS class guard for src/security/patterns.ts: every pattern applied to untrusted text (workload stdout/stderr, scripts,
// artifacts) must stay linear on hostile input. Structural rules (bounded quantifiers only, no adjacent optional whitespace runs)
// plus a timing sweep of EVERY pattern against adversarial inputs at 256 KiB, and an equivalence check of the windowed scanner.
import { describe, expect, it } from "vitest";
import { MAX_MATCH_CHARS, SCAN_PATTERNS, SCAN_WINDOW_CHARS, boundedMatchAll, findCredentials, findDestinations } from "../../src/security/patterns.js";
import { Redactor } from "../../src/security/redact.js";

const SIZE = 256 * 1024;
// Generous against the linear patterns (each scan measures well under 50 ms); the quadratic ones this replaces took 4-40 s here.
const BUDGET_MS = 1500;

const globalOf = (re: RegExp): RegExp => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
const timed = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const fill = (unit: string, tail: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE) + tail;

/** Quantifiers that can repeat without limit: `*`, `+` and `{n,}` outside character classes. */
function unboundedQuantifiers(src: string): string[] {
  const out: string[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "*" || c === "+") out.push(`${c} at ${i}`);
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (m && m[2] !== undefined && m[3] === "") out.push(`${m[0]} at ${i}`);
    }
  }
  return out;
}

// Prefixes that make a backtracking pattern rescan: the token starts, separators and whitespace runs each pattern is built from.
const SPACES = " ".repeat(4096);
const UNITS = [
  "eyJ-",
  "eyJ",
  "eyJaaaaaaaa.",
  "a.",
  "a-",
  "a",
  "0",
  "1.",
  " ",
  "\t",
  "-",
  "a:",
  "a@",
  "x://",
  "a://a:",
  "authorization:",
  "authorization: ",
  `authorization:${SPACES}`,
  `authorization:${SPACES}bearer${SPACES}`,
  "authorization: bearer ",
  "password=",
  "password",
  `token:${SPACES}`,
  ["-----", "BEGIN "].join(""),
  ["-----", "BEGIN PRIVATE KEY-----"].join(""),
  ["-----", "BEGIN A "].join(""),
  ["-----", "END "].join(""),
  "sk-",
  "xoxb-",
  "ghp_",
  "github_pat_",
  "sk_live_",
  "AKIA",
  "AIza",
  "npm_",
  "HCFAKE",
  "curl ",
  "/dev/tcp/",
  "/dev/tcp/a",
  'connect(("',
  "net.connect({",
  "net.connect({host:",
  "a.b."
];
const TAILS = ["", "!"];

describe("regex-DoS class: structure of every pattern in src/security/patterns.ts", () => {
  it("the pattern registry is complete (credentials, connection string, context redactions, destinations)", () => {
    expect(SCAN_PATTERNS.length).toBeGreaterThanOrEqual(19);
    expect(SCAN_PATTERNS.map((p) => p.name)).toEqual(expect.arrayContaining(["credential:jwt", "context:authorization-header", "destination:tool", "destination:hostlike"]));
  });

  it("negative control: the quantifier checker flags unbounded quantifiers and accepts bounded ones", () => {
    expect(unboundedQuantifiers(String.raw`\beyJ[A-Za-z0-9_-]{8,}\.x`)).toHaveLength(1);
    expect(unboundedQuantifiers(String.raw`a\s*b+c`)).toHaveLength(2);
    expect(unboundedQuantifiers(String.raw`[*+]{1,4}\*\+x{2}`)).toEqual([]);
  });

  it("negative control: no pattern uses an unbounded quantifier (`*`, `+`, `{n,}`)", () => {
    for (const p of SCAN_PATTERNS) expect(unboundedQuantifiers(p.re.source), p.name).toEqual([]);
  });

  it("negative control: no pattern has two optional whitespace runs around an optional group", () => {
    const adjacent = /\\s\{0,\d+\}\(\?:[^()]*(?:\([^()]*\)[^()]*)*\)\?\\s\{0,/;
    expect(adjacent.test(String.raw`(authorization\s{0,64}:\s{0,64}(?:bearer|basic)?\s{0,64})`)).toBe(true);
    for (const p of SCAN_PATTERNS) expect(adjacent.test(p.re.source), p.name).toBe(false);
  });
});

describe("regex-DoS class: every pattern stays linear on 256 KiB of adversarial input", () => {
  it("negative control (P1): each pattern, run directly over the whole input and through the windowed scanner, finishes within budget", () => {
    const slow: string[] = [];
    for (const unit of UNITS) {
      for (const tail of TAILS) {
        const text = fill(unit, tail);
        for (const p of SCAN_PATTERNS) {
          const raw = timed(() => [...text.matchAll(globalOf(p.re))]);
          const windowed = timed(() => boundedMatchAll(text, p.re));
          if (raw > BUDGET_MS || windowed > BUDGET_MS) slow.push(`${p.name} on ${JSON.stringify(unit.slice(0, 24))}+${JSON.stringify(tail)}: ${raw.toFixed(0)}/${windowed.toFixed(0)} ms`);
        }
      }
    }
    expect(slow).toEqual([]);
  }, 300_000);

  it("negative control (P1): redaction, credential and destination scans finish within budget on every adversarial input", () => {
    const slow: string[] = [];
    const redactor = new Redactor(["declared-literal-value"]);
    for (const unit of UNITS) {
      for (const tail of TAILS) {
        const text = fill(unit, tail);
        const r = timed(() => redactor.redact(text, { truncated: true }));
        const c = timed(() => findCredentials(text));
        const d = timed(() => findDestinations(text));
        if (Math.max(r, c, d) > BUDGET_MS) slow.push(`${JSON.stringify(unit.slice(0, 24))}+${JSON.stringify(tail)}: ${r.toFixed(0)}/${c.toFixed(0)}/${d.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 300_000);

  it("negative control (P1): the reviewer's reproductions (1 MiB of `eyJ-`, `authorization:` + 1 MiB of spaces) stay within budget", () => {
    const jwtRun = "eyJ-".repeat(256 * 1024);
    const authRun = `authorization:${" ".repeat(1024 * 1024)}`;
    expect(timed(() => new Redactor([]).redact(jwtRun))).toBeLessThan(BUDGET_MS);
    expect(timed(() => findCredentials(jwtRun))).toBeLessThan(BUDGET_MS);
    expect(timed(() => new Redactor([]).redact(authRun))).toBeLessThan(BUDGET_MS);
  }, 120_000);
});

describe("windowed scanning is equivalent to a whole-input scan", () => {
  // tokens are assembled at runtime so no credential-shaped literal sits in the source
  const jwt = ["eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiJ0ZXN0In0", ".", "c2lnbmF0dXJlLXZhbHVl"].join("");
  const pem = ["-----BEGIN", " PRIVATE", " KEY-----\n", "bm90LWEtcmVhbC1rZXk=\n".repeat(400), "-----END", " PRIVATE", " KEY-----"].join("");
  const conn = ["postgres://", "admin:", "s3cretpass", "@db.example.org/app"].join("");
  const auth = ["Authorization: ", "Bearer ", "abcdefghijklmnop0123"].join("");

  // every window edge and every "safe" edge (window end minus MAX_MATCH_CHARS) the scanner uses, highest first
  const step = SCAN_WINDOW_CHARS - MAX_MATCH_CHARS;
  const EDGES = [...new Set([1, 2].flatMap((k) => [k * step, k * step + MAX_MATCH_CHARS, k * SCAN_WINDOW_CHARS, k * SCAN_WINDOW_CHARS - MAX_MATCH_CHARS]))].sort((a, b) => b - a);

  function planted(): string {
    const filler = "lorem ipsum dolor sit amet, consectetur adipiscing elit\n";
    let text = filler.repeat(Math.ceil((3 * SCAN_WINDOW_CHARS) / filler.length));
    // straddle each edge with every token
    for (const edge of EDGES) {
      for (const [i, tok] of [jwt, pem, conn, auth].entries()) {
        const at = Math.max(0, edge - Math.floor(tok.length / 2) - i * 7);
        text = `${text.slice(0, at)} ${tok} ${text.slice(at)}`;
      }
    }
    return text;
  }

  it("reports exactly the matches of `matchAll` for every pattern, including tokens across window edges", () => {
    const text = planted();
    expect(text.length).toBeGreaterThan(2 * SCAN_WINDOW_CHARS);
    for (const p of SCAN_PATTERNS) {
      const whole = [...text.matchAll(globalOf(p.re))].map((m) => [m.index, m[0]]);
      const windowed = boundedMatchAll(text, p.re).map((m) => [m.index, m[0]]);
      expect(windowed, p.name).toEqual(whole);
    }
  });

  it("redacts every planted secret across window edges, as a whole-input pass would", () => {
    const text = planted();
    const out = new Redactor([]).redact(text).text;
    for (const secret of ["s3cretpass", "abcdefghijklmnop0123", "c2lnbmF0dXJlLXZhbHVl", "bm90LWEtcmVhbC1rZXk="]) expect(out).not.toContain(secret);
    expect(EDGES.length).toBeGreaterThanOrEqual(5);
    expect(out.split("[REDACTED:private-key]").length - 1).toBe(EDGES.length);
    expect(out.split("[REDACTED:jwt]").length - 1).toBe(EDGES.length);
    expect(findCredentials(text).filter((m) => m.kind === "jwt").length).toBe(EDGES.length);
  });

  it("matches nothing on empty input and handles inputs exactly one window long", () => {
    for (const p of SCAN_PATTERNS) expect(boundedMatchAll("", p.re), p.name).toEqual([]);
    const one = `${" ".repeat(SCAN_WINDOW_CHARS - jwt.length - 1)} ${jwt}`;
    expect(one.length).toBe(SCAN_WINDOW_CHARS);
    expect(findCredentials(one).map((m) => m.kind)).toEqual(["jwt"]);
  });
});
