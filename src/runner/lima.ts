import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, accessSync, constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type {
  ExecRequest,
  ExecResult,
  ProvisionRequest,
  ProviderAvailability,
  ResourceRecord,
  RunnerProvider,
  Sandbox
} from "../domain/types.js";
import { HandoffCheckError } from "../domain/errors.js";
import { ProvisionError } from "../domain/provision.js";
import { isSafeRelativePath, resolveInside } from "../security/paths.js";
import { runCommand } from "./proc.js";
import type { CommandResult } from "./proc.js";

/**
 * Lima VM provider (isolation "vm"): the one supported disposable Linux VM runner.
 *
 * Verified recipe (Lima 2.2.0, alpine template, macOS vz): `limactl start --name N --cpus --memory --disk --vm-type vz
 * --plain --tty=false --timeout 10m template:alpine`; `limactl shell` to execute; `limactl copy` to stage files;
 * `limactl delete --force` to destroy. `--plain` gives no host mounts and no port forwards.
 *
 * Honesty contract: if `limactl` cannot be found or fails its version probe, `probe()` reports unavailable and the
 * run is BLOCKED. Success is never simulated. Tests that use a fake limactl are protocol tests, not live receipts.
 *
 * Egress is NOT ENFORCED (reported PARTIAL, best-effort). Lima's usernet gives the guest outbound NAT and the template has no
 * firewall tool. At provision time the guest default routes are removed and checked (`ip route get` to a documentation
 * address fails, no default route remains), and workloads then run as an unprivileged user without sudo that cannot add
 * routes back (also checked). That is not a firewall: the host-gateway address cannot be blocked (blackholing it breaks the
 * control channel), and a guest privilege escalation would undo the route removal. Never claim it as enforced.
 */

export interface LimaOptions {
  /** Explicit limactl path (HANDOFFCHECK_LIMACTL). Default: search PATH. */
  limactl?: string;
  env: NodeJS.ProcessEnv;
  /** Host platform; injectable for tests (selects the default VM type). */
  platform?: NodeJS.Platform;
  /** Template passed to `limactl create` (HANDOFFCHECK_LIMA_TEMPLATE). */
  template?: string;
  baseDir?: string;
  /** Negative-control fault injection: skip VM deletion so the leak is real and must be detected. */
  fault?: "leak-resource" | null;
}

const REMOTE_ROOT = "/tmp/hcsbx";
const WORKLOAD_USER = "hcrun";
const CTL_TIMEOUT_MS = 10 * 60 * 1000;
const SHORT_TIMEOUT_MS = 60 * 1000;
const MAX_CTL_OUTPUT = 1024 * 1024;

