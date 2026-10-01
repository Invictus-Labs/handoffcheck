// Unit tests for the CLI front end (src/cli): argument parsing, help, error bodies, formatting.
import { describe, expect, it } from "vitest";
import { COMMANDS, helpText, parseArgv, parseCommand, wantsJson } from "../../src/cli/args.js";
import { CliError, EXIT_HARNESS, EXIT_OK, EXIT_UNSATISFIED, errorBody, newRequestId } from "../../src/cli/errors.js";
import { formatReportSummary, formatRunResult, plain } from "../../src/cli/format.js";
import { toolVersion } from "../../src/cli/version.js";
import { runMain } from "../helpers/cli.js";
import { sampleReport } from "../helpers/reportData.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return (e as CliError).code;
  }
  return "NO_ERROR";
};

describe("argument parsing", () => {
  it("parses a full run invocation, applies defaults and treats the evidence alias as --output", () => {
    const p = parseArgv(["run", "--manifest", "m.yaml", "--artifact", "a.tar", "--runbook", "r.md", "--output", "ev", "--json"]);
    expect(p.command).toBe("run");
    expect(p.values).toMatchObject({ manifest: "m.yaml", artifact: "a.tar", runbook: "r.md", output: "ev", json: true });
    expect(parseArgv(["run", "--manifest", "m", "--artifact", "a", "--runbook", "r", "--store", "x"]).values.output).toBe("x");
    expect(parseArgv(["run", "--manifest", "m", "--artifact", "a", "--runbook", "r"]).values.output).toBe("evidence");
    expect(parseArgv(["demo"]).values.json).toBe(false);
    expect(parseArgv(["report", "--run", "abc"]).values.format).toBe("both");
  });

  it("parses group sub-commands", () => {
    const p = parseArgv(["adapter", "export-receipt", "--run", "r1", "--out", "d"]);
    expect(p).toMatchObject({ command: "adapter", subcommand: "export-receipt" });
    expect(parseArgv(["adapter", "import-acceptance", "--file", "f.json", "--enable-adapters"]).values["enable-adapters"]).toBe(true);
  });

  const bad: [string, string[]][] = [
    ["no command", []],
    ["an unknown command", ["frobnicate"]],
    ["a missing required option", ["run", "--manifest", "m"]],
    ["an unknown option", ["demo", "--nope"]],
    ["an unexpected positional", ["demo", "extra"]],
    ["a repeated option", ["demo", "--output", "a", "--output", "b"]],
    ["an empty value", ["report", "--run", ""]],
    ["a NUL byte", ["report", "--run", "a\0b"]],
    ["an over-long value", ["report", "--run", "a", "--out", "x".repeat(5000)]],
    ["an invalid choice", ["report", "--run", "a", "--format", "pdf"]],
    ["an invalid run id", ["report", "--run", "../etc"]],
    ["a missing sub-command", ["adapter"]],
    ["a flag where a sub-command belongs", ["adapter", "--run", "x"]],
    ["an unknown sub-command", ["adapter", "frob"]]
  ];
  for (const [name, argv] of bad) {
    it(`negative control: rejects ${name} with BAD_REQUEST`, () => {
      expect(code(() => parseArgv(argv))).toBe("BAD_REQUEST");
    });
  }

  it("allows a long reason but caps it", () => {
    expect(code(() => parseArgv(["record-intervention", "--run", "r", "--reason", "x".repeat(2000)]))).toBe("NO_ERROR");
    expect(code(() => parseArgv(["record-intervention", "--run", "r", "--reason", "x".repeat(2001)]))).toBe("BAD_REQUEST");
  });

  it("detects --json anywhere and parses a command spec directly", () => {
    expect(wantsJson(["run", "--json"])).toBe(true);
    expect(wantsJson(["run"])).toBe(false);
    expect(parseCommand(COMMANDS.demo!, ["--json"], "demo").json).toBe(true);
  });

  it("every command has a help summary and every option documents itself", () => {
    for (const spec of Object.values(COMMANDS)) {
      expect(spec.summary.length).toBeGreaterThan(10);
      for (const o of Object.values(spec.options)) expect(o.help.length).toBeGreaterThan(3);
      for (const sub of Object.values(spec.subcommands ?? {})) expect(sub.summary.length).toBeGreaterThan(10);
    }
  });

  it("renders help for the tool, each command and each sub-command", () => {
    const top = helpText("1.2.3");
    for (const name of Object.keys(COMMANDS)) expect(top).toContain(name);
    expect(helpText("1.2.3", "run")).toContain("--manifest");
    expect(helpText("1.2.3", "adapter")).toContain("export-receipt");
    expect(helpText("1.2.3", "adapter", "export-receipt")).toContain("--enable-adapters");
    expect(helpText("1.2.3", "nonsense")).toContain("handoffcheck");
  });
});

