/**
 * HTML escaping for untrusted report text.
 *
 * Every dynamic value that reaches the HTML report goes through `esc`. Control characters
 * (other than tab and newline) are made visible instead of being emitted raw, so hostile
 * input can neither break out of an element or attribute nor smuggle terminal escapes.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;"
};

// C0 controls except \t (0x09) and \n (0x0a), DEL, C1 controls, and bidi/line-separator overrides.
// Built from numeric ranges so the source file contains no raw control characters.
const UNSAFE_CHARS = new RegExp(
  "[" +
    "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069" +
    "]",
  "g"
);

function visibleControl(ch: string): string {
  const code = ch.charCodeAt(0);
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

export function esc(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text.replace(UNSAFE_CHARS, visibleControl).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]!);
}
