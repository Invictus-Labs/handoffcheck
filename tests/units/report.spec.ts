// Unit tests for the static report renderers (src/report): escaping, states, determinism.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERDICTS } from "../../src/api.js";
import { emptyView, esc, renderHtml, renderJson, templatePath, type ReportView } from "../../src/report/index.js";
import { sampleReport } from "../helpers/reportData.js";

const view = (data: ReturnType<typeof sampleReport> | null, extra: Partial<ReportView> = {}): ReportView => ({
  generated_at: "2026-01-01T00:00:00.000Z",
  tool_version: "9.9.9",
  error: null,
  data,
  notices: [],
  ...extra
});

const EVIL = '<script>alert(1)</script><img src=x onerror="alert(1)">\'`&';

describe("escape", () => {
  it("escapes HTML metacharacters and renders control characters visibly", () => {
    expect(esc(EVIL)).toBe("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&#96;&amp;");
    expect(esc("a\u0000b\u001bc\u007fd‮e f")).toBe("a\\u0000b\\u001bc\\u007fd\\u202ee\\u2028f");
    expect(esc("tab\tnew\nline")).toBe("tab\tnew\nline");
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(42)).toBe("42");
  });
});

describe("html report", () => {
  it("renders a banner for every verdict and never styles an unknown or blocked state as a pass", () => {
    for (const verdict of VERDICTS) {
      const html = renderHtml(view(sampleReport({}, verdict)));
      expect(html, verdict).toContain(verdict);
      if (verdict !== "INDEPENDENT_PASS" && verdict !== "REHEARSAL") expect(html).not.toMatch(/class="banner pass"/);
    }
    expect(renderHtml(view(sampleReport({}, "INDEPENDENT_PASS")))).toMatch(/human receipt is still required/i);
  });

  it("shows isolation none conspicuously and the pending human receipt", () => {
    const html = renderHtml(view(sampleReport()));
    expect(html).toContain("isolation=none");
    expect(html).toContain("PENDING_HUMAN_RECEIPT");
  });

  it("negative control: hostile text in every free-text field is escaped, and nothing executable survives", () => {
    const data = sampleReport();
    data.run.scenario.id = EVIL;
    data.run.labels = [EVIL];
    data.operator = { kind: "human", ref: EVIL, builder_ref: EVIL };
    data.verdict.reasons = [{ code: "ISOLATION_NONE", message: EVIL }];
    data.steps[0]!.checks = [{ name: EVIL, status: "FAIL", expected: EVIL, actual: EVIL, detail: EVIL }];
    data.steps[0]!.step_key = EVIL;
    data.interventions = [{ id: "i1", actor_ref: EVIL, reason: EVIL, occurred_at: EVIL, step_key: EVIL }];
    data.cleanup.note = EVIL;
    data.cleanup.resources = [{ kind: "directory", id: EVIL, state: "leaked", detail: EVIL }];
    data.evidence[0]!.media_type = EVIL;
    data.preflight!.findings = [{ code: "PRODUCTION_CREDENTIAL", severity: "reject", location: EVIL, message: EVIL }];
    const html = renderHtml(view(data, { notices: [EVIL] }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows explicit empty states instead of blank tables", () => {
    const data = sampleReport({ steps: [], interventions: [], evidence: [], state_history: [], preflight: null });
    data.verdict.reasons = [];
    const html = renderHtml(view(data));
    for (const text of ["No steps recorded", "No interventions recorded", "No evidence recorded", "No state history recorded", "No reasons recorded", "Preflight was not recorded"]) {
      expect(html, text).toContain(text);
    }
  });

  it("renders an explicit missing-cleanup state and an unrecognised status as UNKNOWN with the raw text", () => {
    const data = sampleReport({ cleanup: { status: "MISSING", verified_at: null, resources: [], note: null } });
    (data.steps[0] as { status: string }).status = "WEIRD<b>";
    const html = renderHtml(view(data));
    expect(html).toContain("No cleanup receipt");
    expect(html).toContain("UNKNOWN (WEIRD&lt;b&gt;)");
    expect(html).not.toContain("WEIRD<b>");
  });

  it("renders the empty and error views without implying a result", () => {
    const empty = renderHtml(emptyView("2026-01-01T00:00:00.000Z", "9.9.9"));
    expect(empty).toContain("No run loaded");
    expect(empty).not.toMatch(/banner pass/);
    const error = renderHtml(view(null, { error: { code: "NOT_FOUND", message: EVIL, request_id: "req_x" } }));
    expect(error).toContain("Report unavailable");
    expect(error).toContain("NOT_FOUND");
    expect(error).not.toContain("<script");
    expect(renderHtml(view(null, { error: { code: "X", message: "m" } }))).toContain("not recorded");
  });

  it("substitutes placeholders in a single pass: values containing {{placeholders}} are not re-expanded", () => {
    const data = sampleReport();
    data.run.scenario.id = "{{summary}}{{banner}}";
    const html = renderHtml(view(data));
    expect(html).toContain("{{summary}}{{banner}}");
  });

  it("applies the optional redact hook before escaping", () => {
    const data = sampleReport();
    data.operator.ref = "HCFAKE_OLD_TOKEN_123";
    const html = renderHtml(view(data), { redact: (s) => s.replace(/HCFAKE\w+/g, "[REDACTED]") });
    expect(html).not.toContain("HCFAKE_OLD_TOKEN_123");
    expect(html).toContain("[REDACTED]");
  });

  it("ships a template with a restrictive Content-Security-Policy and no script or external resource", () => {
    const template = readFileSync(templatePath(), "utf8");
    expect(template).toMatch(/Content-Security-Policy/);
    expect(template).toMatch(/default-src 'none'/);
    expect(template).not.toMatch(/<script/i);
    expect(template).not.toMatch(/(src|href)\s*=\s*["']https?:/i);
  });
});

describe("json report", () => {
  it("is deterministic with sorted keys and applies the redact hook to every string", () => {
    const data = sampleReport();
    data.operator.ref = "HCFAKE_X_1";
    const a = renderJson(view(data), { redact: (s) => s.replace(/HCFAKE\w+/g, "[R]") });
    const b = renderJson(view({ ...data }), { redact: (s) => s.replace(/HCFAKE\w+/g, "[R]") });
    expect(a).toBe(b);
    expect(a).not.toContain("HCFAKE");
    const keys = Object.keys(JSON.parse(a) as object);
    expect(keys).toEqual([...keys].sort());
    expect(a.endsWith("\n")).toBe(true);
  });

  it("emits the error body shape for an error or an empty view, never a fake result", () => {
    expect(JSON.parse(renderJson(view(null, { error: { code: "NOT_FOUND", message: "m", request_id: "r" } })))).toEqual({ error: { code: "NOT_FOUND", message: "m", request_id: "r" } });
    expect(JSON.parse(renderJson(view(null, { error: { code: "X", message: "m" } }))).error.request_id).toBeNull();
    expect(JSON.parse(renderJson(emptyView("2026-01-01T00:00:00.000Z", "1"))).error.code).toBe("not_found");
  });
});

describe("html report: every state and flag renders explicitly", () => {
  it("renders failed, aborted, imported, fault-injected and unconfirmed-cleanup runs as red states, never as success", () => {
    const data = sampleReport({}, "FAIL");
    data.run.state = "CLEANUP_UNCONFIRMED";
    data.run.outcome = "ABORTED";
    data.run.imported = true;
    data.run.fault_injected = true;
    data.run.started_at = null;
    data.run.finished_at = null;
    data.run.labels = ["imported from an evidence bundle", "fault injected for a negative control", "isolation=none"];
    data.cleanup = {
      status: "UNCONFIRMED",
      verified_at: null,
      note: "a resource could not be verified",
      resources: [
        { kind: "directory", id: "d1", state: "leaked", detail: "still present" },
        { kind: "process", id: "p1", state: "unknown" },
        { kind: "vm-instance", id: "v1", state: "removed" }
      ]
    };
    data.steps = [
      { ...sampleReport().steps[0]!, status: "TIMEOUT", reason_code: "SCRIPT_TIMEOUT", started_at: null, finished_at: null, duration_ms: null, evidence_hash: null, checks: [], mandatory: false, intervention_ids: ["i1"] },
      { ...sampleReport().steps[0]!, step_key: "restore", action: "restore", status: "SKIPPED", reason_code: "MANDATORY_STEP_NOT_RUN" }
    ];
    data.interventions = [{ id: "i1", actor_ref: "builder-b", reason: "helped", occurred_at: "2026-01-01T00:00:05.000Z", step_key: null }];
    data.evidence = [{ id: "e1", kind: "step_log", step_key: null, sha256: "b".repeat(64), media_type: "text/plain", size_bytes: 0, redacted: false }];
    data.preflight = {
      schema_version: 1,
      status: "REJECTED",
      provider: "lima",
      isolation: "vm",
      findings: [
        { code: "PRODUCTION_CREDENTIAL", severity: "reject", location: "manifest/env/KEY", message: "production credential pattern found", kind: "aws-access-key" },
        { code: "MISSING_RESOURCE_LIMITS", severity: "warn", location: "/runner/resources", message: "no limits" }
      ],
      checked: { manifest: true, scripts: 0, artifact_entries: 0, runbook: false }
    };
    data.verdict.reasons = [
      { code: "CLEANUP_UNCONFIRMED", message: "cleanup is not verified" },
      { code: "RUN_ABORTED", message: "aborted" }
    ];
    data.verdict.binding_check = "MISMATCH";
    const html = renderHtml(view(data));
    for (const text of ["LEAKED", "UNCONFIRMED", "TIMEOUT", "SKIPPED", "REJECTED", "imported from an evidence bundle", "fault injected", "PRODUCTION_CREDENTIAL", "MISMATCH", "builder-b", "a resource could not be verified"]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toMatch(/class="banner pass"/);
    expect(html).toMatch(/class="badge fail">LEAKED/);
  });

  it("renders operator, binding and digest fields even when optional values are absent", () => {
    const data = sampleReport();
    data.operator = { kind: "human", ref: "operator-a" };
    data.run.outcome = null;
    data.run.provider = "lima";
    data.run.isolation = "vm";
    data.run.labels = [];
    const html = renderHtml(view(data));
    expect(html).toContain("operator-a");
    expect(html).toContain("not recorded");
    expect(html).not.toContain("isolation=none");
  });
});
