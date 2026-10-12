// Unit tests for process detection used by the local-sandbox cleanup audit (src/runner/procscan.ts).
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MARK_VAR, descendantsOf, pidAlive, psTable, psTableAsync, sameProcess, scanProcesses, type ProcRow } from "../../src/runner/procscan.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const row = (pid: number, ppid: number, lstart = "t"): ProcRow => ({ pid, ppid, lstart });

describe("process tree helpers", () => {
  it("collects a root and all of its descendants, ignores unrelated processes and terminates on a malformed table", () => {
    const rows = [row(10, 1), row(11, 10), row(12, 11), row(13, 10), row(20, 1), row(21, 20), row(30, 31), row(31, 30)];
    expect(descendantsOf(rows, 10).map((r) => r.pid).sort()).toEqual([10, 11, 12, 13]);
    expect(descendantsOf(rows, 20).map((r) => r.pid).sort()).toEqual([20, 21]);
    expect([...new Set(descendantsOf(rows, 30).map((r) => r.pid))].sort()).toEqual([30, 31]); // a cycle cannot occur in a real table; it must still terminate
    expect(descendantsOf(rows, 999)).toEqual([]);
    expect(descendantsOf([row(5, 4)], 4).map((r) => r.pid)).toEqual([5]);
  });

  it("reports liveness and identity: a pid reused by a different process is not the same process", async () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
    const table = psTable();
    const mine = table?.find((r) => r.pid === process.pid);
    expect(mine, "ps lists this process").toBeDefined();
    expect(sameProcess(process.pid, mine!.lstart, table)).toBe(true);
    expect(sameProcess(process.pid, "Thu Jan  1 00:00:00 1970", table)).toBe(false);
    expect(sameProcess(process.pid, "")).toBe(true);
    expect(sameProcess(2 ** 22 + 12345, "x", table)).toBe(false);
    expect(sameProcess(process.pid, "anything", null)).toBe(true); // unreadable table: assume the same, do not claim it is gone
    expect(sameProcess(process.pid, "x", [])).toBe(false); // alive but absent from a readable table: gone
    const asyncTable = await psTableAsync();
    expect(asyncTable?.some((r) => r.pid === process.pid)).toBe(true);
  });
});

describe("scanProcesses", () => {
  const live = (dir: string, marker: string) =>
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: dir, env: { PATH: process.env.PATH ?? "", [MARK_VAR]: marker }, stdio: "ignore", detached: true });

  it("finds a process by its environment marker, its working directory and spawn-time tracking, and nothing for an unused marker", async () => {
    const dir = makeTmp("hc-scan-");
    const marker = `hcsbx-unit-${Date.now().toString(16)}-aaaaaaaaaaaa`;
    const child = live(dir, marker);
    try {
      await new Promise((r) => setTimeout(r, 400));
      const pid = child.pid as number;
      const lstart = psTable()?.find((r) => r.pid === pid)?.lstart ?? "";
      const scan = scanProcesses({ marker, dir, tracked: new Map([[pid, lstart]]) });
      expect(scan, "at least one detection method must run on this host").not.toBeNull();
      expect(scan!.methods.length).toBeGreaterThan(0);
      expect(scan!.pids.has(pid)).toBe(true);
      const none = scanProcesses({ marker: "hcsbx-unit-never-seen-000000000000", dir: null, tracked: new Map() });
      expect(none?.pids.size ?? 0).toBe(0);
    } finally {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  });

  it("negative control: a tracked process that has exited is not reported as a leak", () => {
    const scan = scanProcesses({ marker: "hcsbx-unit-gone-000000000000", dir: null, tracked: new Map([[2 ** 22 + 99, "x"]]) });
    expect(scan?.pids.has(2 ** 22 + 99) ?? false).toBe(false);
  });
});