export function findLimactl(env: NodeJS.ProcessEnv, explicit?: string): string | null {
  const configured = explicit ?? env["HANDOFFCHECK_LIMACTL"];
  if (configured) {
    try {
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      return null;
    }
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "limactl");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

class LimaSandbox implements Sandbox {
  readonly provider = "lima";
  readonly isolation = "vm" as const;
  private destroyed = false;

  constructor(
    readonly id: string,
    private readonly ctl: (args: string[], timeoutMs: number, signal?: AbortSignal, maxOutputBytes?: number) => Promise<CommandResult>,
    private readonly req: ProvisionRequest,
    private readonly stageDir: string,
    readonly facts: Record<string, string>,
    private readonly fault: "leak-resource" | null = null
  ) {}

  async exec(req: ExecRequest): Promise<ExecResult> {
    const started = performance.now();
    const fail = (msg: string): ExecResult => ({
      label: req.label,
      exit_code: null,
      signal: null,
      timed_out: false,
      aborted: false,
      duration_ms: Math.round(performance.now() - started),
      stdout: new Uint8Array(),
      stderr: Buffer.from(msg),
      truncated: false
    });
    if (this.destroyed) return fail("sandbox already destroyed");
    if (!isSafeRelativePath(req.script.path)) return fail(`unsafe script path ${req.script.path}`);
    const interp = req.script.interpreter ?? "sh";
    const interpreter = interp === "node" ? "node" : interp === "bash" ? "bash" : "sh";
    const stepKey = req.label.split(":")[0] as string; // labels are "<step id>:<role>"
    const env: Record<string, string> = {
      // BusyBox installs ip in /sbin; workloads need the same supported tool for the actual denial probe.
      PATH: "/usr/local/bin:/usr/bin:/bin:/sbin",
      HOME: `${REMOTE_ROOT}/home`,
      TMPDIR: `${REMOTE_ROOT}/tmp`,
      LC_ALL: "C",
      ...this.req.env,
      HC_RUN_ID: this.req.run_id,
      HC_STEP: stepKey,
      HC_SANDBOX: REMOTE_ROOT,
      HC_RELEASE: `${REMOTE_ROOT}/release`,
      HC_STATE: `${REMOTE_ROOT}/state`,
      HC_ISOLATION: "vm",
      HC_NODE: "node",
      ...(req.extra_env ?? {})
    };
    const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const seconds = Math.max(1, Math.ceil(req.timeout_ms / 1000));
    // the workload runs as the unprivileged user WORKLOAD_USER (no sudo), so it cannot re-add the routes removed at provision time
    const guestCmd = [
      "sudo", "-n", "-u", WORKLOAD_USER, "sh", "-c", `cd ${REMOTE_ROOT}/release && exec "$@"`, "hc-run",
      "timeout", "-k", "2", String(seconds),
      "env", "-i", ...envArgs,
      interpreter, `${REMOTE_ROOT}/scripts/${req.script.path}`, ...(req.script.args ?? [])
    ];
    const res = await this.ctl(
      ["shell", "--workdir", "/tmp", this.id, "--", "sh", "-c", guestCmd.map(shQuote).join(" ")],
      req.timeout_ms + 15_000,
      req.signal,
      this.req.limits.max_output_bytes
    );
    // `timeout` exits 124 (TERM) / 137 (KILL) when the guest command ran over time
    const guestTimedOut = res.exit_code === 124 || res.exit_code === 137;
    return {
      label: req.label,
      exit_code: res.exit_code,
      signal: res.signal,
      timed_out: res.timed_out || guestTimedOut,
      aborted: res.aborted,
      duration_ms: Math.round(performance.now() - started),
      stdout: res.stdout,
      stderr: res.spawn_error ? Buffer.from(`limactl failed: ${res.spawn_error}`) : res.stderr,
      truncated: res.truncated
    };
  }

  async readFile(relPath: string, maxBytes: number): Promise<Uint8Array | null> {
    if (!isSafeRelativePath(relPath)) return null;
    const script = 'if [ -f "$1" ] && [ ! -L "$1" ]; then head -c "$2" "$1"; else exit 44; fi';
    // files belong to the workload user and may be private: read them with sudo, with an output cap that fits the file
    const res = await this.ctl(
      ["shell", this.id, "--", "sudo", "-n", "sh", "-c", script, "hc-read", `${REMOTE_ROOT}/${relPath}`, String(maxBytes + 1)],
      SHORT_TIMEOUT_MS,
      undefined,
      maxBytes + 4096
    );
    if (res.exit_code !== 0 || res.stdout.length > maxBytes) return null;
    return res.stdout;
  }

  resources(): ResourceRecord[] {
    return [
      { kind: "vm-instance", id: `vm-instance:${this.id}`, locator: this.id, state: "unknown" },
      { kind: "directory", id: `host-staging:${this.id}`, locator: this.stageDir, state: "unknown" }
    ];
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.fault === "leak-resource") return;
    await this.ctl(["delete", "--force", this.id], CTL_TIMEOUT_MS);
    rmSync(this.stageDir, { recursive: true, force: true });
  }
}

