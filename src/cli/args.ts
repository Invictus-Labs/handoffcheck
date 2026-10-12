import { parseArgs } from "node:util";
import { CliError } from "./errors.js";

export interface OptSpec {
  type: "string" | "boolean";
  help: string;
  required?: boolean;
  /** Allowed values for string options. */
  choices?: readonly string[];
  default?: string;
  /** Alternate long name accepted for this option. */
  alias?: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  options: Record<string, OptSpec>;
  /** Sub-commands of a group command such as `adapter`. */
  subcommands?: Record<string, CommandSpec>;
}

const JSON_OPT: OptSpec = { type: "boolean", help: "print the result (or the error) as one JSON document on stdout" };
const STORE_OPT: OptSpec = {
  type: "string",
  help: "evidence store directory (default: ./evidence)",
  default: "evidence",
  alias: "store"
};

export const COMMANDS: Record<string, CommandSpec> = {
  run: {
    name: "run",
    summary: "Run a handoff drill and print the verdict (exit 0 pass, 1 unsatisfied, 2 harness failure)",
    options: {
      manifest: { type: "string", required: true, help: "drill manifest (YAML)" },
      artifact: { type: "string", required: true, help: "release artifact (tarball) to bind and drill" },
      runbook: { type: "string", required: true, help: "runbook (Markdown) to bind" },
      output: STORE_OPT,
      "operator-kind": {
        type: "string",
        choices: ["human", "ai_assisted", "automated"],
        help: "who performs the drill (default: automated; human needs --operator-ref and --builder-ref)"
      },
      "operator-ref": { type: "string", alias: "operator", help: "operator identity recorded on the run (operator-attested, local identity)" },
      "builder-ref": { type: "string", help: "who built the release; an operator equal to the builder is never independent" },
      "allow-host-sandbox": {
        type: "boolean",
        help: "allow the local-sandbox provider to execute the manifest scripts directly on this host (isolation none; off by default)"
      },
      json: JSON_OPT
    }
  },
  "record-intervention": {
    name: "record-intervention",
    summary: "Append a builder intervention to a run (makes the verdict ASSISTED)",
    options: {
      run: { type: "string", required: true, help: "run id" },
      reason: { type: "string", required: true, help: "why help was needed (redacted before storage)" },
      actor: { type: "string", help: "who intervened (default: local; stored in bundles, so no OS user name is used unless you pass one)" },
      output: STORE_OPT,
      json: JSON_OPT
    }
  },
  report: {
    name: "report",
    summary: "Write the JSON and/or static HTML report for a run",
    options: {
      run: { type: "string", required: true, help: "run id" },
      format: { type: "string", choices: ["json", "html", "both"], default: "both", help: "json | html | both (default)" },
      out: { type: "string", help: "output file (single format; - for stdout) or directory (both)" },
      manifest: { type: "string", help: "with --artifact and --runbook: check the run's binding against these current inputs (STALE_BINDING if changed)" },
      artifact: { type: "string", help: "current release artifact (see --manifest)" },
      runbook: { type: "string", help: "current runbook (see --manifest)" },
      output: STORE_OPT,
      json: JSON_OPT
    }
  },
  preflight: {
    name: "preflight",
    summary: "Check a manifest, artifact and runbook without running anything",
    options: {
      manifest: { type: "string", required: true, help: "drill manifest (YAML)" },
      artifact: { type: "string", required: true, help: "release artifact to validate" },
      runbook: { type: "string", required: true, help: "runbook to validate" },
      "allow-host-sandbox": { type: "boolean", help: "evaluate as if --allow-host-sandbox were passed to run" },
      json: JSON_OPT
    }
  },
  "check-reuse": {
    name: "check-reuse",
    summary: "Is a stored result still reusable for these inputs? (exit 0 only if so; changed inputs invalidate it)",
    options: {
      run: { type: "string", help: "require this specific run to be the reusable result" },
      manifest: { type: "string", required: true, help: "current drill manifest (YAML)" },
      artifact: { type: "string", required: true, help: "current release artifact" },
      runbook: { type: "string", required: true, help: "current runbook" },
      output: STORE_OPT,
      json: JSON_OPT
    }
  },
  purge: {
    name: "purge",
    summary: "Delete runs whose retention has expired (or are older than N days); --dry-run deletes nothing",
    options: {
      "older-than-days": { type: "string", help: "delete runs created more than N days ago (integer >= 0) instead of by retention" },
      "dry-run": { type: "boolean", help: "list what would be purged; delete nothing" },
      output: STORE_OPT,
      json: JSON_OPT
    }
  },
  export: {
    name: "export",
    summary: "Export a versioned evidence bundle for a run",
    options: {
      run: { type: "string", required: true, help: "run id" },
      out: { type: "string", required: true, help: "bundle path to create" },
      output: STORE_OPT,
      json: JSON_OPT
    }
  },
  import: {
    name: "import",
    summary: "Import an evidence bundle atomically (all or nothing)",
    options: {
      bundle: { type: "string", required: true, help: "bundle path" },
      output: STORE_OPT,
      json: JSON_OPT
    }
  },
  "verify-bundle": {
    name: "verify-bundle",
    summary: "Verify a bundle's schema, size limits and hashes without importing it",
    options: {
      bundle: { type: "string", required: true, help: "bundle path" },
      json: JSON_OPT
    }
  },
  demo: {
    name: "demo",
    summary: "Run the offline synthetic demo drill end to end",
    options: {
      output: { type: "string", help: "evidence store directory (default: a new ./handoffcheck-demo)", alias: "store" },
      json: JSON_OPT
    }
  },
  cleanup: {
    name: "cleanup",
    summary: "Re-run and verify cleanup for a run",
    options: {
      run: { type: "string", required: true, help: "run id" },
      output: STORE_OPT,
      json: JSON_OPT
    }
  },
  adapter: {
    name: "adapter",
    summary: "Optional local-file adapters (disabled by default; no network)",
    options: {},
    subcommands: {
      "export-receipt": {
        name: "export-receipt",
        summary: "Write a RunProof-style receipt envelope plus redacted report for a run",
        options: {
          run: { type: "string", required: true, help: "run id" },
          out: { type: "string", required: true, help: "directory for the envelope and report files" },
          output: STORE_OPT,
          "enable-adapters": { type: "boolean", help: "opt in (or set HANDOFFCHECK_ADAPTERS=1)" },
          json: JSON_OPT
        }
      },
      "import-acceptance": {
        name: "import-acceptance",
        summary: "Import ProofGate-style acceptance envelope(s) from a local file",
        options: {
          file: { type: "string", required: true, help: "JSON file with one envelope or an array of envelopes" },
          output: STORE_OPT,
          "enable-adapters": { type: "boolean", help: "opt in (or set HANDOFFCHECK_ADAPTERS=1)" },
          json: JSON_OPT
        }
      }
    }
  }
};

