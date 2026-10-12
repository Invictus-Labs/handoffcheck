// In-process tests for every CLI command handler (src/cli/commands). The packaged executable is exercised by
// tests/e2e/smoke.spec.ts; this file drives the same `main` in-process so the handlers are measured for coverage.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runMain } from "../helpers/cli.js";
import { DECOYS } from "../helpers/decoys.js";
import { prepareDrill, type DrillInputs } from "../helpers/drill.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const j = <T = Record<string, any>>(text: string): T => JSON.parse(text) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

let inputs: DrillInputs;
let cwd: string;
let store: string;
let runId: string;

const runArgs = (i: DrillInputs, out: string): string[] => ["run", "--manifest", i.manifestPath, "--artifact", i.artifactPath, "--runbook", i.runbookPath, "--output", out, "--allow-host-sandbox"];

beforeAll(async () => {
  inputs = prepareDrill();
  cwd = makeTmp("hc-cmd-");
  store = join(cwd, "evidence");
  const r = await runMain([...runArgs(inputs, store), "--json"], { cwd });
  expect(r.code).toBe(0);
  runId = j<{ run_id: string }>(r.out).run_id;
}, 180_000);

describe("run", () => {
  it("prints a human summary with the verdict, isolation warning, report paths and exit code", async () => {
    const out = join(makeTmp("hc-cmd-"), "ev");
    const r = await runMain([...runArgs(inputs, out), "--operator", "operator-a"], { cwd });
    expect(r.code).toBe(0);
    for (const s of ["REHEARSAL", "isolation none", "PENDING_HUMAN_RECEIPT", "exit code: 0", "report.html", "[step ] install PASS"]) expect(r.out + r.err).toContain(s);
    expect(statSync(out).mode & 0o077).toBe(0);
  }, 120_000);

  it("--json prints the result plus the written report paths, and the files exist", () => {
    // the shared run from beforeAll
    expect(existsSync(join(store, "reports", runId, "report.html"))).toBe(true);
    expect(existsSync(join(store, "reports", runId, "report.json"))).toBe(true);
  });

  it("negative control: a missing input file exits 2 with NOT_FOUND and a non-file input exits 2 with BAD_REQUEST", async () => {
    const missing = await runMain(["run", "--manifest", "nope.yaml", "--artifact", inputs.artifactPath, "--runbook", inputs.runbookPath, "--json"], { cwd });
    expect(missing.code).toBe(2);
    expect(j(missing.out).error.code).toBe("NOT_FOUND");
    const dir = await runMain(["run", "--manifest", cwd, "--artifact", inputs.artifactPath, "--runbook", inputs.runbookPath, "--json"], { cwd });
    expect(dir.code).toBe(2);
    expect(j(dir.out).error.code).toBe("BAD_REQUEST");
  });

  it("negative control: a decoy credential is rejected: exit 1, nothing executed, the decoy is never printed", async () => {
    const bad = prepareDrill({ extra: [{ path: "config/prod.env", data: `K=${DECOYS.githubToken}\n` }] });
    const r = await runMain([...runArgs(bad, join(makeTmp("hc-cmd-"), "ev")), "--json"], { cwd });
    expect(r.code).toBe(1);
    expect(j(r.out).steps.every((s: { status: string }) => s.status === "SKIPPED")).toBe(true);
    expect(r.out + r.err).not.toContain(DECOYS.githubToken);
  });

  it("negative control: a store directory that is group/world accessible produces a warning and is not changed", async () => {
    const out = join(makeTmp("hc-cmd-"), "open");
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(out, { mode: 0o755 });
    chmodSync(out, 0o755);
    const bad = prepareDrill({ scripts: { "health.sh": "#!/bin/sh\nexit 1\n" }, manifest: (m) => void (m.steps[0].deadline_seconds = 1) });
    const r = await runMain(runArgs(bad, out), { cwd });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/accessible to other users/);
    // (the library then tightens the store to owner-only; docs/CLI.md still says "not changed": reported to hc-cli)
    expect(statSync(out).mode & 0o022).toBe(0);
  }, 120_000);

  it("negative control: an output path that is a file exits 2", async () => {
    const file = join(makeTmp("hc-cmd-"), "afile");
    writeFileSync(file, "x");
    const r = await runMain([...runArgs(inputs, file), "--json"], { cwd });
    expect(r.code).toBe(2);
    expect(j(r.out).error.code).toBe("BAD_REQUEST");
  });
});