export class LimaProvider implements RunnerProvider {
  readonly name = "lima";
  readonly isolation = "vm" as const;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: LimaOptions) {
    this.env = opts.env;
  }

  private bin(): string | null {
    return findLimactl(this.env, this.opts.limactl);
  }

  private ctlEnv(): Record<string, string> {
    return {
      PATH: this.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: this.env["HOME"] ?? tmpdir(),
      ...(this.env["LIMA_HOME"] ? { LIMA_HOME: this.env["LIMA_HOME"] } : {})
    };
  }

  private async ctl(args: string[], timeoutMs: number, signal?: AbortSignal, maxOutputBytes: number = MAX_CTL_OUTPUT): Promise<CommandResult> {
    const bin = this.bin();
    if (!bin) throw new HandoffCheckError("PROVIDER_UNAVAILABLE", "limactl not found (set HANDOFFCHECK_LIMACTL or install Lima)");
    return runCommand({
      file: bin,
      args,
      env: this.ctlEnv(),
      timeoutMs,
      maxOutputBytes,
      signal
    });
  }

  async probe(): Promise<ProviderAvailability> {
    const bin = this.bin();
    if (!bin) return { available: false, reason: "limactl not found: the Lima VM runner is unavailable, so this run is BLOCKED (never simulated)" };
    const res = await runCommand({
      file: bin,
      args: ["--version"],
      env: this.ctlEnv(),
      timeoutMs: 10_000,
      maxOutputBytes: 4096
    });
    if (res.spawn_error || res.exit_code !== 0) {
      return { available: false, reason: `limactl failed its version probe (exit ${res.exit_code ?? "none"}); the Lima VM runner is unavailable` };
    }
    return { available: true, version: res.stdout.toString("utf8").trim().slice(0, 100) };
  }

  async provision(req: ProvisionRequest): Promise<Sandbox> {
    const name = `hc-${req.run_id.replace(/-/g, "").slice(0, 8)}-${randomBytes(3).toString("hex")}`;
    const base = this.opts.baseDir ?? tmpdir();
    mkdirSync(base, { recursive: true });
    const stage = mkdtempSync(join(base, "hcsbx-lima-"));
    chmodSync(stage, 0o700);
    const fail = async (msg: string): Promise<never> => {
      if (this.opts.fault !== "leak-resource") {
        await this.ctl(["delete", "--force", name], SHORT_TIMEOUT_MS).catch(() => undefined);
        rmSync(stage, { recursive: true, force: true });
      }
      // prove the partial resources are gone; whatever remains is reported to the engine
      const left = (
        await this.audit([
          { kind: "vm-instance", id: `vm-instance:${name}`, locator: name, state: "unknown" },
          { kind: "directory", id: `host-staging:${name}`, locator: stage, state: "unknown" }
        ])
      ).filter((x) => x.state !== "removed");
      throw new ProvisionError(msg, left);
    };
    try {
      for (const d of ["release", "scripts", "state", "home", "tmp"]) mkdirSync(join(stage, d), { mode: 0o700 });
      for (const e of req.artifact.entries) {
        const full = resolveInside(join(stage, "release"), e.path);
        if (!full) throw new Error(`unsafe artifact path ${e.path}`);
        if (e.type === "directory") mkdirSync(full, { recursive: true, mode: 0o755 });
        else if (e.type === "symlink") {
          mkdirSync(dirname(full), { recursive: true });
          symlinkSync(e.linkname ?? "", full);
        } else {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, e.data ?? new Uint8Array(), { flag: "wx", mode: e.mode & 0o755 || 0o644 });
        }
      }
      for (const s of req.scripts) {
        const full = resolveInside(join(stage, "scripts"), s.path);
        if (!full) throw new Error(`unsafe script path ${s.path}`);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, s.bytes, { mode: 0o755 });
      }
    } catch (err) {
      rmSync(stage, { recursive: true, force: true });
      throw err;
    }

    const r = req.limits.resources;
    const startArgs = ["start", `--name=${name}`, "--tty=false", "--plain", "--timeout", "10m"];
    const vmType = this.env["HANDOFFCHECK_LIMA_VMTYPE"] ?? ((this.opts.platform ?? process.platform) === "darwin" ? "vz" : "");
    if (vmType) startArgs.push("--vm-type", vmType);
    if (r) startArgs.push("--cpus", String(r.cpus), "--memory", String(Math.max(1, Math.ceil(r.memory_mb / 1024))), "--disk", String(Math.max(1, Math.ceil(r.disk_mb / 1024))));
    startArgs.push(this.opts.template ?? this.env["HANDOFFCHECK_LIMA_TEMPLATE"] ?? "template:alpine");
    const started = await this.ctl(startArgs, CTL_TIMEOUT_MS, req.signal);
    if (started.exit_code !== 0) return fail(`limactl start failed (exit ${started.exit_code ?? "none"}): ${started.stderr.toString("utf8").slice(-300)}`);

    // cut internet egress by removing default routes, then prove it; refuse to run if it cannot be proven
    const cut =
      "command -v ip >/dev/null 2>&1 || exit 40; " +
      "sudo -n ip route del default 2>/dev/null; sudo -n ip -6 route del default 2>/dev/null; " +
      'v4=$(ip route show default 2>/dev/null) || exit 40; v6=$(ip -6 route show default 2>/dev/null) || exit 40; ' +
      'if [ -n "$v4" ] || [ -n "$v6" ]; then exit 41; fi; ' +
      // Supported C-locale status-2 ENETUNREACH diagnostics: observed Alpine iproute2 and legacy BusyBox/musl.
      // Unknown diagnostics/statuses fail closed; tool compatibility requires actual guest evidence.
      "if route=$(LC_ALL=C ip route get 192.0.2.1 2>&1); then exit 42; else route_status=$?; fi; " +
      '[ "$route_status" -eq 2 ] || exit 43; ' +
      'case "$route" in "RTNETLINK answers: Network unreachable"|"ip: RTNETLINK answers: Network unreachable") ;; *) exit 43 ;; esac; exit 0';
    const fw = await this.ctl(["shell", name, "--", "sh", "-c", cut], SHORT_TIMEOUT_MS);
    if (fw.exit_code !== 0) return fail(`guest internet egress could not be cut and verified (exit ${fw.exit_code ?? "none"}); refusing to run workloads`);

    const copy = await this.ctl(["copy", "-r", `${stage}/.`, `${name}:${REMOTE_ROOT}`], CTL_TIMEOUT_MS, req.signal);
    if (copy.exit_code !== 0) return fail(`limactl copy failed (exit ${copy.exit_code ?? "none"}): ${copy.stderr.toString("utf8").slice(-200)}`);

    // run workloads as an unprivileged user without sudo; scripts stay owned by the provisioning user and read-only to it
    const user =
      `set -e; export LC_ALL=C; sudo -n adduser -D -H -h ${REMOTE_ROOT}/home -s /bin/sh ${WORKLOAD_USER}; ` +
      `sudo -n chmod 755 ${REMOTE_ROOT} ${REMOTE_ROOT}/scripts; sudo -n chmod -R a+rX ${REMOTE_ROOT}/scripts; ` +
      `sudo -n chown -R ${WORKLOAD_USER} ${REMOTE_ROOT}/release ${REMOTE_ROOT}/state ${REMOTE_ROOT}/home ${REMOTE_ROOT}/tmp; ` +
      // the workload user must not be root, must not have sudo, and must not be able to change routes
      `[ "$(sudo -n -u ${WORKLOAD_USER} id -u)" != 0 ] || exit 51; ` +
      `if sudo -n -u ${WORKLOAD_USER} sudo -n true >/dev/null 2>&1; then exit 52; fi; ` +
      // A successful privileged control proves the exact operation is supported; a missing tool/syntax error is not denial.
      "sudo -n ip route add blackhole 198.51.100.7/32; sudo -n ip route del blackhole 198.51.100.7/32; " +
      `sudo -n -u ${WORKLOAD_USER} ip route show >/dev/null; ` +
      `if denial=$(sudo -n -u ${WORKLOAD_USER} ip route add blackhole 198.51.100.7/32 2>&1); then exit 53; fi; ` +
      'case "$denial" in *"Operation not permitted"*|*"Permission denied"*) ;; *) exit 54 ;; esac; exit 0';
    const du = await this.ctl(["shell", name, "--", "sh", "-c", user], SHORT_TIMEOUT_MS);
    if (du.exit_code !== 0) return fail(`could not set up the unprivileged workload user (exit ${du.exit_code ?? "none"}); refusing to run workloads with guest privileges`);
    const facts: Record<string, string> = {
      vm_type: vmType || "default",
      template: this.opts.template ?? this.env["HANDOFFCHECK_LIMA_TEMPLATE"] ?? "template:alpine",
      mounts: "none (--plain)",
      egress:
        "NOT ENFORCED (PARTIAL, best-effort): default routes were removed at provision time and verified, and workloads run as an unprivileged guest user without sudo that cannot re-add them (verified); this is not a firewall: host-gateway reachability and any guest privilege escalation are not covered",
      workload_user: `${WORKLOAD_USER} (unprivileged; sudo and route changes verified unavailable)`,
      ...(r ? { cpus: String(r.cpus), memory_mb: String(r.memory_mb), disk_mb: String(r.disk_mb) } : {})
    };
    return new LimaSandbox(name, (a, t, sig, max) => this.ctl(a, t, sig, max), req, stage, facts, this.opts.fault ?? null);
  }

  async audit(resources: ResourceRecord[]): Promise<ResourceRecord[]> {
    const out: ResourceRecord[] = [];
    let names: Set<string> | null = null;
    try {
      const res = await this.ctl(["list", "--quiet"], SHORT_TIMEOUT_MS);
      if (res.exit_code === 0 && !res.spawn_error) names = new Set(res.stdout.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    } catch {
      names = null;
    }
    for (const r of resources) {
      if (r.kind === "vm-instance") {
        const home = this.env["LIMA_HOME"] ?? join(this.env["HOME"] ?? tmpdir(), ".lima");
        const dirLeft = existsSync(join(home, r.locator));
        if (names === null) out.push({ ...r, state: "unknown", detail: "limactl list failed" });
        else if (names.has(r.locator) || dirLeft) out.push({ ...r, state: "leaked", detail: names.has(r.locator) ? "VM instance still exists" : "VM instance directory still exists" });
        else out.push({ ...r, state: "removed" });
      } else if (r.kind === "directory") {
        const exists = existsSync(r.locator);
        out.push({ ...r, state: exists ? "leaked" : "removed", ...(exists ? { detail: "host staging directory still exists" } : {}) });
      } else {
        out.push({ ...r, state: "unknown", detail: "resource kind not handled by lima" });
      }
    }
    return out;
  }

  async destroyResources(resources: ResourceRecord[]): Promise<void> {
    if (this.opts.fault === "leak-resource") return;
    for (const r of resources) {
      if (r.kind === "vm-instance" && /^hc-[0-9a-f]{8}-[0-9a-f]{6}$/.test(r.locator)) {
        await this.ctl(["delete", "--force", r.locator], CTL_TIMEOUT_MS).catch(() => undefined);
      } else if (r.kind === "directory" && /\/hcsbx-lima-[^/]+$/.test(r.locator)) {
        rmSync(r.locator, { recursive: true, force: true });
      }
    }
  }
}