export interface Parsed {
  command: string;
  /** Sub-command for group commands, otherwise undefined. */
  subcommand?: string;
  values: Record<string, string | boolean | undefined>;
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REASON = 2000;
const MAX_PATH = 4096;

function bad(message: string): CliError {
  return new CliError("BAD_REQUEST", message);
}

export function parseCommand(spec: CommandSpec, argv: string[], label: string): Record<string, string | boolean | undefined> {
  const options: Record<string, { type: "string" | "boolean" }> = {};
  const aliasToName = new Map<string, string>();
  for (const [name, o] of Object.entries(spec.options)) {
    options[name] = { type: o.type };
    if (o.alias) {
      options[o.alias] = { type: o.type };
      aliasToName.set(o.alias, name);
    }
  }
  // node's parser keeps the last of repeated options; an operator repeating --run or --output is almost certainly a mistake.
  const seen = new Set<string>();
  for (const token of argv) {
    if (token === "--") break;
    const m = /^--([a-z][a-z-]*)(=|$)/.exec(token);
    const key = m?.[1];
    if (key === undefined || options[key]?.type !== "string") continue;
    if (seen.has(key)) throw bad(`${label}: --${key} given more than once`);
    seen.add(key);
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    const first = (err as Error).message.split("\n")[0] ?? "invalid arguments";
    throw bad(`${label}: ${first.split(". To specify")[0]}`);
  }
  if (parsed.positionals.length > 0) {
    throw bad(`${label}: unexpected argument "${parsed.positionals[0]}"`);
  }
  const values: Record<string, string | boolean | undefined> = {};
  for (const [key, raw] of Object.entries(parsed.values)) {
    const name = aliasToName.get(key) ?? key;
    if (values[name] !== undefined && raw !== undefined) throw bad(`${label}: --${name} given more than once`);
    values[name] = raw as string | boolean | undefined;
  }
  for (const [name, o] of Object.entries(spec.options)) {
    const v = values[name];
    if (o.type === "string") {
      if (v === undefined) {
        if (o.required) throw bad(`${label}: missing required option --${name}`);
        if (o.default !== undefined) values[name] = o.default;
        continue;
      }
      const s = String(v);
      if (s.length === 0) throw bad(`${label}: --${name} must not be empty`);
      if (s.includes("\0")) throw bad(`${label}: --${name} contains a NUL byte`);
      if (s.length > (name === "reason" ? MAX_REASON : MAX_PATH)) throw bad(`${label}: --${name} is too long`);
      if (o.choices && !o.choices.includes(s)) throw bad(`${label}: --${name} must be one of ${o.choices.join(", ")}`);
      if (name === "run" && !RUN_ID_RE.test(s)) throw bad(`${label}: --run is not a valid run id`);
      if (name === "older-than-days" && !/^\d{1,6}$/.test(s)) throw bad(`${label}: --older-than-days must be an integer from 0 to 999999`);
    } else if (v === undefined) {
      values[name] = false;
    }
  }
  if (label === "report") {
    const given = ["manifest", "artifact", "runbook"].filter((n) => values[n] !== undefined);
    if (given.length > 0 && given.length < 3) throw bad("report: --manifest, --artifact and --runbook must be given together");
  }
  return values;
}

export function parseArgv(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined) throw bad("no command given; try --help");
  const spec = COMMANDS[first];
  if (!spec) throw bad(`unknown command "${first}"; try --help`);
  if (spec.subcommands) {
    const [sub, ...subRest] = rest;
    if (sub === undefined || sub.startsWith("-")) {
      throw bad(`${first}: missing sub-command (${Object.keys(spec.subcommands).join(" | ")})`);
    }
    const subSpec = spec.subcommands[sub];
    if (!subSpec) throw bad(`${first}: unknown sub-command "${sub}" (${Object.keys(spec.subcommands).join(" | ")})`);
    return { command: first, subcommand: sub, values: parseCommand(subSpec, subRest, `${first} ${sub}`) };
  }
  return { command: first, values: parseCommand(spec, rest, first) };
}