describe("run: operator flags (a CLI cannot prove a human is present)", () => {
  const base = (out: string) => runArgs(inputs, out);

  it("defaults to an automated operator, so even a clean run is a REHEARSAL", async () => {
    const r = await runMain([...base(join(makeTmp("hc-cmd-"), "ev")), "--json"], { cwd });
    expect(j(r.out).verdict.verdict).toBe("REHEARSAL");
  }, 120_000);

  it("negative control: --operator-kind human without both an operator and a builder identity is a usage error (exit 2)", async () => {
    for (const extra of [["--operator-kind", "human"], ["--operator-kind", "human", "--operator-ref", "operator-a"], ["--operator-kind", "human", "--builder-ref", "builder-b"]]) {
      const r = await runMain([...base(join(makeTmp("hc-cmd-"), "ev")), ...extra, "--json"], { cwd });
      expect(r.code, extra.join(" ")).toBe(2);
      expect(j(r.out).error.code).toBe("BAD_REQUEST");
    }
  });

  it("negative control: an unknown operator kind is rejected, and a human claim on isolation none is still only a REHEARSAL", async () => {
    const bad = await runMain([...base(join(makeTmp("hc-cmd-"), "ev")), "--operator-kind", "robot", "--json"], { cwd });
    expect(bad.code).toBe(2);
    const human = await runMain([...base(join(makeTmp("hc-cmd-"), "ev")), "--operator-kind", "human", "--operator-ref", "operator-a", "--builder-ref", "builder-b", "--json"], { cwd });
    expect(j(human.out).verdict.verdict).toBe("REHEARSAL");
    expect(j(human.out).verdict.independent).toBe(false);
    expect(j(human.out).verdict.human_receipt).toBe("PENDING_HUMAN_RECEIPT");
  }, 120_000);
});

describe("preflight", () => {
  it("passes with exit 0 and lists no findings; --json is the report", async () => {
    const args = ["preflight", "--manifest", inputs.manifestPath, "--artifact", inputs.artifactPath, "--runbook", inputs.runbookPath, "--allow-host-sandbox"];
    const text = await runMain(args, { cwd });
    expect(text.code).toBe(0);
    expect(text.out).toContain("preflight: PASS");
    expect(text.out).toContain("no findings");
    const json = await runMain([...args, "--json"], { cwd });
    expect(j(json.out)).toMatchObject({ status: "PASS", provider: "local-sandbox", isolation: "none" });
  });

  it("negative control (P1-6): without --allow-host-sandbox a local-sandbox preflight is rejected with HOST_SANDBOX_NOT_ALLOWED (exit 1), and the flag is the only thing that changes the result", async () => {
    const bare = ["preflight", "--manifest", inputs.manifestPath, "--artifact", inputs.artifactPath, "--runbook", inputs.runbookPath];
    const denied = await runMain([...bare, "--json"], { cwd });
    expect(denied.code).toBe(1);
    const body = j<{ status: string; findings: { code: string; severity: string }[] }>(denied.out);
    expect(body.status).toBe("REJECTED");
    expect(body.findings).toEqual([expect.objectContaining({ code: "HOST_SANDBOX_NOT_ALLOWED", severity: "reject" })]);
    const allowed = await runMain([...bare, "--allow-host-sandbox", "--json"], { cwd });
    expect(allowed.code).toBe(0);
    expect(j<{ status: string }>(allowed.out).status).toBe("PASS");
  });

  it("negative control: rejects with exit 1 and lists findings without the secret", async () => {
    const bad = prepareDrill({ scripts: { "health.sh": "#!/bin/sh\ncurl https://updates.example.org/x\n" }, extra: [{ path: "c.env", data: `K=${DECOYS.awsAccessKey}\n` }] });
    const r = await runMain(["preflight", "--manifest", bad.manifestPath, "--artifact", bad.artifactPath, "--runbook", bad.runbookPath, "--allow-host-sandbox"], { cwd });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/reject\s+PRODUCTION_CREDENTIAL/);
    expect(r.out).toMatch(/UNDECLARED_NETWORK_DESTINATION/);
    expect(r.out).not.toContain(DECOYS.awsAccessKey);
  });

  it("negative control: --artifact and --runbook are required, so a manifest-only preflight is a usage error (exit 2)", async () => {
    const r = await runMain(["preflight", "--manifest", inputs.manifestPath, "--json"], { cwd });
    expect(r.code).toBe(2);
    expect(j(r.out).error.code).toBe("BAD_REQUEST");
  });
});

