import { CONNECTION_STRING, CONTEXT_REDACTIONS, CREDENTIAL_PATTERNS, SYNTHETIC_MARKER } from "./patterns.js";

const MIN_LITERAL = 4;

export interface RedactionResult {
  text: string;
  /** Number of replacements made. */
  count: number;
}

/**
 * Removes planted/declared secrets and credential-shaped values from text before it is stored, hashed or reported.
 * Literal secrets are matched verbatim plus their base64 and URL-encoded forms. Output is idempotent.
 */
export class Redactor {
  private readonly literals = new Set<string>();
  private readonly originals = new Set<string>();

  constructor(literals: readonly string[] = []) {
    for (const l of literals) this.addLiteral(l);
  }

  addLiteral(value: string): void {
    const v = value.trim();
    if (v.length < MIN_LITERAL) return;
    this.originals.add(v);
    this.literals.add(v);
    this.literals.add(Buffer.from(v, "utf8").toString("base64"));
    this.literals.add(Buffer.from(v, "utf8").toString("base64").replace(/=+$/, ""));
    this.literals.add(encodeURIComponent(v));
  }

  /** The literals as originally added (no derived encodings), for persisting alongside the run. */
  get declared(): string[] {
    return [...this.originals];
  }

  get literalCount(): number {
    return this.literals.size;
  }

  redact(input: string, opts: { truncated?: boolean } = {}): RedactionResult {
    let text = input;
    let count = 0;
    const sorted = [...this.literals].filter((l) => l.length >= MIN_LITERAL).sort((a, b) => b.length - a.length);
    for (const lit of sorted) {
      if (text.includes(lit)) {
        const parts = text.split(lit);
        count += parts.length - 1;
        text = parts.join("[REDACTED:declared-secret]");
      }
    }
    for (const p of CREDENTIAL_PATTERNS) {
      text = text.replace(new RegExp(p.re.source, p.re.flags), () => {
        count += 1;
        return `[REDACTED:${p.kind}]`;
      });
    }
    text = text.replace(new RegExp(CONNECTION_STRING.source, CONNECTION_STRING.flags), (full, user: string, pw: string, host: string) => {
      if (pw.startsWith("[REDACTED:")) return full;
      count += 1;
      const scheme = full.slice(0, full.indexOf("://") + 3);
      return `${scheme}${user}:[REDACTED:connection-string-password]@${host}`;
    });
    for (const p of CONTEXT_REDACTIONS) {
      text = text.replace(new RegExp(p.re.source, p.re.flags), (...args: unknown[]) => {
        const m = args.slice(0, -2) as string[];
        const full = m[0] as string;
        const secret = p.group ? (m[p.group] as string) : full;
        if (secret.startsWith("[REDACTED:")) return full;
        count += 1;
        if (!p.group) return `[REDACTED:${p.kind}]`;
        return full.slice(0, full.length - secret.length) + `[REDACTED:${p.kind}]`;
      });
    }
    if (opts.truncated) {
      const stripped = this.stripPartialTail(text);
      if (stripped !== text) {
        count += 1;
        text = stripped;
      }
    }
    return { text, count };
  }

  redactBytes(bytes: Uint8Array, opts: { truncated?: boolean } = {}): { bytes: Uint8Array; count: number } {
    const r = this.redact(Buffer.from(bytes).toString("utf8"), opts);
    return { bytes: Buffer.from(r.text, "utf8"), count: r.count };
  }

  /** A truncated stream may end in the first characters of a secret; drop any such partial tail. */
  private stripPartialTail(text: string): string {
    let cut = text.length;
    const candidates = [...this.literals, SYNTHETIC_MARKER];
    for (const lit of candidates) {
      const max = Math.min(lit.length - 1, text.length);
      for (let n = max; n >= 3; n--) {
        if (text.endsWith(lit.slice(0, n))) {
          cut = Math.min(cut, text.length - n);
          break;
        }
      }
    }
    return text.slice(0, cut);
  }
}

/** Convenience for one-off redaction with the built-in patterns only. */
export function redactText(text: string, literals: readonly string[] = []): RedactionResult {
  return new Redactor(literals).redact(text);
}

/**
 * Remove terminal escape sequences (CSI, OSC, other ESC pairs) and non-printing control characters (keeping newline, carriage
 * return and tab) so stored script output can be shown without repainting or hiding anything. Applied BEFORE redaction so a
 * secret split by escape codes cannot slip past the matcher.
 */
export function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
