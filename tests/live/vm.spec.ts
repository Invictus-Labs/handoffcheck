// LIVE VM drills against a REAL Lima instance (isolation "vm"). Opt-in only: set HC_LIVE_VM=1 and have a real
// `limactl` (Lima 2.x) on PATH or HANDOFFCHECK_LIMACTL. Without both, every test here is reported as
// "BLOCKED: ..." (skipped with that note) and nothing is mocked. The guest is a minimal Alpine image: the drill
// scripts are pure POSIX sh (fixtures/drill-sh + fixtures/release-sh). Boot of each VM takes minutes.
//
// Run:  HC_LIVE_VM=1 npx vitest run tests/live/vm.spec.ts
// Titles deliberately avoid the words "negative control" so the gate's non-live negative-control count is unaffected.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { findLimactl } from "../../src/runner/lima.js";
import { makeCtx, sh } from "../helpers/drill.js";
import { expectRed, runDrill, stepLogs, stepOf } from "../helpers/run.js";
import { registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const limactl = findLimactl(process.env);
const LIVE = process.env.HC_LIVE_VM === "1" && limactl !== null;
const blockedNote = `BLOCKED: live VM drill not run (${limactl === null ? "limactl not found" : "HC_LIVE_VM is not 1"}); never reported as PASS`;
const LIVE_TIMEOUT = 20 * 60 * 1000;

const listInstances = (): string[] => {
  if (!limactl) return [];
  try {
    return execFileSync(limactl, ["list", "--quiet"], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((l) => l.trim())
      .filter((n) => n.startsWith("hc-"));
  } catch {
    return [];
  }
};

/** Name of the VM instance a run provisioned, from its cleanup receipt (never guess: other Lima VMs may exist). */
const vmNameOf = async (apiCtx: api.ApiContext, runId: string): Promise<string> => {
  const report = await api.getReport(apiCtx, { runId });
  const vm = report.cleanup.resources.find((r) => r.kind === "vm-instance");
  if (!vm) throw new Error("no vm-instance resource on the cleanup receipt");
  return vm.id.replace(/^vm-instance:/, "");
};

/**
 * With HC_LIVE_RECEIPT_DIR set (scripts/live-receipt.sh does), keep the raw, already redacted record of each live run:
 * the full report JSON and every step log, so the live rows rest on preserved evidence and not on a summary.
 */
const preserve = async (name: string, apiCtx: api.ApiContext, runId: string): Promise<void> => {
  const dir = process.env.HC_LIVE_RECEIPT_DIR;
  if (!dir) return;
  const out = join(dir, name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), `${JSON.stringify(await api.getReport(apiCtx, { runId }), null, 2)}\n`);
  for (const l of await stepLogs(apiCtx, runId)) writeFileSync(join(out, `step-log-${l.step_key ?? "run"}-${sha8(l.text)}.txt`), l.text);
};
const sha8 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

const liveDrill = async (name: string, opts: Parameters<typeof runDrill>[0] = {}, over: Parameters<typeof runDrill>[1] = {}) => {
  const executed = await runDrill({ variant: "sh", ...opts }, { ...over, ctx: { env: { ...process.env, PATH: process.env.PATH ?? "" } as Record<string, string>, ...(over.ctx ?? {}) } });
  await preserve(name, executed.ctx, executed.result.run_id);
  return executed;
};

describe("live VM drills (real Lima instance)", () => {
  it("live VM: a clean POSIX-sh drill passes every step on isolation vm, cleanup is verified and no VM is left behind", async (ctx) => {
    if (!LIVE) return ctx.skip(blockedNote);
    const { result, ctx: apiCtx } = await liveDrill("clean-drill");
    expect(result.provider).toBe("lima");
    expect(result.isolation).toBe("vm");
    expect(result.steps.map((s) => `${s.step_key}:${s.status}`), JSON.stringify(result.steps)).toEqual(["install:PASS", "restore:PASS", "rotate:PASS", "recover:PASS"]);
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(result.verdict.verdict).toBe("REHEARSAL"); // automated operator: a rehearsal, even on a VM
    expect(result.verdict.human_receipt).toBe("PENDING_HUMAN_RECEIPT");
    expect(listInstances()).not.toContain(await vmNameOf(apiCtx, result.run_id));
    const report = await api.getReport(apiCtx, { runId: result.run_id });
    expect(report.run.isolation).toBe("vm");
    expect(report.run.labels.join(" ").toLowerCase()).toMatch(/egress/);
    // the report must not claim more than the provider does: egress is best effort and NOT ENFORCED
    expect(report.run.labels.join(" ")).toMatch(/NOT ENFORCED/);
    expect(report.run.labels.join(" ")).not.toMatch(/blocked and verified|deny-all/i);
    expect(report.cleanup.resources.map((r) => r.kind).sort()).toEqual(["directory", "vm-instance"]);
  }, LIVE_TIMEOUT);

  it("live VM: the workload runs unprivileged: not root, no sudo, and it cannot put a route back or add a default one", async (ctx) => {
    if (!LIVE) return ctx.skip(blockedNote);
    // Addresses are computed at run time because the static preflight reads explicit inputs; what matters is what the guest allows.
    const probe = sh(
      [
        "GW=192.168.$((2+3)).2; PUB=198.51.$((50+50)).9",
        "id -un; id -u",
        "sudo -n true >/dev/null 2>&1 && echo SUDO_OK || echo SUDO_DENIED",
        'sudo -n ip route add default via "$GW" >/dev/null 2>&1 && echo ROUTE_ADDED || echo ROUTE_ADD_SUDO_DENIED',
        'ip route add default via "$GW" >/dev/null 2>&1 && echo ROUTE_ADDED || echo ROUTE_ADD_DIRECT_DENIED',
        'nc -z -w 3 "$PUB" 53 >/dev/null 2>&1 && echo PUBLIC_CONNECT_OK || echo PUBLIC_CONNECT_FAILED',
        'sh "$HC_RELEASE/bin/notes.sh" install'
      ].join("\n")
    ).replace('NODE="${HC_NODE:-node}"\n', "").replace('SVC="$HC_RELEASE/bin/notes.mjs"', 'SVC="$HC_RELEASE/bin/notes.sh"');
    const { result, ctx: apiCtx } = await liveDrill("unprivileged-workload", { scripts: { "install.sh": probe } });
    expect(stepOf(result, "install").status, JSON.stringify(result.steps)).toBe("PASS");
    const log = (await stepLogs(apiCtx, result.run_id)).filter((l) => l.step_key === "install" && /^# install:script stdout/m.test(l.text)).map((l) => l.text).join("\n");
    for (const expected of ["hcrun", "SUDO_DENIED", "ROUTE_ADD_SUDO_DENIED", "ROUTE_ADD_DIRECT_DENIED", "PUBLIC_CONNECT_FAILED"]) expect(log, expected).toContain(expected);
    for (const forbidden of ["SUDO_OK", "ROUTE_ADDED", "PUBLIC_CONNECT_OK"]) expect(log, forbidden).not.toContain(forbidden);
    expect(log).not.toMatch(/^0$/m); // uid 0 would be root
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(listInstances()).not.toContain(await vmNameOf(apiCtx, result.run_id));
  }, LIVE_TIMEOUT);

  it("live VM: a seeded failing recovery turns the VM drill red and the instance is still deleted", async (ctx) => {
    if (!LIVE) return ctx.skip(blockedNote);
    const { result, ctx: apiCtx } = await liveDrill("seeded-failing-recovery", {
      scripts: { "recover.sh": "#!/bin/sh\ntrue\n" },
      manifest: (m) => {
        m.steps[3].deadline_seconds = 20;
        m.steps[3].max_recovery_seconds = 10;
      }
    });
    expectRed(result);
    expect(stepOf(result, "recover").reason_code).toBe("RECOVERY_NOT_RESTORED");
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(listInstances()).not.toContain(await vmNameOf(apiCtx, result.run_id));
  }, LIVE_TIMEOUT);

  it("live VM: the guest has no internet egress: an install script that tries to reach a public host fails inside the VM", async (ctx) => {
    if (!LIVE) return ctx.skip(blockedNote);
    // The static preflight only reads explicit inputs, so the URL is assembled at run time here on purpose: the point
    // of this test is that the VM enforces egress at run time even when a script hides its destination.
    const probe = sh(
      'h=exam; h="${h}ple.org"; s=ht; s="${s}tp"\nif wget -q -T 5 -O /dev/null "${s}://${h}/" 2>/dev/null; then echo "egress open" >&2; exit 7; fi\necho "egress blocked as expected"\nsh "$HC_RELEASE/bin/notes.sh" install'
    ).replace('NODE="${HC_NODE:-node}"\n', "").replace('SVC="$HC_RELEASE/bin/notes.mjs"', 'SVC="$HC_RELEASE/bin/notes.sh"');
    const { result, ctx: apiCtx } = await liveDrill("run-time-egress-block", { scripts: { "install.sh": probe } });
    expect(stepOf(result, "install").status, JSON.stringify(result.steps)).toBe("PASS");
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(listInstances()).not.toContain(await vmNameOf(apiCtx, result.run_id));
  }, LIVE_TIMEOUT);

  it("live VM: a leaked VM is reported CLEANUP_UNCONFIRMED (exit 1) and removed by a later cleanup retry", async (ctx) => {
    if (!LIVE) return ctx.skip(blockedNote);
    const env = { ...process.env, PATH: process.env.PATH ?? "", HANDOFFCHECK_TEST_FAULT: "leak-resource" } as Record<string, string>;
    const { result, ctx: apiCtx } = await liveDrill("leaked-vm", {}, { ctx: { env } });
    const vm = await vmNameOf(apiCtx, result.run_id);
    try {
      expect(result.steps.every((s) => s.status === "PASS")).toBe(true);
      expectRed(result);
      expect(result.cleanup.status).toBe("UNCONFIRMED");
      expect(listInstances()).toContain(vm);
      const healed = await api.cleanup(makeCtx({ storeDir: apiCtx.storeDir, env: { ...process.env, PATH: process.env.PATH ?? "" } as Record<string, string> }), { runId: result.run_id });
      expect(healed.receipt.status).toBe("VERIFIED");
      expect(listInstances()).not.toContain(vm);
    } finally {
      // never leave the deliberately leaked VM behind, whatever happened above
      if (limactl && listInstances().includes(vm)) execFileSync(limactl, ["delete", "--force", vm], { stdio: "ignore", env: process.env });
    }
  }, LIVE_TIMEOUT);

  it("live VM: an abort kills the drill, ends ABORTED and verifies the VM is gone", async (ctx) => {
    if (!LIVE) return ctx.skip(blockedNote);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 90_000);
    const { result, ctx: apiCtx } = await liveDrill("abort", { scripts: { "install.sh": "#!/bin/sh\nsleep 600\n" } }, { signal: controller.signal });
    expectRed(result);
    expect(["ABORTED", "FAILED"]).toContain(result.outcome);
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(listInstances()).not.toContain(await vmNameOf(apiCtx, result.run_id).catch(() => "no-vm-was-provisioned"));
  }, LIVE_TIMEOUT);
});