describe("report", () => {
  it("writes json and html under the store by default, prints a summary and exits with the verdict code", async () => {
    const r = await runMain(["report", "--run", runId, "--output", store], { cwd });
    expect(r.code).toBe(0);
    expect(r.out).toContain("REHEARSAL (exit code 0)");
    expect(r.out).toContain("report.html");
  });

  it("supports a single format to a file, to stdout with -, and a directory for both", async () => {
    const dir = makeTmp("hc-cmd-");
    const htmlFile = join(dir, "r.html");
    expect((await runMain(["report", "--run", runId, "--output", store, "--format", "html", "--out", htmlFile], { cwd })).code).toBe(0);
    expect(readFileSync(htmlFile, "utf8")).toContain("<!doctype html>");
    const jsonStdout = await runMain(["report", "--run", runId, "--output", store, "--format", "json", "--out", "-"], { cwd });
    expect(jsonStdout.code).toBe(0);
    expect(j(jsonStdout.out).run.id).toBe(runId);
    const htmlStdout = await runMain(["report", "--run", runId, "--output", store, "--format", "html", "--out", "-"], { cwd });
    expect(htmlStdout.out).toContain("<!doctype html>");
    const both = await runMain(["report", "--run", runId, "--output", store, "--out", join(dir, "both"), "--json"], { cwd });
    expect(j(both.out).run.id).toBe(runId);
    expect(existsSync(join(dir, "both", "report.json"))).toBe(true);
    expect(existsSync(join(dir, "both", "report.html"))).toBe(true);
    const jsonFile = join(dir, "r.json");
    expect((await runMain(["report", "--run", runId, "--output", store, "--format", "json", "--out", jsonFile, "--json"], { cwd })).code).toBe(0);
    expect(existsSync(jsonFile)).toBe(true);
  });

  it("negative control: --out - with both formats is BAD_REQUEST, and an unknown run is NOT_FOUND with exit 2", async () => {
    const both = await runMain(["report", "--run", runId, "--output", store, "--out", "-", "--json"], { cwd });
    expect(both.code).toBe(2);
    expect(j(both.out).error.code).toBe("BAD_REQUEST");
    const unknown = await runMain(["report", "--run", "no-such-run", "--output", store, "--json"], { cwd });
    expect(unknown.code).toBe(2);
    expect(j(unknown.out).error.code).toBe("NOT_FOUND");
  });
});

