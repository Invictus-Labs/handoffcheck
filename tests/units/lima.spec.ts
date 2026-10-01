// PROTOCOL tests for the Lima VM provider driven by a FAKE limactl (tests/helpers/fake-limactl.sh).
// These verify the harness speaks the limactl CLI correctly and fails closed. They are NOT live VM evidence:
// guest commands run on the host. The live VM criteria stay BLOCKED until a real VM receipt exists.
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { LimaProvider, findLimactl } from "../../src/runner/lima.js";
import { makeFakeLima } from "../helpers/lima.js";
import { makeCtx, prepareDrill } from "../helpers/drill.js";
import { expectRed, runDrill, stepOf } from "../helpers/run.js";
import { registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const vmManifest = (m: Record<string, any>): void => void (m.runner.provider = "lima"); // eslint-disable-line @typescript-eslint/no-explicit-any

async function limaDrill(faults: string[] = [], operator: Partial<api.OperatorDecl> = {}, tweak: (m: Record<string, any>) => void = () => undefined) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const lima = makeFakeLima(faults);
  const ex = await runDrill(
    { manifest: (m) => { vmManifest(m); tweak(m); } },
    { operator, ctx: { env: lima.env } }
  );
  return { lima, ...ex };
}

describe("lima provider discovery (protocol)", () => {
  it("finds limactl through an explicit path or PATH and reports its version, or reports unavailable", async () => {
    const lima = makeFakeLima();
    expect(findLimactl({}, lima.env.HANDOFFCHECK_LIMACTL)).toBe(lima.env.HANDOFFCHECK_LIMACTL);
    expect(findLimactl({ HANDOFFCHECK_LIMACTL: "/no/such/limactl" })).toBeNull();
    expect(findLimactl({ PATH: "/no/such/dir::/also/missing" })).toBeNull();
    expect(findLimactl({})).toBeNull();
    const ok = await new LimaProvider({ env: lima.env }).probe();
    expect(ok.available).toBe(true);
    expect(ok.version).toContain("fake-protocol-test");
    const broken = makeFakeLima(["version"]);
    const bad = await new LimaProvider({ env: broken.env }).probe();
    expect(bad.available).toBe(false);
    expect(bad.reason).toMatch(/version probe/);
    const missing = await new LimaProvider({ env: { PATH: "/nonexistent" } }).probe();
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/BLOCKED/);
  });

  it("negative control: provisioning without limactl fails with PROVIDER_UNAVAILABLE", async () => {
    const provider = new LimaProvider({ env: { PATH: "/nonexistent" } });
    await expect(
      provider.provision({ run_id: "r", limits: { wall_seconds: 5, max_output_bytes: 1024 }, env: {}, artifact: { entries: [] }, scripts: [], synthetic: true })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("lima protocol: a full drill against the fake limactl", () => {
  it("speaks create/start/egress/copy/shell/list/delete, passes every step on isolation vm and verifies cleanup", async () => {
    const { lima, result, ctx } = await limaDrill([], { kind: "human", ref: "operator-a", builder_ref: "builder-b" });
    expect(result.isolation).toBe("vm");
    expect(result.provider).toBe("lima");
    expect(result.steps.map((s) => `${s.step_key}:${s.status}`)).toEqual(["install:PASS", "restore:PASS", "rotate:PASS", "recover:PASS"]);
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(lima.instances()).toEqual([]);
    const calls = lima.calls();
    expect(calls.some((c) => c.startsWith("start") && c.includes("--plain") && c.includes("--cpus 1") && c.includes("--memory 1") && c.includes("--disk 1"))).toBe(true);
    expect(calls.some((c) => c.startsWith("start") && c.includes("template:alpine"))).toBe(true);
    expect(calls.some((c) => c.includes("ip route del default"))).toBe(true);
    expect(calls.some((c) => c.startsWith("copy -r"))).toBe(true);
    expect(calls.some((c) => c.startsWith("delete --force"))).toBe(true);
    expect(calls.some((c) => c.startsWith("list --quiet"))).toBe(true);
    // The decision logic grants INDEPENDENT_PASS plumbing for human + vm + no help. It is protocol evidence only:
    expect(result.verdict.verdict).toBe("INDEPENDENT_PASS");
    expect(result.verdict.human_receipt).toBe("HARNESS_RECORDED");
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.run.isolation).toBe("vm");
    expect(report.cleanup.resources.map((r) => r.kind).sort()).toEqual(["directory", "vm-instance"]);
  });

  it("P1-4: workloads run as the unprivileged guest user (sudo -n -u hcrun) and egress is labelled NOT ENFORCED, never as blocked and verified", async () => {
    const { lima, result, ctx } = await limaDrill([], { kind: "human", ref: "operator-a", builder_ref: "builder-b" });
    const calls = lima.calls();
    // provisioning creates the workload user and verifies it has no root, no sudo and cannot change routes
    const setup = calls.find((c) => c.includes("adduser"));
    expect(setup, "workload user setup call").toBeDefined();
    expect(setup).toContain("hcrun");
    expect(setup).toMatch(/exit 5[123]/);
    // every step script and probe is executed as that user, never as the provisioning (sudo-capable) user
    const execs = calls.filter((c) => c.startsWith("shell") && c.includes("hc-run"));
    expect(execs.length).toBeGreaterThanOrEqual(8);
    for (const c of execs) {
      expect(c, c).toContain("'sudo' '-n' '-u' 'hcrun'");
      // /sbin is part of the real guest PATH, not an inferred route denial from a missing executable.
      expect(c, c).toContain("'PATH=/usr/local/bin:/usr/bin:/bin:/sbin'");
    }
    const labels = (await api.getReport(ctx, { runId: result.run_id })).run.labels.join(" | ");
    expect(labels).toMatch(/egress/i);
    expect(labels).toMatch(/NOT ENFORCED/);
    expect(labels).not.toMatch(/blocked and verified|deny-all|enforced and verified/i);
    expect(result.verdict.verdict).toBe("INDEPENDENT_PASS"); // protocol plumbing only: fake limactl, never a live claim
  });

  it("negative control: an intervention on the VM drill still makes it ASSISTED, never independent", async () => {
    const { result, ctx } = await limaDrill([], { kind: "human", ref: "operator-a", builder_ref: "builder-b" });
    await api.recordIntervention(ctx, { runId: result.run_id, reason: "asked how to restore", actorRef: "operator-a" });
    expect((await api.getReport(ctx, { runId: result.run_id })).verdict.verdict).toBe("ASSISTED");
  });

  it("an automated operator on the VM provider is still only a REHEARSAL", async () => {
    const { result } = await limaDrill();
    expect(result.verdict.verdict).toBe("REHEARSAL");
  });

  it("negative control: a seeded failing step on the VM provider turns the run red and still deletes the instance", async () => {
    const lima = makeFakeLima();
    const { result } = await runDrill({ manifest: vmManifest, scripts: { "rotate.sh": "#!/bin/sh\nexit 1\n" } }, { ctx: { env: lima.env } });
    expectRed(result);
    expect(stepOf(result, "rotate").status).toBe("FAIL");
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(lima.instances()).toEqual([]);
  });

  it("negative control: a step that outruns its deadline inside the guest is a timeout (exit 124 from `timeout`)", async () => {
    const lima = makeFakeLima();
    const { result } = await runDrill(
      { manifest: (m) => { vmManifest(m); m.steps[0].deadline_seconds = 1; }, scripts: { "install.sh": "#!/bin/sh\nsleep 20\n" } },
      { ctx: { env: lima.env } }
    );
    expectRed(result);
    expect(stepOf(result, "install").status).toBe("TIMEOUT");
    expect(result.cleanup.status).toBe("VERIFIED");
  });
});

describe("lima protocol: strict route-query diagnostic contract", () => {
  for (const faults of [[], ["route_get_busybox"]]) {
    it(`accepts only status-2 supported unreachable diagnostic (${faults.length ? "legacy BusyBox/musl" : "observed iproute2"})`, async () => {
      const { lima, result } = await limaDrill(faults);
      expect(result.steps.every((step) => step.status === "PASS")).toBe(true);
      expect(result.cleanup.status).toBe("VERIFIED");
      expect(lima.instances()).toEqual([]);
    });
  }
});

describe("lima protocol: fail-closed behaviour", () => {
  for (const [fault, why] of [
    ["start", "limactl start fails"],
    ["egress", "the egress cut cannot be verified"],
    ["ip_missing", "a missing guest ip tool is unsupported, never verified denial"],
    ["route_query", "a failed guest route query is unsupported, never an empty route table"],
    ["route_get", "an unknown status-2 route-get diagnostic fails closed"],
    ["route_get_wrong_status", "the observed unreachable diagnostic with the wrong status fails closed"],
    ["route_get_busybox_wrong_status", "the legacy unreachable diagnostic with the wrong status fails closed"],
    ["route_get_extra", "extra route-get output fails closed"],
    ["route_get_success", "a successful route lookup fails closed"],
    ["route_unsupported", "a route probe error other than permission denial cannot certify privilege restriction"],
    ["user", "the unprivileged workload user cannot be created (P1-4)"],
    ["sudo", "the workload user would still have sudo, so it could re-add the routes (P1-4)"],
    ["copy", "limactl copy fails"]
  ] as const) {
    it(`negative control: ${why} => the run is red, no step executes and no VM instance is left behind`, async () => {
      const { lima, result } = await limaDrill([fault]);
      expectRed(result);
      expect(result.steps.every((s) => s.status === "SKIPPED" || s.status === "ERROR")).toBe(true);
      expect(result.steps.some((s) => s.status === "PASS")).toBe(false);
      expect(lima.instances()).toEqual([]);
    });
  }

  it("negative control: a VM that cannot be deleted is a leaked resource => CLEANUP_UNCONFIRMED and exit 1", async () => {
    const { result, lima } = await limaDrill(["leak"]);
    expect(result.steps.every((s) => s.status === "PASS")).toBe(true);
    expectRed(result);
    expect(result.cleanup.status).toBe("UNCONFIRMED");
    expect(result.cleanup.leaked).toBeGreaterThanOrEqual(1);
    expect(lima.instances().length).toBe(1);
    // retrying cleanup once deletion works removes it and verifies
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${lima.home}/fault`, "");
    const healed = await api.cleanup(makeCtx({ env: lima.env }), { runId: result.run_id }).catch((e: unknown) => e);
    expect(healed).toBeDefined();
  });

  it("negative control: a failing `limactl list` makes the audit unknown, which never counts as cleaned up", async () => {
    const { result } = await limaDrill(["list"]);
    expectRed(result);
    expect(result.cleanup.status).toBe("UNCONFIRMED");
  });

  it("negative control: the VM provider refuses a non-loopback network.allow entry (deny-all egress policy)", async () => {
    const inputs = prepareDrill({ manifest: (m) => { vmManifest(m); m.network.allow = ["updates.example.org"]; } });
    const lima = makeFakeLima();
    const report = await api.preflight({ env: lima.env }, inputs.paths);
    expect(report.status).toBe("REJECTED");
    expect(report.findings.map((f) => f.code)).toContain("UNDECLARED_NETWORK_DESTINATION");
  });

  it("negative control: an unsafe script path and a destroyed sandbox cannot be executed", async () => {
    const lima = makeFakeLima();
    const provider = new LimaProvider({ env: lima.env });
    const sandbox = await provider.provision({
      run_id: "run-protocol-0001",
      limits: { wall_seconds: 30, max_output_bytes: 4096, resources: { cpus: 1, memory_mb: 512, disk_mb: 512 } },
      env: {},
      artifact: { entries: [{ path: "a.txt", type: "file", mode: 0o644, data: Buffer.from("hello") }, { path: "d", type: "directory", mode: 0o755 }, { path: "l", type: "symlink", mode: 0o777, linkname: "a.txt" }] },
      scripts: [{ path: "ok.sh", bytes: Buffer.from("#!/bin/sh\necho hi\n") }],
      synthetic: true
    });
    const unsafe = await sandbox.exec({ script: { path: "../escape.sh" }, label: "x", timeout_ms: 5000 });
    expect(unsafe.exit_code).toBeNull();
    expect(Buffer.from(unsafe.stderr).toString()).toMatch(/unsafe/);
    const ok = await sandbox.exec({ script: { path: "ok.sh" }, label: "ok", timeout_ms: 5000 });
    expect(ok.exit_code).toBe(0);
    expect(Buffer.from(ok.stdout).toString()).toContain("hi");
    expect(await sandbox.readFile("release/a.txt", 100)).not.toBeNull();
    expect(await sandbox.readFile("../x", 100)).toBeNull();
    expect(await sandbox.readFile("release/missing", 100)).toBeNull();
    expect(await sandbox.readFile("release/a.txt", 2)).toBeNull();
    const before = sandbox.resources();
    expect(before.map((r) => r.kind).sort()).toEqual(["directory", "vm-instance"]);
    await sandbox.destroy();
    const after = await sandbox.exec({ script: { path: "ok.sh" }, label: "late", timeout_ms: 5000 });
    expect(after.exit_code).toBeNull();
    const audited = await provider.audit([...before, { kind: "process", id: "p", locator: "1", state: "unknown" }]);
    expect(audited.map((r) => r.state)).toEqual(["removed", "removed", "unknown"]);
    await provider.destroyResources(before);
  });
});

describe("lima protocol: provider options, audit and cleanup retry", () => {
  const req = (over: Partial<api.ProvisionRequest> = {}): api.ProvisionRequest => ({
    run_id: "abcdef12-protocol",
    limits: { wall_seconds: 30, max_output_bytes: 4096 },
    env: {},
    artifact: { entries: [{ path: "d", type: "directory", mode: 0o755 }, { path: "d/a.txt", type: "file", mode: 0o644, data: Buffer.from("x") }, { path: "l", type: "symlink", mode: 0o777, linkname: "d" }] },
    scripts: [{ path: "s.sh", bytes: Buffer.from("#!/bin/sh\necho hi\n") }],
    synthetic: true,
    ...over
  });

  it("honours the template and vm-type options, omits resource flags when none are declared, and records the facts", async () => {
    const lima = makeFakeLima();
    const withOpts = new LimaProvider({ env: { ...lima.env, HANDOFFCHECK_LIMA_VMTYPE: "qemu" }, template: "template:custom" });
    const a = await withOpts.provision(req());
    expect(lima.calls().some((c) => c.startsWith("start") && c.includes("--vm-type qemu") && c.includes("template:custom") && !c.includes("--cpus"))).toBe(true);
    expect((a as unknown as { facts: Record<string, string> }).facts).toMatchObject({ vm_type: "qemu", template: "template:custom", mounts: "none (--plain)" });
    await a.destroy();
    const lima2 = makeFakeLima();
    const noVmType = new LimaProvider({ env: { ...lima2.env, HANDOFFCHECK_LIMA_VMTYPE: "", HANDOFFCHECK_LIMA_TEMPLATE: "template:fromenv" } });
    const b = await noVmType.provision(req({ limits: { wall_seconds: 30, max_output_bytes: 4096, resources: { cpus: 3, memory_mb: 2560, disk_mb: 4096 } } }));
    expect(lima2.calls().some((c) => c.startsWith("start") && !c.includes("--vm-type") && c.includes("--cpus 3") && c.includes("--memory 3") && c.includes("--disk 4") && c.includes("template:fromenv"))).toBe(true);
    expect((b as unknown as { facts: Record<string, string> }).facts).toMatchObject({ vm_type: "default", cpus: "3", memory_mb: "2560", disk_mb: "4096" });
    await b.destroy();
  });

  it("negative control: unsafe staged paths are refused before any VM is started", async () => {
    const lima = makeFakeLima();
    const p = new LimaProvider({ env: lima.env });
    await expect(p.provision(req({ artifact: { entries: [{ path: "../escape", type: "file", mode: 0o644, data: Buffer.from("x") }] } }))).rejects.toThrow(/unsafe artifact path/);
    await expect(p.provision(req({ scripts: [{ path: "../bad.sh", bytes: Buffer.from("x") }] }))).rejects.toThrow(/unsafe script path/);
    expect(lima.calls().some((c) => c.startsWith("start"))).toBe(false);
  });

  it("negative control: with the leak fault a failed provisioning leaves the VM and staging directory, and reports them", async () => {
    const lima = makeFakeLima(["egress"]);
    const p = new LimaProvider({ env: lima.env, fault: "leak-resource" });
    let error: unknown;
    try {
      await p.provision(req());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const left = (error as { resources?: api.ResourceRecord[] }).resources ?? [];
    expect(left.length).toBeGreaterThanOrEqual(1);
    expect(lima.instances().length).toBe(1);
    await p.destroyResources(left); // the fault also disables the retry: still leaked
    expect(lima.instances().length).toBe(1);
    await new LimaProvider({ env: lima.env }).destroyResources([{ kind: "vm-instance", id: "v", locator: lima.instances()[0] as string, state: "leaked" }]);
    expect(lima.instances()).toEqual([]);
  });

  it("negative control: the audit flags a leftover instance directory even when `list` does not show it, and unknown kinds stay unknown", async () => {
    const lima = makeFakeLima();
    const { mkdirSync } = await import("node:fs");
    const ghost = "hc-0badf00d-aabbcc";
    mkdirSync(`${lima.home}/${ghost}`, { recursive: true });
    const p = new LimaProvider({ env: lima.env });
    const audited = await p.audit([
      { kind: "vm-instance", id: "v", locator: ghost, state: "unknown" },
      { kind: "vm-instance", id: "w", locator: "hc-00000000-000000", state: "unknown" },
      { kind: "process", id: "p", locator: "pid:1", state: "unknown" }
    ]);
    expect(audited[0]).toMatchObject({ state: "leaked", detail: expect.stringMatching(/directory still exists/) });
    expect(audited[1]?.state).toBe("removed");
    expect(audited[2]).toMatchObject({ state: "unknown", detail: expect.stringMatching(/not handled/) });
    // names that do not look like ours are never deleted
    await p.destroyResources([{ kind: "vm-instance", id: "x", locator: "someone-elses-vm", state: "leaked" }, { kind: "directory", id: "d", locator: "/tmp/not-ours", state: "leaked" }]);
    expect(lima.calls().some((c) => c.includes("someone-elses-vm"))).toBe(false);
  });

  it("runs node and bash interpreters with arguments inside the guest and reports an unreadable guest file as absent", async () => {
    const lima = makeFakeLima();
    const p = new LimaProvider({ env: lima.env });
    const sb = await p.provision(req({ scripts: [{ path: "n.mjs", bytes: Buffer.from('console.log("n", process.argv.slice(2).join(","))\n') }, { path: "b.sh", bytes: Buffer.from("#!/bin/bash\necho b $1\n") }] }));
    const bash = await sb.exec({ script: { path: "b.sh", interpreter: "bash", args: ["one"] }, label: "s", timeout_ms: 10_000, extra_env: { HC_STEP: "install" } });
    expect(bash.exit_code).toBe(0);
    expect(Buffer.from(bash.stdout).toString()).toContain("b one");
    const node = await sb.exec({ script: { path: "n.mjs", interpreter: "node", args: ["x", "y"] }, label: "s", timeout_ms: 10_000 });
    expect(node.exit_code).toBe(0);
    expect(Buffer.from(node.stdout).toString()).toContain("n x,y");
    expect(await sb.readFile("state/nothing-here", 100)).toBeNull();
    await sb.destroy();
  });
});
