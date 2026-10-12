import { spawn } from "node:child_process";

export interface CommandOptions {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  /** Grace between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Wait this long after exit for pipes held open by background children, then stop reading. */
  closeGraceMs?: number;
}

export interface CommandResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  aborted: boolean;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  spawn_error: string | null;
}

class Capture {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }
  value(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Run a command in its own process group with a hard timeout, abort support and capped output capture. */
export function runCommand(o: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const out = new Capture(o.maxOutputBytes);
    const err = new Capture(o.maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let exited = false;
    let child: ReturnType<typeof spawn> | null = null;
    const timers: NodeJS.Timeout[] = [];

    function killGroup(sig: NodeJS.Signals): void {
      if (!child || child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    }

    const finish = (spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      if (timedOut || aborted) killGroup("SIGKILL");
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({
        exit_code: exitCode,
        signal: exitSignal,
        timed_out: timedOut,
        aborted,
        stdout: out.value(),
        stderr: err.value(),
        truncated: out.truncated || err.truncated,
        spawn_error: spawnError
      });
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(o.file, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish((e as Error).message);
      return;
    }
    child = proc;
    function terminate(): void {
      killGroup("SIGTERM");
      timers.push(setTimeout(() => killGroup("SIGKILL"), o.killGraceMs ?? 2000));
    }
    function onAbort(): void {
      aborted = true;
      terminate();
    }

    proc.stdout?.on("data", (c: Buffer) => out.push(c));
    proc.stderr?.on("data", (c: Buffer) => err.push(c));
    proc.on("error", (e) => finish(e.message));
    proc.on("exit", (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      timers.push(
        setTimeout(() => {
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          finish(null);
        }, o.closeGraceMs ?? 300)
      );
    });
    proc.on("close", () => finish(null));

    if (proc.pid !== undefined) o.onSpawn?.(proc.pid);
    timers.push(
      setTimeout(() => {
        if (exited) return;
        timedOut = true;
        terminate();
      }, Math.max(1, o.timeoutMs))
    );
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