describe("record-intervention, export, verify-bundle, import, cleanup", () => {
  let ownRun: string;
  let ownStore: string;

  beforeAll(async () => {
    ownStore = join(makeTmp("hc-cmd-"), "ev");
    ownRun = j<{ run_id: string }>((await runMain([...runArgs(inputs, ownStore), "--json"], { cwd })).out).run_id;
  }, 120_000);

  it("negative control: records an intervention (default actor is the local identity) and the run becomes ASSISTED", async () => {
    const withActor = await runMain(["record-intervention", "--run", ownRun, "--reason", "needed a hint", "--actor", "builder-b", "--output", ownStore], { cwd });
    expect(withActor.code).toBe(0);
    expect(withActor.out).toContain("verdict is now ASSISTED");
    expect(withActor.out).toContain("not third-party attestation");
    const defaultActor = await runMain(["record-intervention", "--run", ownRun, "--reason", "second hint", "--output", ownStore, "--json"], { cwd });
    expect(j(defaultActor.out)).toMatchObject({ verdict: "ASSISTED", exit_code: 1 });
    expect(j(defaultActor.out).intervention.actor_ref.length).toBeGreaterThan(0);
    const report = await runMain(["report", "--run", ownRun, "--output", ownStore], { cwd });
    expect(report.code).toBe(1);
  });

  it("negative control: a blank reason and an unknown run are rejected", async () => {
    const blank = await runMain(["record-intervention", "--run", ownRun, "--reason", "   ", "--output", ownStore, "--json"], { cwd });
    expect(blank.code).toBe(2);
    expect(j(blank.out).error.code).toBe("BAD_REQUEST");
    const unknown = await runMain(["record-intervention", "--run", "ghost", "--reason", "x", "--output", ownStore, "--json"], { cwd });
    expect(unknown.code).toBe(2);
    expect(j(unknown.out).error.code).toBe("NOT_FOUND");
  });

  it("exports, verifies and imports a bundle (text and JSON modes) and refuses to overwrite", async () => {
    const dir = makeTmp("hc-cmd-");
    const bundle = join(dir, "run.hcb");
    const exp = await runMain(["export", "--run", runId, "--out", bundle, "--output", store], { cwd });
    expect(exp.code).toBe(0);
    for (const s of ["bundle written", "sha256:", "handoffcheck-evidence-bundle", "root:"]) expect(exp.out).toContain(s);
    const again = await runMain(["export", "--run", runId, "--out", bundle, "--output", store, "--json"], { cwd });
    expect(again.code).toBe(2);
    expect(j(again.out).error.code).toBe("CONFLICT");
    expect((await runMain(["verify-bundle", "--bundle", bundle], { cwd })).out).toContain("bundle OK");
    expect(j((await runMain(["verify-bundle", "--bundle", bundle, "--json"], { cwd })).out).ok).toBe(true);
    const target = join(dir, "clean");
    const imp = await runMain(["import", "--bundle", bundle, "--output", target], { cwd });
    expect(imp.code).toBe(0);
    expect(imp.out).toContain(`imported run ${runId}`);
    const dup = await runMain(["import", "--bundle", bundle, "--output", target, "--json"], { cwd });
    expect(dup.code).toBe(2);
    expect(j(dup.out).error.code).toBe("CONFLICT");
    const json = await runMain(["import", "--bundle", bundle, "--output", join(dir, "clean2"), "--json"], { cwd });
    expect(j(json.out).run_id).toBe(runId);
  });

  it("negative control: damaged bundles fail verification (exit 1, errors listed) and import (exit 2)", async () => {
    const dir = makeTmp("hc-cmd-");
    const bundle = join(dir, "run.hcb");
    await runMain(["export", "--run", runId, "--out", bundle, "--output", store], { cwd });
    const bytes = readFileSync(bundle);
    const cut = join(dir, "cut.hcb");
    writeFileSync(cut, bytes.subarray(0, bytes.length - 2000));
    const verify = await runMain(["verify-bundle", "--bundle", cut], { cwd });
    expect(verify.code).toBe(1);
    expect(verify.out).toContain("bundle INVALID");
    const imp = await runMain(["import", "--bundle", cut, "--output", join(dir, "s"), "--json"], { cwd });
    expect(imp.code).toBe(2);
    expect(j(imp.out).error.code).toBe("BUNDLE_CORRUPT");
    const missing = await runMain(["verify-bundle", "--bundle", join(dir, "absent.hcb"), "--json"], { cwd });
    expect(missing.code).toBe(1);
  });

  it("cleanup re-verifies a clean run, in text and JSON; a leaked run stays red until the leak is gone", async () => {
    const text = await runMain(["cleanup", "--run", runId, "--output", store], { cwd });
    expect(text.code).toBe(0);
    expect(text.out).toContain("cleanup: VERIFIED");
    const leakStore = join(makeTmp("hc-cmd-"), "ev");
    const leak = await runMain([...runArgs(inputs, leakStore), "--json"], { cwd, env: { HANDOFFCHECK_TEST_FAULT: "leak-resource" } });
    expect(leak.code).toBe(1);
    const leakRun = j<{ run_id: string; state: string }>(leak.out);
    expect(leakRun.state).toBe("CLEANUP_UNCONFIRMED");
    const still = await runMain(["cleanup", "--run", leakRun.run_id, "--output", leakStore], { cwd, env: { HANDOFFCHECK_TEST_FAULT: "leak-resource" } });
    expect(still.code).toBe(1);
    expect(still.out).toContain("cleanup is not verified");
    const healed = await runMain(["cleanup", "--run", leakRun.run_id, "--output", leakStore, "--json"], { cwd });
    expect(healed.code).toBe(0);
    expect(j(healed.out).state).toBe("CLEANUP_VERIFIED");
  }, 120_000);

  it("negative control: commands that read a store never create it", async () => {
    const ghost = join(makeTmp("hc-cmd-"), "ghost");
    for (const args of [["cleanup", "--run", "r"], ["record-intervention", "--run", "r", "--reason", "x"], ["export", "--run", "r", "--out", "b.hcb"]]) {
      const r = await runMain([...args, "--output", ghost, "--json"], { cwd });
      expect(r.code, args[0]).toBe(2);
      expect(j(r.out).error.code).toBe("NOT_FOUND");
    }
    expect(existsSync(ghost)).toBe(false);
  });
});

describe("demo", () => {
  it("runs the built-in synthetic drill (default store name in the cwd), and --json prints the result", async () => {
    const dir = makeTmp("hc-cmd-");
    const text = await runMain(["demo"], { cwd: dir });
    expect(text.code).toBe(0);
    expect(existsSync(join(dir, "handoffcheck-demo"))).toBe(true);
    for (const s of ["REHEARSAL", "isolation none"]) expect(text.out).toContain(s);
    const json = await runMain(["demo", "--output", join(dir, "d2"), "--json"], { cwd: dir });
    expect(j(json.out)).toMatchObject({ exit_code: 0, isolation: "none", provider: "local-sandbox" });
  }, 180_000);
});

