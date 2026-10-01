import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MARK_VAR = "HC_SANDBOX_ID";

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Opaque process start time: (pid, lstart) identifies a process even if the pid is reused. */
  lstart: string;
}

/** `ps` renders lstart in the caller's TZ and locale; pin both so a start time recorded by one shell matches in any other. */
const stableEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" });

function parseTable(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), lstart: m[3] as string });
  }
  return rows;
}

/** Process table (pid, ppid, start time). Null when `ps` cannot run (restricted macOS sandboxes, minimal containers). */
export function psTable(): ProcRow[] | null {
  try {
    return parseTable(execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: stableEnv() }));
  } catch {
    return null;
  }
}

export async function psTableAsync(): Promise<ProcRow[] | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000, env: stableEnv() });
    return parseTable(stdout);
  } catch {
    return null;
  }
}

export function descendantsOf(rows: readonly ProcRow[], rootPid: number): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r]);
  const out: ProcRow[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const cur = queue.pop() as number;
    for (const child of byParent.get(cur) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  const root = rows.find((r) => r.pid === rootPid);
  return root ? [root, ...out] : out;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when `pid` is alive and (when its start time is known and readable) still the same process. */
export function sameProcess(pid: number, lstart: string, table: readonly ProcRow[] | null = psTable()): boolean {
  if (!pidAlive(pid)) return false;
  const row = table?.find((r) => r.pid === pid);
  if (!row) return table === null; // alive but absent from a readable table: gone (zombie reaped); unreadable table: assume same
  return lstart === "" || row.lstart === lstart;
}

/**
 * Pids (other than `selfPid`) whose environment contains `needle`, read from a procfs-style tree.
 * Null when `procRoot` is not a procfs (macOS, minimal containers). `procRoot` is injectable for tests.
 */
export function scanProcEnvironment(needle: string, procRoot: string, selfPid: number): number[] | null {
  if (!existsSync(`${procRoot}/self/environ`)) return null;
  const found: number[] = [];
  for (const name of readdirSync(procRoot).filter((n) => /^\d+$/.test(n) && Number(n) !== selfPid)) {
    try {
      if (readFileSync(`${procRoot}/${name}/environ`, "utf8").split("\0").includes(needle)) found.push(Number(name));
    } catch {
      /* exited or not ours */
    }
  }
  return found;
}

export interface Scan {
  /** pid -> why it was attributed to the sandbox */
  pids: Map<number, string>;
  /** Methods that actually ran. */
  methods: string[];
}

/**
 * Find processes that belong to a sandbox using every method available on this host:
 *  - environment marker HC_SANDBOX_ID (/proc/<pid>/environ, else `ps eww`; macOS hides the environment of
 *    SIP-protected binaries such as /bin/sleep, so this alone is not enough);
 *  - command line match on the sandbox directory name (`pgrep -f`);
 *  - open files and working directories under the sandbox directory (`lsof +D`), only while the directory exists;
 *  - descendants recorded at spawn time (pid + start time), still alive.
 * Returns null only when no method could run, which callers must treat as unknown.
 */
export function scanProcesses(o: { marker: string; dir: string | null; tracked: ReadonlyMap<number, string>; procRoot?: string }): Scan | null {
  const pids = new Map<number, string>();
  const methods: string[] = [];
  const needle = `${MARK_VAR}=${o.marker}`;

  const procRoot = o.procRoot ?? "/proc";
  const procPids = scanProcEnvironment(needle, procRoot, process.pid);
  if (procPids !== null) {
    for (const pid of procPids) pids.set(pid, "environment marker");
    methods.push("proc-environ");
  } else {
    try {
      const out = execFileSync("ps", ["eww", "-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of out.split("\n")) {
        if (!line.includes(needle)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isInteger(pid) && pid !== process.pid) pids.set(pid, "environment marker");
      }
      methods.push("ps-environment");
    } catch {
      /* ps unavailable */
    }
  }
  try {
    const dirName = o.marker.replace(/-[0-9a-f]{12}$/, "");
    const out = execFileSync("pgrep", ["-f", "--", dirName], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.set(pid, "command line");
    }
    methods.push("pgrep-cmdline");
  } catch (e) {
    if ((e as { status?: number }).status === 1) methods.push("pgrep-cmdline"); // exit 1 = no match: a successful empty scan
  }
  if (o.dir !== null && existsSync(o.dir)) {
    try {
      const out = execFileSync("lsof", ["-w", "-F", "p", "+D", realpathSync(o.dir)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of out.split("\n")) {
        const m = /^p(\d+)$/.exec(line);
        if (m && Number(m[1]) !== process.pid) pids.set(Number(m[1]), "open file or working directory in the sandbox");
      }
      methods.push("lsof-open-files");
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      if (err.status === 1) {
        for (const line of (err.stdout ?? "").split("\n")) {
          const m = /^p(\d+)$/.exec(line);
          if (m && Number(m[1]) !== process.pid) pids.set(Number(m[1]), "open file or working directory in the sandbox");
        }
        methods.push("lsof-open-files");
      }
    }
  }
  if (o.tracked.size > 0) {
    const table = psTable();
    for (const [pid, lstart] of o.tracked) if (sameProcess(pid, lstart, table)) pids.set(pid, "descendant of a sandbox script");
    methods.push("spawn-descendants");
  }
  return methods.length === 0 ? null : { pids, methods };
}
