import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { esc } from "./escape.js";
import type { ReportView } from "./model.js";

export interface RenderOptions {
  /** Applied to every free-text value before escaping (defence in depth on top of store redaction). */
  redact?: (text: string) => string;
}

type Tone = "pass" | "fail" | "warn" | "unknown";

/** Known status/state/verdict words and how they are styled. Anything else renders as UNKNOWN (raw text shown). */
const TONES: Record<string, Tone> = {
  PASS: "pass",
  INDEPENDENT_PASS: "pass",
  CLEANUP_VERIFIED: "pass",
  VERIFIED: "pass",
  REMOVED: "pass",
  OK: "pass",
  FAIL: "fail",
  TIMEOUT: "fail",
  ERROR: "fail",
  ABORTED: "fail",
  FAILED: "fail",
  REJECTED: "fail",
  REJECT: "fail",
  LEAKED: "fail",
  UNCONFIRMED: "fail",
  CLEANUP_UNCONFIRMED: "fail",
  MISSING: "fail",
  MISMATCH: "fail",
  ASSISTED: "warn",
  REHEARSAL: "warn",
  BLOCKED: "warn",
  SKIPPED: "warn",
  WARN: "warn",
  NOT_CHECKED: "warn",
  PENDING_HUMAN_RECEIPT: "warn",
  HARNESS_RECORDED: "unknown",
  CREATED: "warn",
  PREFLIGHT: "warn",
  RUNNING: "warn",
  COMPLETE: "unknown",
  MATCH: "unknown",
  UNKNOWN: "unknown"
};

const BANNER_TEXT: Record<string, string> = {
  INDEPENDENT_PASS:
    "Every mandatory step succeeded with no intervention, the operator was a human who is not the builder, isolation was a VM, and cleanup is verified. The harness records this as a local attribution; a human receipt is still required for the drill itself.",
  ASSISTED:
    "Help was recorded during the drill or the operator was AI-assisted. This is a labelled rehearsal result, not a handoff result.",
  REHEARSAL:
    "Steps and cleanup succeeded, but this is a rehearsal, not an independent handoff result: the operator was automated, was not shown to differ from the builder, isolation was not a VM, or an optional step failed (flagged, never an independent pass).",
  FAIL: "At least one mandatory step or the cleanup check did not succeed. See the reasons and steps below.",
  BLOCKED: "A required capability (for example the VM runner) is unavailable. Nothing was faked; the drill did not run.",
  UNKNOWN: "The outcome is partial, stale or could not be determined. Unknown is never treated as success."
};

let cachedTemplate: string | undefined;

/** Locate templates/report.html from both src/ (tests) and dist/src/ (packaged CLI). */
export function templatePath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "templates", "report.html");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("report template templates/report.html not found");
}

function loadTemplate(): string {
  cachedTemplate ??= readFileSync(templatePath(), "utf8");
  return cachedTemplate;
}

function toneOf(status: string): Tone {
  return TONES[status.toUpperCase()] ?? "unknown";
}

type Cell = unknown;

