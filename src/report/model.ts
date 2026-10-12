import type { ReportData } from "../domain/types.js";

/**
 * Input to the report renderers.
 *
 * `data` is the library's `ReportData` (already redacted by the store). Every free-text field
 * is still treated as untrusted: the HTML renderer escapes it, the JSON renderer serialises it
 * as data. A missing run, an error, or a missing cleanup is rendered explicitly, never hidden.
 */

export interface ReportError {
  code: string;
  message: string;
  request_id?: string | null;
}

export interface ReportView {
  generated_at: string;
  tool_version: string;
  /** Present when the run could not be loaded or the harness failed; renders an error report. */
  error?: ReportError | null;
  data: ReportData | null;
  /** Operator-visible notes outside the signed data (adapter acceptance state, partial reads). */
  notices: string[];
}

export function emptyView(generatedAt: string, toolVersion: string): ReportView {
  return { generated_at: generatedAt, tool_version: toolVersion, error: null, data: null, notices: [] };
}
