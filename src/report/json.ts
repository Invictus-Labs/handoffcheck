import type { RenderOptions } from "./html.js";
import type { ReportView } from "./model.js";

/** Deterministic key order, with the redactor applied to every string, so equal data gives equal bytes. */
function normalise(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => normalise(v, redact));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalise((value as Record<string, unknown>)[key], redact);
    }
    return out;
  }
  return value;
}

/**
 * JSON report. On success this is exactly the library's ReportData (so it validates against the
 * shipped report schema). When the run could not be reported it is the standard error body.
 */
export function renderJson(view: ReportView, options: RenderOptions = {}): string {
  const redact = options.redact ?? ((s: string) => s);
  const body = view.error
    ? { error: { code: view.error.code, message: view.error.message, request_id: view.error.request_id ?? null } }
    : (view.data ?? { error: { code: "not_found", message: "no run data", request_id: null } });
  return `${JSON.stringify(normalise(body, redact), null, 2)}\n`;
}