export function renderHtml(view: ReportView, options: RenderOptions = {}): string {
  const redact = options.redact ?? ((s: string) => s);
  const t = (value: Cell): string => esc(redact(value === null || value === undefined ? "" : String(value)));
  const absent = '<span class="muted">not recorded</span>';
  const dash = (value: Cell): string => (value === null || value === undefined || value === "" ? absent : t(value));
  const mono = (value: Cell): string => (value === null || value === undefined || value === "" ? absent : `<code>${t(value)}</code>`);

  const badge = (status: Cell): string => {
    const raw = status === null || status === undefined ? "" : String(status);
    const known = raw !== "" && raw.toUpperCase() in TONES;
    const label = known ? raw.toUpperCase() : raw === "" ? "UNKNOWN" : `UNKNOWN (${raw})`;
    return `<span class="badge ${toneOf(raw)}">${t(label)}</span>`;
  };

  const table = (caption: string, heads: string[], rows: string[], emptyText: string): string =>
    `<table><caption>${t(caption)}</caption><thead><tr>${heads.map((h) => `<th scope="col">${t(h)}</th>`).join("")}</tr></thead><tbody>\n${
      rows.length > 0 ? rows.join("\n") : `<tr><td class="empty" colspan="${heads.length}">${t(emptyText)}</td></tr>`
    }\n</tbody></table>`;
  const list = (items: string[], empty: string): string =>
    items.length > 0 ? `<ul class="notes">${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p class="muted">${t(empty)}</p>`;

  const d = view.data;

  // Banner: the verdict, or an explicit error / unknown state.
  let banner: string;
  if (view.error) {
    banner = `<div class="banner fail" role="alert"><p class="label">${badge("ERROR")} Report unavailable</p><p>The run could not be reported. No result is implied.</p></div>`;
  } else if (!d) {
    banner = `<div class="banner unknown" role="status"><p class="label">${badge("UNKNOWN")} No run loaded</p><p>${t(BANNER_TEXT.UNKNOWN)}</p></div>`;
  } else {
    const verdict = String(d.verdict.verdict);
    const text = BANNER_TEXT[verdict.toUpperCase()] ?? BANNER_TEXT.UNKNOWN ?? "";
    const receipt =
      d.verdict.human_receipt === "PENDING_HUMAN_RECEIPT"
        ? `<p>${badge("PENDING_HUMAN_RECEIPT")} A human drill receipt is still required; this harness result alone does not satisfy it.</p>`
        : "";
    const claimed = d.claimed_verdict
      ? `<p>This run was imported from a bundle. The bundle claims ${badge(d.claimed_verdict.verdict)}; that claim is unauthenticated and shown for display only. The verdict above is the effective one.</p>`
      : "";
    banner = `<div class="banner ${toneOf(verdict)}" role="status"><p class="label">Verdict: ${badge(verdict)} <span class="muted">exit code ${t(d.verdict.exit_code)}</span></p><p>${t(text)}</p>${claimed}${receipt}</div>`;
  }

  const error = view.error
    ? `<section aria-labelledby="h-error"><h2 id="h-error">Error</h2><dl class="kv"><dt>code</dt><dd><code>${t(view.error.code)}</code></dd><dt>message</dt><dd>${t(view.error.message)}</dd><dt>request_id</dt><dd>${mono(view.error.request_id)}</dd></dl></section>`
    : "";

  let summary: string;
  if (!d) {
    summary = '<p class="muted">No run data. This report is empty.</p>';
  } else {
    const r = d.run;
    const isolation =
      r.isolation === "none"
        ? ' <span class="badge warn">isolation: none</span> <span class="muted">synthetic local sandbox; cannot satisfy a VM-isolation criterion</span>'
        : r.isolation === "vm"
          ? ' <span class="badge pass">isolation: vm</span>'
          : ` <span class="badge unknown">isolation: ${t(r.isolation)}</span>`;
    const labels = (r.labels ?? []).map((l) => ` <span class="badge warn">${t(l)}</span>`).join("");
    const kind =
      d.operator.kind === "human"
        ? '<span class="badge pass">human</span>'
        : d.operator.kind === "ai_assisted" || d.operator.kind === "automated"
          ? `<span class="badge warn">${t(d.operator.kind)}</span>`
          : `<span class="badge unknown">${t(d.operator.kind)}</span>`;
    summary = `<dl class="kv">
<dt>run id</dt><dd>${mono(r.id)}</dd>
<dt>scenario</dt><dd>${t(r.scenario.id)} <code>${t(r.scenario.version)}</code></dd>
<dt>state</dt><dd>${badge(r.state)}</dd>
<dt>outcome</dt><dd>${r.outcome ? badge(r.outcome) : '<span class="muted">none yet</span>'}</dd>
<dt>operator</dt><dd>${kind} ${dash(d.operator.ref)}${d.operator.builder_ref ? ` <span class="muted">(builder: ${t(d.operator.builder_ref)})</span>` : ""} <span class="muted">operator-attested by the local identity, not third-party attestation</span></dd>
<dt>provider</dt><dd>${dash(r.provider)}${isolation}${labels}</dd>
<dt>artifact sha256</dt><dd>${mono(d.binding.artifact_digest)}</dd>
<dt>runbook sha256</dt><dd>${mono(d.binding.runbook_hash)}</dd>
<dt>manifest digest</dt><dd>${mono(d.binding.manifest_digest)}</dd>
<dt>binding digest</dt><dd>${mono(d.binding.binding_digest)} ${badge(d.verdict.binding_check)}</dd>
<dt>imported bundle</dt><dd>${r.imported ? "yes (read-only copy from a bundle)" : "no"}</dd>
${d.claimed_verdict ? `<dt>claimed by bundle</dt><dd>${badge(d.claimed_verdict.verdict)} <span class="muted">unauthenticated, display only; never an acceptance</span></dd>` : ""}
<dt>fault injected</dt><dd>${r.fault_injected ? "yes (seeded failure)" : "no"}</dd>
<dt>created</dt><dd>${dash(r.created_at)}</dd>
<dt>started</dt><dd>${dash(r.started_at)}</dd>
<dt>finished</dt><dd>${dash(r.finished_at)}</dd>
<dt>report generated</dt><dd>${dash(d.generated_at)}</dd>
</dl>`;
  }

  const reasons = table(
    "Machine reason codes behind the verdict.",
    ["code", "message"],
    (d?.verdict.reasons ?? []).map((x) => `<tr><td><code>${t(x.code)}</code></td><td>${t(x.message)}</td></tr>`),
    d ? "No reasons recorded." : "No run loaded."
  );

  let preflight: string;
  if (!d) preflight = '<p class="muted">No run loaded.</p>';
  else if (!d.preflight) preflight = `<p>${badge("UNKNOWN")} Preflight was not recorded for this run.</p>`;
  else {
    const p = d.preflight;
    preflight =
      `<dl class="kv"><dt>status</dt><dd>${badge(p.status)}</dd><dt>checked</dt><dd>manifest ${p.checked.manifest ? "yes" : "no"}, runbook ${p.checked.runbook ? "yes" : "no"}, ${t(p.checked.scripts)} script(s), ${t(p.checked.artifact_entries)} artifact entr${p.checked.artifact_entries === 1 ? "y" : "ies"}</dd></dl>` +
      `<div class="scroll" tabindex="0" role="region" aria-label="Preflight findings table">${table(
        "Findings never contain the matched secret.",
        ["severity", "code", "location", "message"],
        p.findings.map((f) => `<tr><td>${badge(f.severity)}</td><td><code>${t(f.code)}</code></td><td>${mono(f.location)}</td><td>${t(f.message)}</td></tr>`),
        "No findings."
      )}</div>`;
  }

  const steps = table(
    "Every mandatory step must succeed. Missing, skipped, unknown or timed-out steps never count as success.",
    ["step", "action", "mandatory", "status", "reason", "deadline (s)", "duration (ms)", "evidence sha256"],
    (d?.steps ?? []).map(
      (s) =>
        `<tr><td>${mono(s.step_key)}</td><td>${t(s.action)}</td><td>${s.mandatory ? "yes" : "no"}</td><td>${badge(s.status)}</td><td><code>${t(s.reason_code)}</code></td><td>${dash(s.deadline_seconds)}</td><td>${dash(s.duration_ms)}</td><td>${mono(s.evidence_hash)}</td></tr>`
    ),
    d ? "No steps recorded. The drill did not reach any step, so there is no result." : "No run loaded."
  );

  const checks = table(
    "Individual checks from each step receipt (already redacted).",
    ["step", "check", "status", "expected", "actual", "detail"],
    (d?.steps ?? []).flatMap((s) =>
      (s.checks ?? []).map(
        (c) =>
          `<tr><td>${mono(s.step_key)}</td><td>${t(c.name)}</td><td>${badge(c.status)}</td><td>${dash(c.expected)}</td><td>${dash(c.actual)}</td><td>${dash(c.detail)}</td></tr>`
      )
    ),
    "No step checks recorded."
  );

  const interventions = table(
    "Every builder intervention is recorded. Any entry stops the run counting as an unaided handoff.",
    ["id", "actor", "reason", "step", "occurred (UTC)"],
    (d?.interventions ?? []).map(
      (i) => `<tr><td>${mono(i.id)}</td><td>${t(i.actor_ref)}</td><td>${t(i.reason)}</td><td>${mono(i.step_key)}</td><td>${dash(i.occurred_at)}</td></tr>`
    ),
    d ? "No interventions recorded." : "No run loaded."
  );

  const evidence = table(
    "Append-only evidence, content-addressed by sha256.",
    ["id", "kind", "step", "sha256", "media type", "size (bytes)", "redacted"],
    (d?.evidence ?? []).map(
      (e) =>
        `<tr><td>${mono(e.id)}</td><td>${t(e.kind)}</td><td>${mono(e.step_key)}</td><td>${mono(e.sha256)}</td><td>${t(e.media_type)}</td><td>${dash(e.size_bytes)}</td><td>${e.redacted ? "yes" : "no"}</td></tr>`
    ),
    d ? "No evidence recorded." : "No run loaded."
  );

  let cleanup: string;
  if (!d) cleanup = '<p class="muted">No run loaded.</p>';
  else {
    const c = d.cleanup;
    const missing = c.status === "MISSING";
    cleanup =
      `<dl class="kv"><dt>status</dt><dd>${badge(c.status)}</dd><dt>verified at</dt><dd>${dash(c.verified_at)}</dd></dl>` +
      (missing ? "<p>Cleanup was not verified. A run without verified cleanup never counts as success.</p>" : "") +
      (c.note ? `<p>${t(c.note)}</p>` : "") +
      `<div class="scroll" tabindex="0" role="region" aria-label="Cleanup resources table">${table(
        "Resources the run created and whether each is confirmed gone.",
        ["kind", "id", "state", "detail"],
        c.resources.map((x) => `<tr><td>${t(x.kind)}</td><td>${mono(x.id)}</td><td>${badge(x.state)}</td><td>${dash(x.detail)}</td></tr>`),
        missing ? "No cleanup receipt." : "No resources recorded."
      )}</div>`;
  }

  const history = table(
    "State transitions, oldest first.",
    ["seq", "from", "to", "reason", "at (UTC)"],
    (d?.state_history ?? []).map(
      (h) => `<tr><td>${t(h.seq)}</td><td>${h.from_state ? badge(h.from_state) : '<span class="muted">start</span>'}</td><td>${badge(h.to_state)}</td><td>${dash(h.reason)}</td><td>${dash(h.at)}</td></tr>`
    ),
    d ? "No state history recorded." : "No run loaded."
  );

  const notices = list(view.notices.map((n) => t(n)), "No notices.");

  const heading = d ? `Handoff drill ${d.run.id}` : "Handoff drill report";
  const values: Record<string, string> = {
    title: t(heading),
    heading: t(heading),
    generated_at: t(view.generated_at),
    tool_version: t(view.tool_version),
    banner,
    error,
    summary,
    reasons,
    preflight,
    steps,
    checks,
    interventions,
    evidence,
    cleanup,
    history,
    notices
  };
  // Single pass over the template only: substituted values are never rescanned for placeholders.
  return loadTemplate().replace(/\{\{([a-z_]+)\}\}/g, (_m, key: string) => values[key] ?? "");
}
