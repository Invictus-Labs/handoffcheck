// Direct tests for the local-sandbox provider (src/runner/local-sandbox.ts): provisioning rules, script execution
// limits, file reads, resource inventory, the independent audit and the cleanup retry. isolation=none: synthetic only.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProvisionRequest, ResourceRecord } from "../../src/api.js";
import { LocalSandboxProvider } from "../../src/runner/local-sandbox.js";
import { MARK_VAR } from "../../src/runner/procscan.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const baseReq = (over: Partial<ProvisionRequest> = {}): ProvisionRequest => ({
  run_id: "run-localsbx-0001",
  limits: { wall_seconds: 30, max_output_bytes: 4096 },
  env: { CUSTOM_VAR: "custom" },
  artifact: { entries: [{ path: "data/a.txt", type: "file", mode: 0o644, data: Buffer.from("hello") }] },
  scripts: [
    { path: "echo.sh", bytes: Buffer.from('#!/bin/sh\necho "step=$HC_STEP iso=$HC_ISOLATION custom=$CUSTOM_VAR extra=${EXTRA:-none} args=$*"\necho "mark=${HC_SANDBOX_ID:+set}"\npwd\n') },
    { path: "node.mjs", bytes: Buffer.from('console.log("node ran", process.argv.slice(2).join(","));\n') },
    { path: "bash.sh", bytes: Buffer.from('#!/bin/bash\necho "bash ${BASH_VERSION:+yes}"\n') },
    { path: "slow.sh", bytes: Buffer.from("#!/bin/sh\nsleep 30\n") },
    { path: "loud.sh", bytes: Buffer.from('#!/bin/sh\nhead -c 100000 /dev/zero | tr "\\0" "A"\n') },
    { path: "fail.sh", bytes: Buffer.from("#!/bin/sh\nexit 7\n") }
  ],
  synthetic: true,
  ...over
});

const provider = (fault?: "leak-resource" | "leak-process") => new LocalSandboxProvider({ baseDir: makeTmp("hc-lsb-"), ...(fault ? { fault } : {}) });
const text = (b: Uint8Array): string => Buffer.from(b).toString("utf8");

describe("local-sandbox: provisioning", () => {
  it("is available on a POSIX host and refuses non-synthetic scenarios", async () => {
    const p = provider();
    expect(await p.probe()).toMatchObject({ available: true });
    await expect(p.provision(baseReq({ synthetic: false }))).rejects.toThrow(/non-synthetic/);
  });

  it("stages files, directories and in-root symlinks owner-only, scripts read-only, and labels the sandbox isolation none", async () => {
    const p = provider();
    const sb = await p.provision(
      baseReq({
        artifact: {
          entries: [
            { path: "d1", type: "directory", mode: 0o755 },
            { path: "d1/f.txt", type: "file", mode: 0o755, data: Buffer.from("x") },
            { path: "d1/link", type: "symlink", mode: 0o777, linkname: "f.txt" }
          ]
        }
      })
    );
    expect(sb.isolation).toBe("none");
    expect(sb.provider).toBe("local-sandbox");
    const dir = sb.resources().find((r) => r.kind === "directory")!.locator;
    expect(lstatSync(join(dir, "release", "d1")).isDirectory()).toBe(true);
    expect(lstatSync(join(dir, "release", "d1", "link")).isSymbolicLink()).toBe(true);
    expect(lstatSync(dir).mode & 0o077).toBe(0);
    expect(lstatSync(join(dir, "scripts", "echo.sh")).mode & 0o222).toBe(0);
    await sb.destroy();
    expect(existsSync(dir)).toBe(false);
  });

  it("negative control: unsafe artifact or script paths, and entries below a symlink, are refused and leave no directory behind", async () => {
    const base = makeTmp("hc-lsb-");
    const p = new LocalSandboxProvider({ baseDir: base });
    const entries = [
      [{ path: "../escape", type: "file" as const, mode: 0o644, data: Buffer.from("x") }],
      [{ path: "lnk", type: "symlink" as const, mode: 0o777, linkname: "d" }, { path: "lnk/inside", type: "file" as const, mode: 0o644, data: Buffer.from("x") }]
    ];
    for (const e of entries) await expect(p.provision(baseReq({ artifact: { entries: e } }))).rejects.toThrow();
    await expect(p.provision(baseReq({ scripts: [{ path: "../bad.sh", bytes: Buffer.from("x") }] }))).rejects.toThrow(/unsafe script path/);
    expect(existsSync(join(base)) ? (await import("node:fs")).readdirSync(base) : []).toEqual([]);
  });
});

