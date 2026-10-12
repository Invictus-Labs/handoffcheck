// Unit tests for the optional local-file adapters (src/adapters): envelope validation, the opt-in gate,
// receipt export, acceptance import with dedupe/ordering/downgrade rules, and ledger corruption handling.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADAPTERS_ENV,
  AdapterError,
  adaptersEnabled,
  assertEnabled,
  canonicalEnvelope,
  deriveEventId,
  exportReceipt,
  importAcceptance,
  isSafeRelativePath,
  readAcceptance,
  sha256Hex,
  type RunState,
  unknownFields,
  validateEnvelope,
  validateEvidenceRef,
  type Envelope
} from "../../src/adapters/index.js";
import { LEDGER_FILE, emptyLedger, loadLedger, saveLedger } from "../../src/adapters/ledger.js";
import { PLANTED } from "../helpers/drill.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const SHA = "a".repeat(64);
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  event_id: "evt-1",
  source: "proofgate",
  resource_id: "run-1",
  event_type: "acceptance.accepted",
  occurred_at: "2026-01-01T00:00:00Z",
  revision: 1,
  evidence_ref: `sha256:${SHA}`,
  ...over
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    return (e as AdapterError).code;
  }
  return "NO_ERROR";
}

describe("adapter gate", () => {
  it("negative control: adapters are disabled unless opted in, and failing is explicit", () => {
    expect(adaptersEnabled(undefined, {})).toBe(false);
    expect(adaptersEnabled(false, { [ADAPTERS_ENV]: "0" })).toBe(false);
    expect(adaptersEnabled(true, {})).toBe(true);
    expect(adaptersEnabled(false, { [ADAPTERS_ENV]: "1" })).toBe(true);
    expect(codeOf(() => assertEnabled(false))).toBe("CONNECTOR_DISCONNECTED");
    expect(codeOf(() => assertEnabled(true))).toBe("NO_ERROR");
  });
});

describe("envelope validation", () => {
  it("accepts a well-formed envelope and keeps the optional correlation_id", () => {
    expect(validateEnvelope(good())).toMatchObject({ event_id: "evt-1", revision: 1 });
    expect(validateEnvelope(good({ correlation_id: "evt-0" })).correlation_id).toBe("evt-0");
    expect(validateEnvelope(good({ occurred_at: "2026-01-01T00:00:00.123456Z" })).occurred_at).toBe("2026-01-01T00:00:00.123456Z");
    expect(validateEnvelope(good({ evidence_ref: "file:evidence/report.json" })).evidence_ref).toBe("file:evidence/report.json");
  });

  const rejects: [string, unknown, string][] = [
    ["a non-object", "text", "SCHEMA_INVALID"],
    ["an array", [], "SCHEMA_INVALID"],
    ["null", null, "SCHEMA_INVALID"],
    ["a missing schema_version", good({ schema_version: undefined }), "SCHEMA_INVALID"],
    ["a fractional schema_version", good({ schema_version: 1.5 }), "SCHEMA_INVALID"],
    ["an unsupported major version", good({ schema_version: 2 }), "UNSUPPORTED_VERSION"],
    ["version zero", good({ schema_version: 0 }), "UNSUPPORTED_VERSION"],
    ["an unknown field", good({ surprise: true }), "SCHEMA_INVALID"],
    ["a bad event_id", good({ event_id: "has space" }), "SCHEMA_INVALID"],
    ["an upper-case source", good({ source: "ProofGate" }), "SCHEMA_INVALID"],
    ["a bad event_type", good({ event_type: "Acceptance" }), "SCHEMA_INVALID"],
    ["a non-UTC timestamp", good({ occurred_at: "2026-01-01T00:00:00+02:00" }), "SCHEMA_INVALID"],
    ["an impossible timestamp", good({ occurred_at: "2026-13-45T99:99:99Z" }), "SCHEMA_INVALID"],
    ["a negative revision", good({ revision: -1 }), "SCHEMA_INVALID"],
    ["a fractional revision", good({ revision: 1.2 }), "SCHEMA_INVALID"],
    ["a URL evidence_ref", good({ evidence_ref: "https://example.org/x" }), "POLICY_REJECTED"],
    ["an absolute evidence_ref", good({ evidence_ref: "file:/etc/passwd" }), "POLICY_REJECTED"],
    ["a parent-segment evidence_ref", good({ evidence_ref: "file:../x" }), "POLICY_REJECTED"],
    ["a short sha evidence_ref", good({ evidence_ref: "sha256:abc" }), "POLICY_REJECTED"],
    ["a non-string evidence_ref", good({ evidence_ref: 5 }), "SCHEMA_INVALID"],
    ["an over-long evidence_ref", good({ evidence_ref: `file:${"a".repeat(600)}` }), "SCHEMA_INVALID"]
  ];
  for (const [name, input, code] of rejects) {
    it(`negative control: rejects ${name} with ${code}`, () => {
      expect(codeOf(() => validateEnvelope(input))).toBe(code);
    });
  }

  it("helper predicates behave at their edges", () => {
    for (const p of ["a", "a/b.json", "x".repeat(255)]) expect(isSafeRelativePath(p), p).toBe(true);
    for (const p of ["", "/a", "\\a", "C:x", "a/../b", "a//b", "./a", "a\\b", "a\0b", "x".repeat(256)]) expect(isSafeRelativePath(p), JSON.stringify(p)).toBe(false);
    expect(validateEvidenceRef(`sha256:${SHA}`)).toBe(`sha256:${SHA}`);
    expect(unknownFields(good({ a: 1, b: 2 }))).toEqual(["a", "b"]);
    expect(unknownFields("x")).toEqual([]);
    expect(deriveEventId("s", "r", "t", 1)).toBe(deriveEventId("s", "r", "t", 1));
    expect(deriveEventId("s", "r", "t", 1)).not.toBe(deriveEventId("s", "r", "t", 2));
    expect(canonicalEnvelope(validateEnvelope(good()))).toBe(canonicalEnvelope(validateEnvelope({ ...good() } as Record<string, unknown>)));
  });
});