describe("errors, formatting and version", () => {
  it("has the documented exit codes and the exact error body", () => {
    expect([EXIT_OK, EXIT_UNSATISFIED, EXIT_HARNESS]).toEqual([0, 1, 2]);
    const body = errorBody("NOT_FOUND", "gone", "req_1");
    expect(body).toEqual({ error: { code: "NOT_FOUND", message: "gone", request_id: "req_1" } });
    expect(newRequestId()).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(errorBody("X", "y").error.request_id).toMatch(/^req_/);
    expect(new CliError("BAD_REQUEST", "m").exitCode).toBe(2);
  });

  it("makes control characters inert in terminal output", () => {
    expect(plain("a\u001b[31mred\u0007\u0000")).toBe("a?[31mred??");
    expect(plain(null)).toBe("");
    expect(plain(42)).toBe("42");
  });

  it("formats a run result with isolation warning, reasons, pending receipt and exit code", () => {
    const data = sampleReport();
    const text = formatRunResult(
      {
        run_id: data.run.id,
        state: data.run.state,
        outcome: data.run.outcome,
        verdict: data.verdict,
        binding: data.binding,
        provider: "local-sandbox",
        isolation: "none",
        preflight: data.preflight,
        steps: [{ step_key: "install", action: "install", status: "PASS", reason_code: "OK" }],
        cleanup: { status: "VERIFIED", resources: 1, leaked: 0 },
        exit_code: 0
      },
      { html: "r/report.html", json: "r/report.json" }
    );
    for (const s of ["REHEARSAL", "isolation none", "PENDING_HUMAN_RECEIPT", "exit code: 0", "r/report.html", "VERIFIED"]) expect(text).toContain(s);
    const none = formatRunResult({ ...JSON.parse(JSON.stringify({ run_id: "r", state: "FAILED", outcome: "FAILED", verdict: { ...data.verdict, verdict: "BLOCKED", reasons: [], human_receipt: "HARNESS_RECORDED" }, binding: data.binding, provider: "lima", isolation: "vm", preflight: null, steps: [], cleanup: { status: "VERIFIED", resources: 0, leaked: 0 }, exit_code: 1 })) });
    expect(none).toContain("none ran");
    expect(none).toContain("nothing was faked");
    expect(none).not.toContain("PENDING_HUMAN_RECEIPT");
    const summary = formatReportSummary(data, { html: "h", json: "j" });
    expect(summary).toContain("REHEARSAL (exit code 0)");
    expect(formatReportSummary(data, {})).not.toContain("html:");
  });

  it("reads the package version", () => {
    expect(toolVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("main entry (in-process)", () => {
  it("prints help to stderr with exit 2 when called without arguments, and a version with exit 0", async () => {
    const cwd = makeTmp("hc-main-");
    const none = await runMain([], { cwd });
    expect(none.code).toBe(2);
    expect(none.err).toContain("handoffcheck");
    const v = await runMain(["--version"], { cwd });
    expect(v).toMatchObject({ code: 0 });
    expect(v.out.trim()).toBe(toolVersion());
    expect((await runMain(["-v"], { cwd })).code).toBe(0);
  });

  it("serves help for tools, commands and sub-commands via every spelling", async () => {
    const cwd = makeTmp("hc-main-");
    for (const argv of [["--help"], ["-h"], ["help"], ["help", "run"], ["run", "--help"], ["adapter", "export-receipt", "-h"]]) {
      const r = await runMain(argv, { cwd });
      expect(r.code, argv.join(" ")).toBe(0);
      expect(r.out.length).toBeGreaterThan(50);
    }
  });

  it("negative control: usage errors exit 2, print a one-line stderr message and the JSON error body with --json", async () => {
    const cwd = makeTmp("hc-main-");
    const r = await runMain(["nonsense", "--json"], { cwd });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/error: BAD_REQUEST/);
    const body = JSON.parse(r.out) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    const text = await runMain(["run"], { cwd });
    expect(text.code).toBe(2);
    expect(text.out).toBe("");
  });

  it("negative control: reading a run from a store that does not exist fails without creating it", async () => {
    const cwd = makeTmp("hc-main-");
    const r = await runMain(["report", "--run", "r1", "--output", "no-such-store", "--json"], { cwd });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).error.code).toBe("NOT_FOUND");
    const again = await runMain(["export", "--run", "r1", "--out", "b.hcb", "--output", "no-such-store"], { cwd });
    expect(again.code).toBe(2);
    expect((await import("node:fs")).existsSync(`${cwd}/no-such-store`)).toBe(false);
  });
});

describe("main entry: unexpected errors and process plumbing", () => {
  it("negative control: an unexpected library error is reported as a generic internal error (exit 2); HANDOFFCHECK_DEBUG adds a redacted detail line", async () => {
    const cwd = makeTmp("hc-main-");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const store = `${cwd}/ev`;
    mkdirSync(store, { mode: 0o700 });
    writeFileSync(`${store}/handoffcheck.sqlite`, "this is not a sqlite database at all, just text".repeat(20));
    const plain = await runMain(["report", "--run", "r1", "--output", store, "--json"], { cwd });
    expect(plain.code).toBe(2);
    const body = JSON.parse(plain.out) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toMatch(/unexpected error|harness failure|internal/i);
    const debug = await runMain(["report", "--run", "r1", "--output", store, "--json"], { cwd, env: { HANDOFFCHECK_DEBUG: "1" } });
    expect(debug.code).toBe(2);
    expect(JSON.parse(debug.out).error.code).toBe("INTERNAL");
    expect(plain.err + debug.err).not.toMatch(/\n\s+at /);
  });

  it("filters only the node:sqlite experimental warning and lets every other warning through", async () => {
    const cwd = makeTmp("hc-main-");
    await runMain(["--version"], { cwd });
    const seen: string[] = [];
    const original = process.emitWarning;
    const spy = ((w: string | Error) => void seen.push(typeof w === "string" ? w : w.message)) as typeof process.emitWarning;
    // main() wraps emitWarning at call time, so install the spy first and let main wrap it
    process.emitWarning = spy;
    try {
      await runMain(["--version"], { cwd });
      process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning");
      process.emitWarning("something else entirely", "ExperimentalWarning");
      process.emitWarning(new Error("an unrelated warning"));
    } finally {
      process.emitWarning = original;
    }
    expect(seen).not.toContain("SQLite is an experimental feature");
    expect(seen).toContain("something else entirely");
    expect(seen).toContain("an unrelated warning");
  });

  it("default io uses the process streams, environment and cwd", async () => {
    const { defaultIo } = await import("../../src/cli/main.js");
    const io = defaultIo();
    expect(io.cwd).toBe(process.cwd());
    expect(io.env).toBe(process.env);
    expect(typeof io.stdout).toBe("function");
    expect(typeof io.stderr).toBe("function");
  });
});

describe("report summary for imported runs", () => {
  it("shows the bundle's verdict only as a display-only claim", () => {
    const data = { ...sampleReport(), claimed_verdict: sampleReport({}, "INDEPENDENT_PASS").verdict };
    const text = formatReportSummary(data, { html: "h" });
    expect(text).toContain("claimed:");
    expect(text).toContain("unauthenticated, display only");
    expect(formatReportSummary(sampleReport(), {})).not.toContain("claimed:");
  });
});