describe("local-sandbox: exec and readFile", () => {
  it("runs scripts with a scrubbed environment, the declared extras and the sandbox marker, in the release directory", async () => {
    const sb = await provider().provision(baseReq());
    const r = await sb.exec({ script: { path: "echo.sh", args: ["a", "b"] }, label: "install:script", timeout_ms: 10_000, extra_env: { EXTRA: "yes", HC_STEP: "install" } });
    expect(r.exit_code).toBe(0);
    const out = text(r.stdout);
    expect(out).toContain("step=install iso=none custom=custom extra=yes args=a b");
    expect(out).toContain("mark=set");
    expect(out.trim().split("\n").at(-1)).toMatch(/\/release$/);
    expect(text((await sb.exec({ script: { path: "echo.sh" }, label: "rotate:script", timeout_ms: 10_000 })).stdout)).toContain("step=rotate");
    await sb.destroy();
  });

  it("runs node and bash interpreters, reports a failing exit code and caps output", async () => {
    const sb = await provider().provision(baseReq());
    expect(text((await sb.exec({ script: { path: "node.mjs", interpreter: "node", args: ["x", "y"] }, label: "s", timeout_ms: 10_000 })).stdout)).toContain("node ran x,y");
    expect(text((await sb.exec({ script: { path: "bash.sh", interpreter: "bash" }, label: "s", timeout_ms: 10_000 })).stdout)).toContain("bash yes");
    expect((await sb.exec({ script: { path: "fail.sh" }, label: "s", timeout_ms: 10_000 })).exit_code).toBe(7);
    const loud = await sb.exec({ script: { path: "loud.sh" }, label: "s", timeout_ms: 10_000 });
    expect(loud.truncated).toBe(true);
    expect(loud.stdout.length).toBeLessThanOrEqual(4096 + 1024);
    await sb.destroy();
  });

  it("negative control: a hanging script is killed at its timeout, an abort kills it, and unstaged scripts, unknown interpreters and a destroyed sandbox cannot run", async () => {
    const sb = await provider().provision(baseReq());
    const slow = await sb.exec({ script: { path: "slow.sh" }, label: "s", timeout_ms: 1000 });
    expect(slow.timed_out).toBe(true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const aborted = await sb.exec({ script: { path: "slow.sh" }, label: "s", timeout_ms: 20_000, signal: controller.signal });
    expect(aborted.aborted).toBe(true);
    expect(text((await sb.exec({ script: { path: "nope.sh" }, label: "s", timeout_ms: 1000 })).stderr)).toMatch(/not staged/);
    expect(text((await sb.exec({ script: { path: "../x.sh" }, label: "s", timeout_ms: 1000 })).stderr)).toMatch(/not staged/);
    expect(text((await sb.exec({ script: { path: "echo.sh", interpreter: "perl" as never }, label: "s", timeout_ms: 1000 })).stderr)).toMatch(/interpreter unavailable/);
    await sb.destroy();
    expect(text((await sb.exec({ script: { path: "echo.sh" }, label: "s", timeout_ms: 1000 })).stderr)).toMatch(/already destroyed/);
  }, 60_000);

  it("reads sandbox files within bounds and refuses unsafe paths, symlinks, directories, missing files and oversize files", async () => {
    const sb = await provider().provision(baseReq({ artifact: { entries: [{ path: "data/a.txt", type: "file", mode: 0o644, data: Buffer.from("hello") }, { path: "lnk", type: "symlink", mode: 0o777, linkname: "data" }] } }));
    expect(text((await sb.readFile("release/data/a.txt", 100)) ?? new Uint8Array())).toBe("hello");
    expect(await sb.readFile("release/data/a.txt", 2)).toBeNull();
    expect(await sb.readFile("release/data", 100)).toBeNull();
    expect(await sb.readFile("release/missing", 100)).toBeNull();
    expect(await sb.readFile("../etc/passwd", 100)).toBeNull();
    expect(await sb.readFile("/etc/passwd", 100)).toBeNull();
    expect(await sb.readFile("release/lnk/a.txt", 100)).toBeNull();
    await sb.destroy();
  });
});

describe("local-sandbox: inventory, audit and cleanup retry", () => {
  it("inventories the directory, live process groups and a process scan, and a clean destroy audits as removed", async () => {
    const p = provider();
    const sb = await p.provision(baseReq());
    const running = sb.exec({ script: { path: "slow.sh" }, label: "s", timeout_ms: 30_000 });
    await new Promise((r) => setTimeout(r, 600));
    const kinds = sb.resources().map((r) => r.kind);
    expect(kinds).toContain("directory");
    expect(kinds).toContain("process-scan");
    expect(kinds).toContain("process");
    await sb.destroy();
    await running;
    const audited = await p.audit(sb.resources());
    expect(audited.every((r) => r.state === "removed")).toBe(true);
  }, 60_000);

  it("negative control: audit reports leaked and unknown resources and destroyResources only removes sandbox directories it created", async () => {
    const p = provider("leak-resource");
    const sb = await p.provision(baseReq());
    await sb.destroy(); // fault: the directory is deliberately left behind
    const resources = sb.resources();
    const dir = resources.find((r) => r.kind === "directory")!;
    const audited = await p.audit([...resources, { kind: "vm-instance", id: "v", locator: "x", state: "unknown" } as ResourceRecord, { kind: "process", id: "p", locator: "pgid:not-a-number", state: "unknown" }, { kind: "process", id: "q", locator: "pid:not:valid", state: "unknown" }]);
    expect(audited.find((r) => r.kind === "directory")?.state).toBe("leaked");
    expect(audited.find((r) => r.kind === "vm-instance")?.state).toBe("unknown");
    expect(audited.find((r) => r.id === "p")?.state).toBe("removed");
    expect(audited.find((r) => r.id === "q")?.state).toBe("removed");
    // a path that is not a sandbox directory is never removed
    const victim = join(makeTmp("hc-victim-"), "keep-me");
    mkdirSync(victim);
    await provider().destroyResources([{ kind: "directory", id: "d", locator: victim, state: "leaked" }]);
    expect(existsSync(victim)).toBe(true);
    // a symlink named like a sandbox directory is not followed
    const target = makeTmp("hc-target-");
    writeFileSync(join(target, "precious"), "x");
    const link = join(makeTmp("hc-lnk-"), "hcsbx-evil");
    symlinkSync(target, link);
    await provider().destroyResources([{ kind: "directory", id: "d", locator: link, state: "leaked" }]);
    expect(existsSync(join(target, "precious"))).toBe(true);
    // the genuine leaked sandbox directory is removed by the retry
    await p.destroyResources(resources); // the same provider still has the fault set: the retry stays leaked
    expect(existsSync(dir.locator)).toBe(true);
    await provider().destroyResources(resources);
    expect(existsSync(dir.locator)).toBe(false);
    expect((await p.audit([dir])).at(0)?.state).toBe("removed");
  });

  it("negative control: with the leak-process fault a running process survives destroy, the audit finds it, and a retry kills it", async () => {
    const p = provider("leak-process");
    const sb = await p.provision(baseReq());
    const running = sb.exec({ script: { path: "slow.sh" }, label: "s", timeout_ms: 30_000 });
    await new Promise((r) => setTimeout(r, 700));
    await sb.destroy();
    const inventory = sb.resources();
    const audited = await p.audit(inventory);
    expect(audited.some((r) => r.state === "leaked")).toBe(true);
    await provider().destroyResources(inventory); // retry without the fault kills what is left
    await running;
    const after = await provider().audit(inventory.filter((r) => r.kind !== "directory"));
    expect(after.every((r) => r.state !== "leaked")).toBe(true);
  }, 60_000);

  it("a process that escapes the process group but keeps the sandbox marker is found by the scan audit and killed on retry", async () => {
    const p = provider();
    const sb = await p.provision(baseReq());
    const dir = sb.resources().find((r) => r.kind === "directory")!.locator;
    const marker = sb.resources().find((r) => r.kind === "process-scan")!.locator.replace("marker:", "");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: dir, env: { PATH: process.env.PATH ?? "", [MARK_VAR]: marker }, stdio: "ignore", detached: true });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const audited = await p.audit([{ kind: "process-scan", id: "s", locator: `marker:${marker}`, state: "unknown" }]);
      expect(audited[0]?.state).toBe("leaked");
      await p.destroyResources([{ kind: "process-scan", id: "s", locator: `marker:${marker}`, state: "leaked" }]);
      await new Promise((r) => setTimeout(r, 500));
      const again = await p.audit([{ kind: "process-scan", id: "s", locator: `marker:${marker}`, state: "unknown" }]);
      expect(again[0]?.state).toBe("removed");
    } finally {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        /* gone */
      }
      await sb.destroy();
    }
  }, 60_000);
});
