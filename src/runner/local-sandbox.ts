import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ExecRequest,
  ExecResult,
  ProvisionRequest,
  ProviderAvailability,
  ResourceRecord,
  RunnerProvider,
  Sandbox
} from "../domain/types.js";
import { hasSymlinkComponent, isSafeRelativePath, resolveInside } from "../security/paths.js";
import { runCommand } from "./proc.js";
import { MARK_VAR, descendantsOf, pidAlive, psTable, psTableAsync, sameProcess, scanProcesses } from "./procscan.js";

export type TestFault = "leak-resource" | "leak-process" | null;

export interface LocalSandboxOptions {
  /** Parent directory for sandboxes. Default: the OS temp directory. */
  baseDir?: string;
  /** Negative-control fault injection (see docs/DESIGN.md section 7). */
  fault?: TestFault;
  /** Host platform; injectable for tests. */
  platform?: NodeJS.Platform;
}

const INTERPRETERS: Record<string, string> = { sh: "/bin/sh", bash: "/bin/bash" };

function chmodTree(dir: string): void {
  try {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isDirectory()) chmodTree(full);
      else if (!st.isSymbolicLink()) chmodSync(full, 0o600);
    }
  } catch {
    /* best effort: rmSync reports the real failure */
  }
}

function removeDir(dir: string): void {
  chmodTree(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function killGroupQuiet(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* gone */
  }
}

function killPidQuiet(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function settle(check: () => boolean, attempts = 10, delayMs = 100): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return check();
}

class LocalSandbox implements Sandbox {
  readonly provider = "local-sandbox";
  readonly isolation = "none" as const;
  private readonly pgids = new Set<number>();
  /** descendants seen while scripts ran (pid -> start time) */
  private readonly tracked = new Map<number, string>();
  /** processes found and killed at destroy time; audited afterwards */
  private readonly strays = new Map<number, string>();
  private destroyed = false;
  readonly facts: Record<string, string> = {
    egress: "NOT_ENFORCED: isolation none, host-local synthetic sandbox; only static preflight checks destinations",
    resource_limits: "wall clock, cpu seconds and file size via ulimit, output cap; memory not limited"
  };

  constructor(
    readonly id: string,
    private readonly root: string,
    private readonly req: ProvisionRequest,
    private readonly fault: TestFault,
    private readonly mark: string
  ) {}

  private env(extra: Record<string, string> | undefined, stepKey: string): Record<string, string> {
    const nodeDir = dirname(process.execPath);
    return {
      PATH: `/usr/local/bin:/usr/bin:/bin:${nodeDir}`,
      HOME: join(this.root, "home"),
      TMPDIR: join(this.root, "tmp"),
      LC_ALL: "C",
      ...this.req.env,
      HC_RUN_ID: this.req.run_id,
      HC_STEP: stepKey,
      HC_SANDBOX: this.root,
      HC_RELEASE: join(this.root, "release"),
      HC_STATE: join(this.root, "state"),
      HC_ISOLATION: "none",
      HC_NODE: process.execPath,
      [MARK_VAR]: this.mark,
      ...extra
    };
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const started = performance.now();
    const empty = (over: Partial<ExecResult>): ExecResult => ({
      label: req.label,
      exit_code: null,
      signal: null,
      timed_out: false,
      aborted: false,
      duration_ms: Math.round(performance.now() - started),
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      truncated: false,
      ...over
    });
    if (this.destroyed) return empty({ stderr: Buffer.from("sandbox already destroyed") });
    const scriptPath = isSafeRelativePath(req.script.path) ? resolveInside(join(this.root, "scripts"), req.script.path) : null;
    if (!scriptPath || !existsSync(scriptPath)) return empty({ stderr: Buffer.from(`script not staged: ${req.script.path}`) });
    const interp = req.script.interpreter ?? "sh";
    const interpreter = interp === "node" ? process.execPath : INTERPRETERS[interp];
    if (!interpreter || !existsSync(interpreter)) return empty({ stderr: Buffer.from(`interpreter unavailable: ${interp}`) });

    const cpuSeconds = Math.ceil(req.timeout_ms / 1000) + 5;
    const stepKey = req.label.split(":")[0] as string; // labels are "<step id>:<role>"
    const wrapper = 'ulimit -t "$1" 2>/dev/null; ulimit -f "$2" 2>/dev/null; shift 2; exec "$@"';
    let rootPid: number | null = null;
    let polling = false;
    const tick = async (): Promise<void> => {
      if (polling || rootPid === null) return;
      polling = true;
      try {
        const table = await psTableAsync();
        if (table) for (const r of descendantsOf(table, rootPid)) this.tracked.set(r.pid, r.lstart);
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void tick(), 250);
    const res = await runCommand({
      file: "/bin/sh",
      args: ["-c", wrapper, "hc-wrapper", String(cpuSeconds), "262144", interpreter, scriptPath, ...(req.script.args ?? [])],
      cwd: join(this.root, "release"),
      env: this.env(req.extra_env, stepKey),
      timeoutMs: req.timeout_ms,
      maxOutputBytes: this.req.limits.max_output_bytes,
      signal: req.signal,
      onSpawn: (pid) => {
        this.pgids.add(pid);
        rootPid = pid;
      }
    }).finally(() => clearInterval(timer));
    return {
      label: req.label,
      exit_code: res.exit_code,
      signal: res.signal,
      timed_out: res.timed_out,
      aborted: res.aborted,
      duration_ms: Math.round(performance.now() - started),
      stdout: res.stdout,
      stderr: res.spawn_error ? Buffer.from(`spawn failed: ${res.spawn_error}`) : res.stderr,
      truncated: res.truncated
    };
  }

  async readFile(relPath: string, maxBytes: number): Promise<Uint8Array | null> {
    if (!isSafeRelativePath(relPath)) return null;
    const full = resolveInside(this.root, relPath);
    if (!full || hasSymlinkComponent(this.root, relPath)) return null;
    try {
      const st = lstatSync(full);
      if (!st.isFile() || st.size > maxBytes) return null;
      return readFileSync(full);
    } catch {
      return null;
    }
  }

  resources(): ResourceRecord[] {
    const out: ResourceRecord[] = [{ kind: "directory", id: `sandbox-dir:${this.id}`, locator: this.root, state: "unknown" }];
    // only process groups still alive can leak; exited groups need no tracking
    for (const pgid of [...this.pgids].filter((p) => groupAlive(p)).sort((a, b) => a - b)) {
      out.push({ kind: "process", id: `process-group:${pgid}`, locator: `pgid:${pgid}`, state: "unknown" });
    }
    const table = psTable();
    const seen = new Map<number, string>([...this.tracked, ...this.strays]);
    for (const [pid, lstart] of [...seen].sort((a, b) => a[0] - b[0])) {
      if (sameProcess(pid, lstart, table)) out.push({ kind: "process", id: `process:${pid}`, locator: `pid:${pid}:${lstart}`, state: "unknown" });
    }
    out.push({ kind: "process-scan", id: `process-scan:${this.id}`, locator: `marker:${this.mark}`, state: "unknown" });
    return out;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    // find everything that still belongs to the sandbox while its directory exists (lsof needs it), then kill it
    const scan = scanProcesses({ marker: this.mark, dir: this.root, tracked: this.tracked });
    const table = psTable();
    const killProcesses = this.fault !== "leak-process"; // negative control: leave processes running so the audit must find them
    for (const pid of scan?.pids.keys() ?? []) {
      this.strays.set(pid, table?.find((r) => r.pid === pid)?.lstart ?? this.tracked.get(pid) ?? "");
      if (killProcesses) killPidQuiet(pid);
    }
    if (killProcesses) for (const pgid of this.pgids) killGroupQuiet(pgid);
    if (killProcesses) await settle(() => [...this.pgids].every((p) => !groupAlive(p)) && [...this.strays].every(([pid, ls]) => !sameProcess(pid, ls)), 10, 50);
    if (this.fault === "leak-resource") return;
    removeDir(this.root);
  }
}

export class LocalSandboxProvider implements RunnerProvider {
  readonly name = "local-sandbox";
  readonly isolation = "none" as const;

  constructor(private readonly opts: LocalSandboxOptions = {}) {}

  async probe(): Promise<ProviderAvailability> {
    if ((this.opts.platform ?? process.platform) === "win32") return { available: false, reason: "local-sandbox requires a POSIX host (process groups)" };
    return { available: true, version: `node ${process.version}` };
  }

  async provision(req: ProvisionRequest): Promise<Sandbox> {
    if (!req.synthetic) throw new Error("local-sandbox refuses non-synthetic scenarios");
    const base = this.opts.baseDir ?? tmpdir();
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, `hcsbx-${req.run_id.slice(0, 8)}-`));
    chmodSync(root, 0o700);
    const id = root.slice(root.lastIndexOf("hcsbx-"));
    const mark = `${id}-${randomBytes(6).toString("hex")}`;
    try {
      for (const d of ["release", "scripts", "state", "home", "tmp"]) mkdirSync(join(root, d), { mode: 0o700 });
      const releaseRoot = join(root, "release");
      for (const e of req.artifact.entries) {
        const full = resolveInside(releaseRoot, e.path);
        if (!full) throw new Error(`unsafe artifact path ${e.path}`);
        const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
        if (parent && hasSymlinkComponent(releaseRoot, parent)) throw new Error(`artifact entry ${e.path} is below a symlink`);
        if (e.type === "directory") {
          mkdirSync(full, { recursive: true, mode: 0o700 });
          chmodSync(full, (e.mode & 0o777) | 0o700);
        } else if (e.type === "symlink") {
          mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
          symlinkSync(e.linkname ?? "", full);
        } else {
          mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
          writeFileSync(full, e.data ?? new Uint8Array(), { flag: "wx", mode: (e.mode & 0o755) | 0o600 });
        }
      }
      for (const s of req.scripts) {
        const full = resolveInside(join(root, "scripts"), s.path);
        if (!full) throw new Error(`unsafe script path ${s.path}`);
        mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
        writeFileSync(full, s.bytes, { flag: "w", mode: 0o500 });
      }
    } catch (err) {
      removeDir(root);
      throw err;
    }
    return new LocalSandbox(id, root, req, this.opts.fault ?? null, mark);
  }

  async audit(resources: ResourceRecord[]): Promise<ResourceRecord[]> {
    const out: ResourceRecord[] = [];
    for (const r of resources) {
      if (r.kind === "directory") {
        const exists = pathExists(r.locator);
        out.push({ ...r, state: exists ? "leaked" : "removed", ...(exists ? { detail: "sandbox directory still exists" } : {}) });
      } else if (r.kind === "process" && r.locator.startsWith("pid:")) {
        const m = /^pid:(\d+):(.*)$/s.exec(r.locator);
        const alive = m ? sameProcess(Number(m[1]), m[2] as string) : false;
        out.push({ ...r, state: alive ? "leaked" : "removed", ...(alive ? { detail: "process is still alive" } : {}) });
      } else if (r.kind === "process") {
        const pgid = Number(r.locator.replace("pgid:", ""));
        const alive = Number.isInteger(pgid) && pgid > 1 && groupAlive(pgid);
        out.push({ ...r, state: alive ? "leaked" : "removed", ...(alive ? { detail: "process group is still alive" } : {}) });
      } else if (r.kind === "process-scan") {
        const marker = r.locator.replace("marker:", "");
        let scan = scanProcesses({ marker, dir: null, tracked: new Map() });
        if (scan && scan.pids.size > 0) {
          await settle(() => {
            scan = scanProcesses({ marker, dir: null, tracked: new Map() });
            return scan !== null && scan.pids.size === 0;
          }, 5, 100);
        }
        const partial = "process_scan: PARTIAL - a detached daemon that left the sandbox directory, closed its files and scrubbed its environment cannot be detected on this host";
        if (scan === null) out.push({ ...r, state: "unknown", detail: "process scan unavailable on this host (no /proc, ps, pgrep or lsof)" });
        else if (scan.pids.size > 0) out.push({ ...r, state: "leaked", detail: `${scan.pids.size} process(es) still belong to the sandbox (${[...new Set(scan.pids.values())].join(", ")})` });
        else out.push({ ...r, state: "removed", detail: `${partial}; methods: ${scan.methods.join(", ")}` });
      } else {
        out.push({ ...r, state: "unknown", detail: "resource kind not handled by local-sandbox" });
      }
    }
    return out;
  }

  async destroyResources(resources: ResourceRecord[]): Promise<void> {
    if (this.opts.fault === "leak-process") return;
    for (const r of resources) {
      if (r.kind === "process" && r.locator.startsWith("pid:")) {
        const m = /^pid:(\d+):(.*)$/s.exec(r.locator);
        if (m && sameProcess(Number(m[1]), m[2] as string)) killPidQuiet(Number(m[1]));
      } else if (r.kind === "process") {
        const pgid = Number(r.locator.replace("pgid:", ""));
        if (Number.isInteger(pgid) && pgid > 1) killGroupQuiet(pgid);
      } else if (r.kind === "process-scan") {
        // include the sandbox directory (if it still exists) so processes holding it open are found too (lsof)
        const dirs = resources.filter((x) => x.kind === "directory" && /\/hcsbx-[^/]+$/.test(x.locator));
        const dir = dirs[0]?.locator ?? null;
        for (const pid of scanProcesses({ marker: r.locator.replace("marker:", ""), dir, tracked: new Map() })?.pids.keys() ?? []) killPidQuiet(pid);
      }
    }
    for (const r of resources) {
      if (r.kind === "directory" && this.opts.fault !== "leak-resource") {
        const dir = resolve(r.locator);
        // never remove anything that is not a sandbox directory this provider created
        if (/\/hcsbx-[^/]+$/.test(dir) && pathExists(dir) && !lstatSync(dir).isSymbolicLink()) removeDir(dir);
      }
    }
  }
}