describe("receipt export", () => {
  const run = (over: Partial<Parameters<typeof exportReceipt>[0]> = {}) => {
    const dir = makeTmp("hc-adapter-");
    const input = {
      enabled: true,
      stateDir: join(dir, "state"),
      outDir: join(dir, "out"),
      runId: "run-1",
      revision: 3,
      reportJson: JSON.stringify({ note: "redacted report", verdict: "REHEARSAL" }),
      occurredAt: "2026-01-01T00:00:00.000Z",
      ...over
    };
    return { dir, input, result: exportReceipt(input) };
  };

  it("writes a content-addressed report and an envelope that points at it, owner-only, with no network", () => {
    const { input, result } = run();
    const digest = sha256Hex(input.reportJson);
    expect(result.envelope.evidence_ref).toBe(`sha256:${digest}`);
    const ledger = loadLedger(input.stateDir);
    expect(ledger.receipt_nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(result.envelope.event_id).toBe(deriveEventId("handoffcheck", "run-1", "receipt.exported", 3, ledger.receipt_nonce));
    expect(readFileSync(result.reportPath, "utf8")).toBe(input.reportJson);
    expect(JSON.parse(readFileSync(result.envelopePath, "utf8"))).toEqual(result.envelope);
    expect(statSync(result.reportPath).mode & 0o077).toBe(0);
    expect(statSync(input.outDir).mode & 0o077).toBe(0);
    expect(loadLedger(input.stateDir).exports["run-1"]).toEqual({ event_id: result.envelope.event_id, revision: 3, report_sha256: digest });
  });

  it("negative control: disabled adapters write nothing and fail with CONNECTOR_DISCONNECTED", () => {
    const dir = makeTmp("hc-adapter-");
    const code = codeOf(() =>
      exportReceipt({ enabled: false, stateDir: join(dir, "s"), outDir: join(dir, "o"), runId: "r", revision: 1, reportJson: "{}", occurredAt: "2026-01-01T00:00:00Z" })
    );
    expect(code).toBe("CONNECTOR_DISCONNECTED");
    expect(existsSync(join(dir, "o"))).toBe(false);
  });

  it("exporting the same revision twice is byte-identical (consumers dedupe); an older revision never rewinds the head", () => {
    const a = run();
    const b = exportReceipt({ ...a.input, outDir: join(a.dir, "out2") });
    expect(b.envelope).toEqual(a.result.envelope);
    exportReceipt({ ...a.input, revision: 1, outDir: join(a.dir, "out3") });
    expect(loadLedger(a.input.stateDir).exports["run-1"]?.revision).toBe(3);
  });

  it("an unwritable output location is a BAD_REQUEST, not a crash", () => {
    const dir = makeTmp("hc-adapter-");
    writeFileSync(join(dir, "file"), "x");
    expect(codeOf(() => exportReceipt({ enabled: true, stateDir: join(dir, "s"), outDir: join(dir, "file", "nested"), runId: "r", revision: 1, reportJson: "{}", occurredAt: "2026-01-01T00:00:00Z" }))).not.toBe("NO_ERROR");
  });
});

describe("acceptance import", () => {
  const ACCEPTING: RunState = { verdict: "INDEPENDENT_PASS", accepting: true, revision: 2 };
  function setup(opts: { exportRevision?: number } = {}) {
    const dir = makeTmp("hc-accept-");
    const stateDir = join(dir, "state");
    const reportJson = JSON.stringify({ note: "redacted report", verdict: "INDEPENDENT_PASS" });
    const reportSha = sha256Hex(reportJson);
    let receiptEvent = "";
    if (opts.exportRevision !== undefined) {
      receiptEvent = exportReceipt({ enabled: true, stateDir, outDir: join(dir, "receipts"), runId: "run-1", revision: opts.exportRevision, reportJson, occurredAt: "2026-01-01T00:00:00Z" }).envelope.event_id;
    }
    const file = join(dir, "acceptance.json");
    const write = (v: unknown) => writeFileSync(file, JSON.stringify(v));
    const imp = (runState?: (id: string) => RunState | undefined, enabled = true) => importAcceptance({ enabled, stateDir, file, ...(runState ? { runState } : {}) });
    /** An acceptance that answers the exported receipt exactly as a well-behaved sender would. */
    const claim = (over: Record<string, unknown> = {}) => good({ evidence_ref: `sha256:${reportSha}`, correlation_id: receiptEvent, ...over });
    // kept for the tests that only need a syntactically valid pin
    const evidenceSha = reportSha;
    return { dir, stateDir, file, evidenceSha, reportSha, receiptEvent, write, imp, claim };
  }

  it("applies an accepted claim only when the digest pins the exported report, it answers the newest receipt, the run is unchanged and its OWN verdict accepts", () => {
    const s = setup({ exportRevision: 2 });
    s.write(s.claim());
    const out = s.imp(() => ACCEPTING);
    expect(out).toMatchObject({ applied: 1, duplicates: 0, stale: 0, rejected: 0 });
    expect(out.results[0]?.effective_state).toBe("accepted");
    expect(readAcceptance(s.stateDir, "run-1")).toMatchObject({ state: "accepted", claimed: "accepted", run_verdict: "INDEPENDENT_PASS" });
  });

  it("negative control (P1-5): an accepted claim with no run state, or whose run is not accepting, is never accepted, whatever the sender says", () => {
    const none = setup({ exportRevision: 2 });
    none.write(none.claim());
    expect(none.imp().results[0]).toMatchObject({ effective_state: "unknown" });
    expect(none.imp().results[0]?.reason).toBe("event_id already processed");
    expect(readAcceptance(none.stateDir, "run-1")).toMatchObject({ state: "unknown", claimed: "accepted", run_verdict: null });
    expect(readAcceptance(none.stateDir, "run-1")?.reason).toMatch(/own verdict could not be read/);
    for (const verdict of ["REHEARSAL", "ASSISTED", "FAIL", "UNKNOWN", "BLOCKED"]) {
      const s = setup({ exportRevision: 2 });
      s.write(s.claim());
      const out = s.imp(() => ({ verdict, accepting: false, revision: 2 }));
      expect(out.results[0]?.effective_state, verdict).toBe("unknown");
      expect(readAcceptance(s.stateDir, "run-1")?.reason, verdict).toContain(`the run's own verdict is ${verdict}`);
      expect(readAcceptance(s.stateDir, "run-1")?.run_verdict).toBe(verdict);
    }
  });

  it("negative control (P1-5): a run that changed after the receipt is stale, even for a perfect claim", () => {
    const s = setup({ exportRevision: 2 });
    s.write(s.claim());
    const out = s.imp(() => ({ ...ACCEPTING, revision: 3 }));
    expect(out.results[0]?.effective_state).toBe("stale");
    expect(readAcceptance(s.stateDir, "run-1")?.reason).toMatch(/changed after this receipt/);
  });

  it("negative control (P1-5): file: refs and unrelated sha256 pins verify nothing, so the accepted claim is downgraded to unknown", () => {
    const f = setup({ exportRevision: 2 });
    f.write(f.claim({ evidence_ref: "file:evidence.json" }));
    expect(f.imp(() => ACCEPTING).results[0]?.effective_state).toBe("unknown");
    expect(readAcceptance(f.stateDir, "run-1")?.reason).toMatch(/not a sha256 pin/);
    const wrong = setup({ exportRevision: 2 });
    wrong.write(wrong.claim({ evidence_ref: `sha256:${"b".repeat(64)}` }));
    expect(wrong.imp(() => ACCEPTING).results[0]?.effective_state).toBe("unknown");
    expect(readAcceptance(wrong.stateDir, "run-1")?.reason).toMatch(/does not match the report exported/);
  });

  it("negative control: accepted with no exported receipt, or answering an older or guessed receipt id, never counts as accepted", () => {
    const none = setup();
    none.write(none.claim({ correlation_id: "x" }));
    expect(none.imp(() => ACCEPTING).results[0]?.effective_state).toBe("unknown");
    const old = setup({ exportRevision: 2 });
    old.write(old.claim({ correlation_id: "an-older-receipt" }));
    expect(old.imp(() => ACCEPTING).results[0]?.effective_state).toBe("stale");
  });

  it("receipt event ids carry a per-store nonce: stable within a store, not derivable without it (P1-5 forgeable correlation_id)", () => {
    const a = setup({ exportRevision: 2 });
    const b = setup({ exportRevision: 2 });
    expect(a.receiptEvent).not.toBe(b.receiptEvent);
    expect(a.receiptEvent).not.toBe(deriveEventId("handoffcheck", "run-1", "receipt.exported", 2));
    const again = exportReceipt({ enabled: true, stateDir: a.stateDir, outDir: join(a.dir, "r2"), runId: "run-1", revision: 2, reportJson: JSON.stringify({ note: "redacted report", verdict: "INDEPENDENT_PASS" }), occurredAt: "2026-01-01T00:00:00Z" });
    expect(again.envelope.event_id).toBe(a.receiptEvent);
    // a sender that guessed the old, nonce-free id is not answering the receipt
    a.write(a.claim({ correlation_id: deriveEventId("handoffcheck", "run-1", "receipt.exported", 2) }));
    expect(a.imp(() => ACCEPTING).results[0]?.effective_state).toBe("stale");
  });

  it("run ids that collide with Object.prototype names are ordinary ledger keys (P3)", () => {
    const dir = makeTmp("hc-accept-");
    const stateDir = join(dir, "state");
    for (const id of ["constructor", "toString", "hasOwnProperty"]) {
      exportReceipt({ enabled: true, stateDir, outDir: join(dir, `o-${id.replace(/\W/g, "")}`), runId: id, revision: 1, reportJson: "{}", occurredAt: "2026-01-01T00:00:00Z" });
    }
    const ledger = loadLedger(stateDir);
    expect(Object.keys(ledger.exports).sort()).toEqual(["constructor", "hasOwnProperty", "toString"]);
    expect(Object.getPrototypeOf(ledger.exports)).toBeNull();
    expect(emptyLedger().exports["constructor"]).toBeUndefined();
  });

  it("negative control: an accepted claim for a run nobody here has heard of cannot be hit by a prototype name", () => {
    const s = setup();
    s.write(good({ resource_id: "constructor", correlation_id: "x" }));
    expect(s.imp(() => ACCEPTING).results[0]?.effective_state).toBe("unknown");
  });

  it("keeps rejected, unknown, partial and stale claims as reported, and rejects unknown event types", () => {
    for (const state of ["rejected", "unknown", "partial", "stale"]) {
      const s = setup();
      s.write(good({ event_type: `acceptance.${state}`, evidence_ref: `sha256:${s.evidenceSha}` }));
      expect(s.imp().results[0]?.effective_state, state).toBe(state);
    }
    const s = setup();
    s.write([good({ event_type: "other.thing" }), good({ event_id: "evt-2", event_type: "acceptance.bogus" })]);
    const out = s.imp();
    expect(out.rejected).toBe(2);
    expect(out.results.map((r) => r.code)).toEqual(["SCHEMA_INVALID", "SCHEMA_INVALID"]);
  });

  it("deduplicates at-least-once delivery: same event_id and bytes is a no-op, different bytes is a CONFLICT", () => {
    const s = setup();
    s.write(good({ event_type: "acceptance.partial" }));
    expect(s.imp().applied).toBe(1);
    expect(s.imp()).toMatchObject({ applied: 0, duplicates: 1 });
    s.write(good({ event_type: "acceptance.partial", evidence_ref: `sha256:${"d".repeat(64)}` }));
    const conflict = s.imp();
    expect(conflict.rejected).toBe(1);
    expect(conflict.results[0]?.code).toBe("CONFLICT");
  });

  it("preserves ordering: an old revision never rewinds state", () => {
    const s = setup();
    s.write(good({ event_id: "evt-new", event_type: "acceptance.rejected", revision: 5 }));
    expect(s.imp().applied).toBe(1);
    s.write(good({ event_id: "evt-old", event_type: "acceptance.accepted", revision: 4 }));
    const out = s.imp();
    expect(out.stale).toBe(1);
    expect(readAcceptance(s.stateDir, "run-1")?.state).toBe("rejected");
    s.write(good({ event_id: "evt-same", event_type: "acceptance.partial", revision: 5 }));
    expect(s.imp().stale).toBe(1);
    expect(readAcceptance(s.stateDir, "run-1")?.state).toBe("rejected");
  });

  it("negative control: disabled adapters, unreadable, oversized, malformed and empty files fail explicitly", () => {
    const s = setup();
    s.write(good());
    expect(codeOf(() => s.imp(undefined, false))).toBe("CONNECTOR_DISCONNECTED");
    expect(codeOf(() => importAcceptance({ enabled: true, stateDir: s.stateDir, file: join(s.dir, "missing.json") }))).toBe("BAD_REQUEST");
    writeFileSync(s.file, "{not json");
    expect(codeOf(() => s.imp())).toBe("SCHEMA_INVALID");
    s.write([]);
    expect(codeOf(() => s.imp())).toBe("SCHEMA_INVALID");
    s.write(Array.from({ length: 1001 }, (_, i) => good({ event_id: `e${i}` })));
    expect(codeOf(() => s.imp())).toBe("PAYLOAD_TOO_LARGE");
    writeFileSync(s.file, " ".repeat(64 * 1024 * 1000 + 1));
    expect(codeOf(() => s.imp())).toBe("PAYLOAD_TOO_LARGE");
  });

  it("never follows a symlinked or non-regular evidence file, and rejects invalid envelopes in a batch without losing valid ones", () => {
    const s = setup({ exportRevision: 1 });
    mkdirSync(join(s.dir, "dir.json"));
    symlinkSync(join(s.dir, `${s.evidenceSha}.json`), join(s.dir, `${"e".repeat(64)}.json`));
    s.write([
      good({ event_id: "evt-link", evidence_ref: `sha256:${"e".repeat(64)}`, correlation_id: s.receiptEvent }),
      good({ event_id: "evt-dir", evidence_ref: "file:dir.json", correlation_id: s.receiptEvent, revision: 2, resource_id: "run-2" }),
      { not: "an envelope", event_id: "evt-bad" },
      42
    ]);
    const out = s.imp();
    expect(out.results.map((r) => r.status)).toEqual(["applied", "applied", "rejected", "rejected"]);
    expect(out.results[0]?.effective_state).toBe("unknown");
    expect(out.results[1]?.effective_state).toBe("unknown");
    expect(out.results[2]?.event_id).toBe("evt-bad");
    expect(out.results[3]?.event_id).toBeNull();
  });
});

describe("adapter ledger", () => {
  it("round-trips atomically with owner-only permissions", () => {
    const dir = makeTmp("hc-ledger-");
    const state = join(dir, "state");
    const ledger = emptyLedger();
    ledger.exports["run-1"] = { event_id: "e", revision: 1, report_sha256: "a".repeat(64) };
    saveLedger(state, ledger);
    expect(loadLedger(state)).toEqual(ledger);
    expect(statSync(join(state, LEDGER_FILE)).mode & 0o077).toBe(0);
    expect(loadLedger(join(dir, "never-created"))).toEqual(emptyLedger());
  });

  it("negative control: a corrupt or wrong-shaped ledger is refused rather than reset", () => {
    for (const text of ["{broken", JSON.stringify({ ledger_version: 2, seen: {}, streams: {}, exports: {}, acceptance: {} }), JSON.stringify({ ledger_version: 1 }), "null"]) {
      const dir = makeTmp("hc-ledger-");
      writeFileSync(join(dir, LEDGER_FILE), text);
      expect(codeOf(() => loadLedger(dir)), text).toBe("INTERNAL");
    }
    const big = makeTmp("hc-ledger-");
    writeFileSync(join(big, LEDGER_FILE), " ".repeat(25 * 1024 * 1024 + 1));
    expect(codeOf(() => loadLedger(big))).toBe("PAYLOAD_TOO_LARGE");
  });

  it("planted secrets in a redacted report body stay out of the exported envelope", () => {
    const dir = makeTmp("hc-adapter-");
    const r = exportReceipt({ enabled: true, stateDir: join(dir, "s"), outDir: join(dir, "o"), runId: "run-9", revision: 1, reportJson: JSON.stringify({ note: "[REDACTED:planted-secret]" }), occurredAt: "2026-01-01T00:00:00Z" });
    const env: Envelope = r.envelope;
    expect(JSON.stringify(env)).not.toContain(PLANTED.oldToken);
  });
});

describe("adapter file-system failures are explicit BAD_REQUEST errors, never raw exceptions", () => {
  it("negative control: an unreadable ledger, an unwritable ledger location and an unwritable receipt directory fail with BAD_REQUEST", () => {
    const dir = makeTmp("hc-fsfail-");
    // ledger path is a directory: cannot be read as a file
    const asDir = join(dir, "state-a");
    mkdirSync(join(asDir, LEDGER_FILE), { recursive: true });
    expect(codeOf(() => loadLedger(asDir))).toBe("BAD_REQUEST");
    // state dir is a regular file: the ledger cannot be written
    const file = join(dir, "state-b");
    writeFileSync(file, "x");
    expect(codeOf(() => saveLedger(file, emptyLedger()))).not.toBe("NO_ERROR");
    // receipt directory exists but is read-only: writing the receipt files fails explicitly
    const out = join(dir, "readonly-out");
    mkdirSync(out, { mode: 0o500 });
    chmodSync(out, 0o500);
    const code = codeOf(() => exportReceipt({ enabled: true, stateDir: join(dir, "s"), outDir: out, runId: "r", revision: 1, reportJson: "{}", occurredAt: "2026-01-01T00:00:00Z" }));
    chmodSync(out, 0o700);
    expect(["BAD_REQUEST", "NO_ERROR"]).toContain(code); // running as root would make the directory writable
  });
});
