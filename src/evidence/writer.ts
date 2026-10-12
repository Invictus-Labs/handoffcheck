import { canonicalBytes, sha256Hex } from "../domain/canonical.js";
import { SCHEMA_VERSION } from "../domain/types.js";
import type { Clock, EvidenceKind, IdGenerator } from "../domain/types.js";
import { stripTerminalControl } from "../security/redact.js";
import type { Redactor } from "../security/redact.js";
import type { Store } from "../store/store.js";

/** Replace every string in a JSON-like value with its redacted form. Returns the new value and the replacement count. */
export function redactDeep<T>(value: T, redactor: Redactor): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactor.redact(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        const rk = redactor.redact(k);
        count += rk.count;
        out[rk.text] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}

export interface StoredEvidence {
  sha256: string;
  size_bytes: number;
  redaction_count: number;
}

/**
 * Appends evidence for one run: every byte passes through the redactor, is stored content-addressed, and gets an
 * append-only `evidence` row. Hashes are over the stored (redacted) bytes.
 */
export class EvidenceWriter {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly drillId: string,
    private readonly redactor: Redactor
  ) {}

  private record(kind: EvidenceKind, stepKey: string | null, bytes: Uint8Array, mediaType: string, redactionCount: number): StoredEvidence {
    const { sha256 } = this.store.objects.put(bytes);
    this.store.insertEvidence({
      schema_version: SCHEMA_VERSION,
      id: this.ids.uuid(),
      drill_id: this.drillId,
      step_key: stepKey,
      kind,
      sha256,
      media_type: mediaType,
      size_bytes: bytes.length,
      redacted: true,
      redaction_count: redactionCount,
      created_at: this.clock.nowIso()
    });
    return { sha256, size_bytes: bytes.length, redaction_count: redactionCount };
  }

  putJson(kind: EvidenceKind, stepKey: string | null, doc: unknown): StoredEvidence {
    const { value, count } = redactDeep(doc, this.redactor);
    return this.record(kind, stepKey, canonicalBytes(value), "application/json", count);
  }

  putText(kind: EvidenceKind, stepKey: string | null, raw: Uint8Array, truncated = false): StoredEvidence {
    const clean = stripTerminalControl(Buffer.from(raw).toString("utf8"));
    const { text, count } = this.redactor.redact(clean, { truncated });
    return this.record(kind, stepKey, Buffer.from(text, "utf8"), "text/plain", count);
  }
}

export function hashOf(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
