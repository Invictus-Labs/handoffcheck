// Private-key redaction class guard (round-4 P1): once a `-----BEGIN ... PRIVATE KEY-----` header is seen, everything from the
// header to the matching END marker is removed, or, when no END marker follows (truncated stream, oversized block), everything
// from the header to the end of the text (fail closed, marked `unterminated`). The key body never depends on a regex span, so no
// body length bound and no scan-window edge can leave part of a key behind.
import { describe, expect, it } from "vitest";
import { MAX_MATCH_CHARS, SCAN_WINDOW_CHARS, findCredentials, privateKeySpans } from "../../src/security/patterns.js";
import { Redactor, redactText } from "../../src/security/redact.js";

// assembled at runtime so no credential-shaped literal sits in the source
const marker = (edge: "BEGIN" | "END", label = ""): string => ["-----", edge, " ", label, "PRIVATE", " KEY-----"].join("");
const BEGIN = marker("BEGIN", "RSA ");
const END = marker("END", "RSA ");
/** A body line that is easy to search for and is not a real key. */
const LINE = "bm90LWEtcmVhbC1rZXktYm9keS1saW5lLWZvci10ZXN0cw";
const body = (chars: number, tag = ""): string => {
  const line = `${LINE}${tag}\n`;
  return line.repeat(Math.ceil(chars / line.length));
};
const block = (chars: number, tag = ""): string => `${BEGIN}\n${body(chars, tag)}${END}`;
const FULL = "[REDACTED:private-key]";
const OPEN = "[REDACTED:private-key:unterminated]";