export function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function renderOptions(spec: CommandSpec): string {
  const lines: string[] = [];
  for (const [name, o] of Object.entries(spec.options)) {
    const value = o.type === "string" ? ` <${o.choices ? o.choices.join("|") : "value"}>` : "";
    const req = o.required ? " (required)" : "";
    lines.push(`    --${name}${value}${req}`.padEnd(40) + o.help);
  }
  return lines.join("\n");
}

export function helpText(version: string, topic?: string, sub?: string): string {
  if (topic) {
    const spec = COMMANDS[topic];
    if (spec) {
      if (spec.subcommands && sub && spec.subcommands[sub]) {
        const s = spec.subcommands[sub];
        return `handoffcheck ${topic} ${sub} - ${s.summary}\n\nOptions:\n${renderOptions(s)}\n`;
      }
      if (spec.subcommands) {
        const subs = Object.values(spec.subcommands)
          .map((s) => `    ${s.name}`.padEnd(24) + s.summary)
          .join("\n");
        return `handoffcheck ${topic} - ${spec.summary}\n\nSub-commands:\n${subs}\n`;
      }
      return `handoffcheck ${topic} - ${spec.summary}\n\nOptions:\n${renderOptions(spec)}\n`;
    }
  }
  const cmds = Object.values(COMMANDS)
    .map((c) => `  ${c.name}`.padEnd(24) + c.summary)
    .join("\n");
  return `handoffcheck ${version} - prove another operator can run what you delivered

Usage: handoffcheck <command> [options]

Commands:
${cmds}

Global options:
  --help, -h              show help (also: handoffcheck <command> --help)
  --version, -v           print the version
  --json                  machine-readable output; errors are {"error":{"code","message","request_id"}}

Exit codes:
  0  every mandatory step and the cleanup check PASS
  1  unsatisfied: a step failed, the run is ASSISTED, or cleanup is CLEANUP_UNCONFIRMED
  2  harness failure: bad usage, unreadable input or an internal error

No network access, no telemetry. Evidence directories are created owner-only (0700).
`;
}
