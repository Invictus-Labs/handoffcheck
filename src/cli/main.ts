import { helpText, parseArgv, wantsJson } from "./args.js";
import { CliError, EXIT_HARNESS, EXIT_OK, errorBody, newRequestId, type ExitCode } from "./errors.js";
import { toolVersion } from "./version.js";
import { HandoffCheckError } from "../api.js";
import type { Context, Io } from "./context.js";

export type Handler = (ctx: Context) => Promise<ExitCode>;

/** node:sqlite prints an ExperimentalWarning on first import; keep stderr clean for operators and tests. */
function installWarningFilter(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof warning === "string" ? String(rest[0] ?? "") : warning.name;
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

const HANDLERS: Record<string, () => Promise<Handler>> = {
  run: async () => (await import("./commands/run.js")).runCommand,
  "record-intervention": async () => (await import("./commands/intervention.js")).interventionCommand,
  report: async () => (await import("./commands/report.js")).reportCommand,
  preflight: async () => (await import("./commands/preflight.js")).preflightCommand,
  "check-reuse": async () => (await import("./commands/reuse.js")).checkReuseCommand,
  purge: async () => (await import("./commands/purge.js")).purgeCommand,
  export: async () => (await import("./commands/bundle.js")).exportCommand,
  import: async () => (await import("./commands/bundle.js")).importCommand,
  "verify-bundle": async () => (await import("./commands/bundle.js")).verifyBundleCommand,
  demo: async () => (await import("./commands/demo.js")).demoCommand,
  cleanup: async () => (await import("./commands/cleanup.js")).cleanupCommand,
  adapter: async () => (await import("./commands/adapter.js")).adapterCommand
};

export function defaultIo(): Io {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env: process.env,
    cwd: process.cwd()
  };
}

function reportError(io: Io, json: boolean, err: unknown): ExitCode {
  const requestId = newRequestId();
  let code: string = "INTERNAL";
  let message = "internal error; set HANDOFFCHECK_DEBUG=1 for a detail line";
  let exit: ExitCode = EXIT_HARNESS;
  if (err instanceof CliError) {
    code = err.code;
    message = err.message;
    exit = err.exitCode;
  } else if (err instanceof HandoffCheckError) {
    // Library errors carry a stable code and a message that is already redacted and safe to show.
    code = err.code;
    message = err.message;
  } else if (err instanceof Error && io.env.HANDOFFCHECK_DEBUG === "1") {
    message = `internal error: ${err.name}: ${err.message}`;
  }
  if (json) io.stdout(`${JSON.stringify(errorBody(code, message, requestId))}\n`);
  io.stderr(`error: ${code}: ${message} (request_id=${requestId})\n`);
  return exit;
}

/** Entry point shared by the packaged binary and tests. Never calls process.exit. */
export async function main(argv: string[], io: Io = defaultIo()): Promise<ExitCode> {
  installWarningFilter();
  const json = wantsJson(argv);
  try {
    const version = toolVersion();
    if (argv.length === 0) {
      io.stderr(helpText(version));
      return EXIT_HARNESS;
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      io.stdout(`${version}\n`);
      return EXIT_OK;
    }
    if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      io.stdout(helpText(version, argv[1], argv[2]));
      return EXIT_OK;
    }
    if (argv.slice(1).some((a) => a === "--help" || a === "-h")) {
      const rest = argv.slice(1).filter((a) => !a.startsWith("-"));
      io.stdout(helpText(version, argv[0], rest[0]));
      return EXIT_OK;
    }
    const parsed = parseArgv(argv);
    const load = HANDLERS[parsed.command];
    /* v8 ignore next */
    if (!load) throw new CliError("BAD_REQUEST", `unknown command "${parsed.command}"`);
    const handler = await load();
    return await handler({ ...io, version, parsed, json: parsed.values.json === true });
  } catch (err) {
    return reportError(io, json, err);
  }
}