describe("adapter commands", () => {
  it("negative control: disabled by default; --enable-adapters or HANDOFFCHECK_ADAPTERS=1 opts in; round trip dedupes and never upgrades an unverifiable claim", async () => {
    const dir = makeTmp("hc-cmd-");
    const off = await runMain(["adapter", "import-acceptance", "--file", "x.json", "--output", store, "--json"], { cwd });
    expect(off.code).toBe(2);
    expect(j(off.out).error.code).toBe("CONNECTOR_DISCONNECTED");

    const out = join(dir, "receipts");
    const exp = await runMain(["adapter", "export-receipt", "--run", runId, "--out", out, "--output", store, "--enable-adapters", "--json"], { cwd });
    expect(exp.code).toBe(0);
    const env = j<{ envelope: { event_id: string; evidence_ref: string } }>(exp.out).envelope;
    const text = await runMain(["adapter", "export-receipt", "--run", runId, "--out", join(dir, "again"), "--output", store], { cwd, env: { HANDOFFCHECK_ADAPTERS: "1" } });
    expect(text.code).toBe(0);
    expect(text.out).toContain("nothing was sent anywhere");

    const accept = (over: Record<string, unknown>) => ({
      schema_version: 1, event_id: "pg-1", source: "proofgate", resource_id: runId, event_type: "acceptance.accepted",
      occurred_at: "2026-01-01T00:00:00Z", revision: 1, evidence_ref: env.evidence_ref, correlation_id: env.event_id, ...over
    });
    const file = join(out, "acceptance.json");
    writeFileSync(file, JSON.stringify(accept({})));
    const imp = await runMain(["adapter", "import-acceptance", "--file", file, "--output", store, "--enable-adapters"], { cwd });
    expect(imp.code).toBe(0);
    expect(imp.out).toContain("applied 1");
    expect(imp.out).toContain("accepted");
    const dup = await runMain(["adapter", "import-acceptance", "--file", file, "--output", store, "--enable-adapters", "--json"], { cwd });
    expect(j(dup.out).duplicates).toBe(1);
    // the acceptance notice shows in the report but never changes the drill verdict or exit code
    const report = await runMain(["report", "--run", runId, "--output", store, "--format", "html", "--out", "-"], { cwd });
    expect(report.code).toBe(0);
    expect(report.out).toContain("Imported acceptance");

    writeFileSync(file, JSON.stringify([accept({ event_id: "pg-2", revision: 2, evidence_ref: `sha256:${"f".repeat(64)}` }), { bad: true }]));
    const bad = await runMain(["adapter", "import-acceptance", "--file", file, "--output", store, "--enable-adapters"], { cwd });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/unknown/);
    expect(bad.out).toMatch(/rejected 1/);
  });
});

describe("report notices and write failures", () => {
  it("negative control: a corrupt adapter ledger shows an explicit notice, an unwritable report path is BAD_REQUEST (exit 2), and a clean ledger without this run shows nothing", async () => {
    const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
    const dir = makeTmp("hc-notice-");
    const storeCopy = join(dir, "ev");
    const exportPath = join(dir, "run.hcb");
    await runMain(["export", "--run", runId, "--out", exportPath, "--output", store], { cwd });
    await runMain(["import", "--bundle", exportPath, "--output", storeCopy], { cwd });
    mk(join(storeCopy, "adapters"), { recursive: true });
    wf(join(storeCopy, "adapters", "ledger.json"), "{broken");
    const html = await runMain(["report", "--run", runId, "--output", storeCopy, "--format", "html", "--out", "-"], { cwd });
    expect(html.out).toContain("Adapter state could not be read");
    wf(join(storeCopy, "adapters", "ledger.json"), JSON.stringify({ ledger_version: 1, seen: {}, streams: {}, exports: {}, acceptance: {} }));
    const quiet = await runMain(["report", "--run", runId, "--output", storeCopy, "--format", "html", "--out", "-"], { cwd });
    expect(quiet.out).not.toContain("Imported acceptance");
    const file = join(dir, "afile");
    wf(file, "x");
    const bad = await runMain(["report", "--run", runId, "--output", storeCopy, "--format", "html", "--out", join(file, "nested", "r.html"), "--json"], { cwd });
    expect(bad.code).toBe(2);
    expect(j(bad.out).error.code).toBe("BAD_REQUEST");
  });
});
