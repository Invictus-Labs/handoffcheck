import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = join(REPO_ROOT, "dist", "src", "cli.js");

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

const STAMP = join(REPO_ROOT, "dist", ".hc-build-stamp");
const BUILD_LOCK = join(tmpdir(), `hc-build-${createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 12)}.lock`);

function newestInputMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestInputMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/** dist is current when the stamp written after the last successful build is newer than every source and config file. */
function distIsCurrent(): boolean {
  if (!existsSync(STAMP) || !existsSync(CLI_PATH)) return false;
  const inputs = Math.max(newestInputMtime(join(REPO_ROOT, "src")), statSync(join(REPO_ROOT, "package.json")).mtimeMs, statSync(join(REPO_ROOT, "tsconfig.json")).mtimeMs);
  return statSync(STAMP).mtimeMs >= inputs;
}

const sleepMs = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Build the package AT MOST ONCE per source state, whatever number of suites run in parallel workers (P2-9: rebuilding dist
 * inside one suite while another reads it was the e2e flake). A directory lock serialises builders; everyone else waits for
 * the stamp. scripts/verify-quality.sh builds first, so under the gate this is a no-op check.
 */
export function ensureBuilt(): void {
  const deadline = Date.now() + 5 * 60_000;
  while (!distIsCurrent()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the dist build");
    try {
      mkdirSync(BUILD_LOCK);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(BUILD_LOCK).mtimeMs > 4 * 60_000) rmSync(BUILD_LOCK, { recursive: true, force: true }); // a crashed builder
      } catch {
        /* released meanwhile */
      }
      sleepMs(250);
      continue;
    }
    try {
      if (distIsCurrent()) return;
      const r = spawnSync("npm", ["run", "--silent", "build"], { cwd: REPO_ROOT, encoding: "utf8" });
      if (r.status !== 0 || !existsSync(CLI_PATH)) throw new Error(`build failed (exit ${r.status}): ${r.stderr || r.stdout}`);
      writeFileSync(STAMP, `${new Date().toISOString()}\n`);
    } finally {
      rmSync(BUILD_LOCK, { recursive: true, force: true });
    }
  }
}

/** Environment with no ambient credentials, proxies or telemetry switches: only what the CLI needs to start. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: "C",
    TZ: "UTC",
    NO_COLOR: "1"
  };
  return { ...base, ...extra };
}

/** Invoke the packaged CLI (`node dist/src/cli.js`) in `cwd`. Never uses the library API. */
export function runCli(args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number; input?: string }): CliResult {
  ensureBuilt();
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd,
    env: cleanEnv(opts.env),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", signal: r.signal, durationMs: Date.now() - started };
}

export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}

/** In-process CLI entry (same `main` the packaged binary calls) with captured output; used for coverage-bearing tests. */
export async function runMain(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> }
): Promise<{ code: number; out: string; err: string }> {
  const { main } = await import("../../src/cli/main.js");
  let out = "";
  let err = "";
  const code = await main(args, {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    env: { PATH: process.env.PATH ?? "", ...(opts.env ?? {}) },
    cwd: opts.cwd
  });
  return { code, out, err };
}