const filler = (n: number): string => {
  const unit = "lorem ipsum dolor sit amet, consectetur adipiscing elit\n";
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
};
const timed = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("private-key redaction: a key body never survives", () => {
  it("a normal full block is still removed whole, with the surrounding text intact", () => {
    const out = new Redactor([]).redact(`before\n${block(1600)}\nafter`);
    expect(out.text).toBe(`before\n${FULL}\nafter`);
    expect(out.count).toBe(1);
    for (const label of ["", "EC ", "OPENSSH ", "ENCRYPTED ", "DSA "]) {
      const b = `${marker("BEGIN", label)}\n${body(400)}${marker("END", label)}`;
      expect(redactText(`x ${b} y`).text, label).toBe(`x ${FULL} y`);
    }
    const pgp = ["-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"].join("");
    const pgpEnd = ["-----END PGP ", "PRIVATE KEY BLOCK-----"].join("");
    expect(redactText(`x ${pgp}\n${body(400)}${pgpEnd} y`).text).toBe(`x ${FULL} y`);
  });

  it("a truncated block (no END marker) is redacted from the header to the end of the text and marked", () => {
    const text = `log line\n${BEGIN}\n${body(1200)}`.slice(0, -7);
    const plain = new Redactor([]).redact(text);
    expect(plain.text).toBe(`log line\n${OPEN}`);
    expect(plain.text).not.toContain(LINE.slice(0, 12));
    // the same through the truncated-stream path the evidence writer uses
    const trunc = new Redactor(["declared-literal"]).redact(text, { truncated: true });
    expect(trunc.text).toBe(`log line\n${OPEN}`);
    // a stream cut in the middle of the END marker is still unterminated
    const cutEnd = `${BEGIN}\n${body(300)}${END.slice(0, 12)}`;
    expect(redactText(cutEnd).text).toBe(OPEN);
  });

  it("a block longer than the old 16 KiB body bound is removed whole", () => {
    const out = redactText(`a\n${block(40 * 1024)}\nb`).text;
    expect(out).toBe(`a\n${FULL}\nb`);
  });

  it("a block longer than the scan window (with and without an END marker) is removed whole", () => {
    const big = SCAN_WINDOW_CHARS * 2 + 4096;
    expect(redactText(`a\n${block(big)}\nb`).text).toBe(`a\n${FULL}\nb`);
    expect(redactText(`a\n${BEGIN}\n${body(big)}`).text).toBe(`a\n${OPEN}`);
  });

  it("a block that crosses any window or safe edge of the windowed scanner is removed whole", () => {
    const step = SCAN_WINDOW_CHARS - MAX_MATCH_CHARS;
    const edges = [...new Set([1, 2].flatMap((k) => [k * step, k * step + MAX_MATCH_CHARS, k * SCAN_WINDOW_CHARS, k * SCAN_WINDOW_CHARS - MAX_MATCH_CHARS]))];
    const pem = block(3000);
    for (const edge of edges) {
      // the header starts just before the edge, the body straddles it (absolute offsets in fixed filler, no cumulative drift)
      for (const before of [1, 30, 100, 2000]) {
        const at = edge - before;
        const text = `${filler(at)}${pem}\n${filler(3 * SCAN_WINDOW_CHARS - at)}`;
        expect(text.indexOf(BEGIN), `edge ${edge}-${before}`).toBe(at);
        const out = redactText(text).text;
        expect(out, `edge ${edge}-${before}`).not.toContain(LINE.slice(0, 12));
        expect(out.split(FULL).length - 1, `edge ${edge}-${before}`).toBe(1);
        expect(out.endsWith(filler(3 * SCAN_WINDOW_CHARS - at)), `edge ${edge}-${before}`).toBe(true);
      }
      // an oversized block (body longer than MAX_MATCH_CHARS) whose header sits right at the safe edge
      const at = edge - MAX_MATCH_CHARS - 10;
      if (at < 0) continue;
      const text = `${filler(at)}${block(MAX_MATCH_CHARS * 3)}\ntail`;
      expect(redactText(text).text, `oversized at ${at}`).toBe(`${filler(at)}${FULL}\ntail`);
    }
  });

  it("the reviewer's reproduction: a block starting at SCAN_WINDOW_CHARS-100 leaks nothing", () => {
    const at = SCAN_WINDOW_CHARS - 100;
    const text = `${filler(at)}${block(4000)}\nafter`;
    const out = redactText(text).text;
    expect(out).toBe(`${filler(at)}${FULL}\nafter`);
  });

  it("multiple keys: each block is removed and the text between them is kept", () => {
    const text = `one\n${block(1000, "A")}\nmiddle text\n${block(1000, "B")}\nthree\n${block(1000, "C")}\nend`;
    const out = new Redactor([]).redact(text);
    expect(out.text).toBe(`one\n${FULL}\nmiddle text\n${FULL}\nthree\n${FULL}\nend`);
    expect(out.count).toBe(3);
    expect(privateKeySpans(text).map((s) => s.terminated)).toEqual([true, true, true]);
  });

  it("a truncated key followed by a full key: everything from the first header to the second END marker is removed", () => {
    const text = `x\n${BEGIN}\n${body(500, "A")}${block(500, "B")}\ny`;
    const out = redactText(text).text;
    expect(out).toBe(`x\n${FULL}\ny`);
    // a full key followed by a truncated key
    const text2 = `x\n${block(500, "A")}\nmid\n${BEGIN}\n${body(500, "B")}`;
    expect(redactText(text2).text).toBe(`x\n${FULL}\nmid\n${OPEN}`);
  });

  it("an END marker before any header ends nothing, and stray END markers do not reopen redaction", () => {
    const text = `${END}\nplain\n${block(200)}\n${END}\ntrailing`;
    expect(redactText(text).text).toBe(`${END}\nplain\n${FULL}\n${END}\ntrailing`);
  });

  it("is idempotent and still reports the header as a credential", () => {
    const text = `a\n${block(800)}\nb\n${BEGIN}\n${body(800)}`;
    const once = redactText(text).text;
    expect(redactText(once).text).toBe(once);
    expect(redactText(once).count).toBe(0);
    expect(findCredentials(text).filter((m) => m.kind === "private-key").map((m) => m.index)).toEqual([2, text.lastIndexOf(BEGIN)]);
    expect(findCredentials(`${BEGIN}\n${body(100)}`).map((m) => m.kind)).toEqual(["private-key"]);
  });

  it("a declared literal inside the header cannot break it apart before the key is removed", () => {
    const out = new Redactor(["PRIVATE"]).redact(`a ${block(500)} b ${BEGIN}\n${body(300, "Z")}`).text;
    expect(out).not.toContain(LINE.slice(0, 12));
  });
});

describe("private-key redaction stays linear on adversarial input", () => {
  const BUDGET_MS = 2500;
  const MIB = 1024 * 1024;
  const runs: [string, string][] = [
    ["unterminated headers", `${BEGIN}\n`],
    ["headers without newline", BEGIN],
    ["header + END pairs", `${BEGIN}${END}`],
    ["END markers only", `${END}\n`],
    ["header prefixes", ["-----", "BEGIN A B C D E F G H "].join("")],
    ["END prefixes", ["-----", "END A B C D E F G H "].join("")],
    ["dashes", "-----"]
  ];
  for (const [name, unit] of runs) {
    it(`1 MiB of ${name} is redacted and scanned within budget`, () => {
      const text = unit.repeat(Math.ceil(MIB / unit.length));
      expect(timed(() => new Redactor(["declared-literal"]).redact(text, { truncated: true }))).toBeLessThan(BUDGET_MS);
      expect(timed(() => findCredentials(text))).toBeLessThan(BUDGET_MS);
      expect(timed(() => privateKeySpans(text))).toBeLessThan(BUDGET_MS);
    }, 120_000);
  }
});
