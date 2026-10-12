// End-to-end smoke: invokes the PACKAGED executable (`node dist/src/cli.js`) in fresh temporary directories and
// checks exit codes plus report contents. Includes the offline / outbound-denied demo and the static-report
// browser smoke (escaping, readable tables, empty and error states).
// Titles containing "report smoke" are counted by scripts/verify-quality.sh.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderHtml, emptyView } from "../../src/report/index.js";
import { CLI_PATH, REPO_ROOT, cleanEnv, ensureBuilt, parseJson, runCli } from "../helpers/cli.js";
import { DECOYS } from "../helpers/decoys.js";
import { PLANTED, fixtureRunbook, prepareDrill, readFixtureScript, sh, type DrillInputs } from "../helpers/drill.js";
import { filesContaining, walkFiles } from "../helpers/scan.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

beforeAll(() => {
  // One build per source state, shared by every suite (see ensureBuilt); never a stale dist, never a rebuild under a reader.
  ensureBuilt();
}, 300_000);

interface RunJson {
  run_id: string;
  verdict: { verdict: string; exit_code: number; reasons: { code: string }[]; independent: boolean; human_receipt: string };
  steps: { step_key: string; status: string; reason_code: string }[];
  cleanup: { status: string; resources: number; leaked: number };
  isolation: string;
  exit_code: number;
  state: string;
}

function cliRun(inputs: DrillInputs, store: string, extraArgs: string[] = [], env: Record<string, string> = {}) {
  return runCli(
    ["run", "--manifest", inputs.manifestPath, "--artifact", inputs.artifactPath, "--runbook", inputs.runbookPath, "--output", store, "--json", "--allow-host-sandbox", ...extraArgs],
    { cwd: makeTmp("hc-e2e-cwd-"), env }
  );
}

describe("e2e: packaged executable basics", () => {
  it("prints a version and help, and exits 2 with the documented error body for an unknown command", () => {
    const cwd = makeTmp("hc-e2e-");
    const v = runCli(["--version"], { cwd });
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const h = runCli(["--help"], { cwd });
    expect(h.status).toBe(0);
    for (const c of ["run", "preflight", "report", "export", "import", "verify-bundle", "demo", "cleanup", "record-intervention"]) expect(h.stdout).toContain(c);
    const bad = runCli(["definitely-not-a-command", "--json"], { cwd });
    expect(bad.status).toBe(2);
    const body = parseJson<{ error: { code: string; message: string; request_id: string } }>(bad.stdout);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "request_id"]);
  });

  it("negative control: a missing input file exits 2 and creates no evidence", () => {
    const cwd = makeTmp("hc-e2e-");
    const r = runCli(["run", "--manifest", "missing.yaml", "--artifact", "missing.tar", "--runbook", "missing.md", "--output", join(cwd, "ev"), "--json"], { cwd });
    expect(r.status).toBe(2);
    expect(parseJson<{ error: { code: string } }>(r.stdout).error.code).toMatch(/NOT_FOUND|BAD_REQUEST/);
  });
});

describe("e2e: the fixture drill through the packaged CLI", () => {
  it("passes as a REHEARSAL: exit 0, four PASS steps, cleanup VERIFIED, isolation none, report files written", () => {
    const inputs = prepareDrill();
    const store = join(makeTmp("hc-e2e-store-"), "evidence");
    const r = cliRun(inputs, store);
    expect(r.status).toBe(0);
    const out = parseJson<RunJson>(r.stdout);
    expect(out.verdict.verdict).toBe("REHEARSAL");
    expect(out.verdict.exit_code).toBe(0);
    expect(out.verdict.independent).toBe(false);
    expect(out.verdict.human_receipt).toBe("PENDING_HUMAN_RECEIPT");
    expect(out.steps.map((s) => `${s.step_key}:${s.status}`)).toEqual(["install:PASS", "restore:PASS", "rotate:PASS", "recover:PASS"]);
    expect(out.cleanup.status).toBe("VERIFIED");
    expect(out.isolation).toBe("none");
    const reports = join(store, "reports", out.run_id);
    expect(existsSync(join(reports, "report.html"))).toBe(true);
    expect(existsSync(join(reports, "report.json"))).toBe(true);
    const json = parseJson<{ binding: { artifact_digest: string; runbook_hash: string }; run: { isolation: string }; verdict: { verdict: string } }>(readFileSync(join(reports, "report.json"), "utf8"));
    expect(json.binding.artifact_digest).toBe(inputs.artifactSha256);
    expect(json.binding.runbook_hash).toBe(inputs.runbookSha256);
    expect(json.run.isolation).toBe("none");
  });

  it("negative control: a seeded failing recovery turns the packaged CLI red (exit 1) and the report says why", () => {
    const inputs = prepareDrill({
      scripts: { "recover.sh": "#!/bin/sh\ntrue\n" },
      manifest: (m) => {
        m.steps[3].deadline_seconds = 6;
        m.steps[3].max_recovery_seconds = 3;
      }
    });
    const store = join(makeTmp("hc-e2e-store-"), "evidence");
    const r = cliRun(inputs, store);
    expect(r.status).toBe(1);
    const out = parseJson<RunJson>(r.stdout);
    expect(out.verdict.verdict).toBe("FAIL");
    expect(out.steps.find((s) => s.step_key === "recover")?.reason_code).toBe("RECOVERY_NOT_RESTORED");
    const rep = runCli(["report", "--run", out.run_id, "--output", store, "--json"], { cwd: makeTmp("hc-e2e-") });
    expect(rep.status).toBe(1);
  });

  it("negative control: a production-credential decoy is rejected by preflight (exit 1) and `run` executes nothing", () => {
    const inputs = prepareDrill({ extra: [{ path: "config/prod.env", data: `KEY=${DECOYS.awsAccessKey}\n` }] });
    const cwd = makeTmp("hc-e2e-");
    const pre = runCli(["preflight", "--manifest", inputs.manifestPath, "--artifact", inputs.artifactPath, "--runbook", inputs.runbookPath, "--json"], { cwd });
    expect(pre.status).toBe(1);
    expect(pre.stdout).not.toContain(DECOYS.awsAccessKey);
    expect(pre.stderr).not.toContain(DECOYS.awsAccessKey);
    const r = cliRun(inputs, join(makeTmp("hc-e2e-store-"), "evidence"));
    expect(r.status).toBe(1);
    const out = parseJson<RunJson>(r.stdout);
    expect(out.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(DECOYS.awsAccessKey);
  });

  it("negative control: a leaked resource exits 1 as CLEANUP_UNCONFIRMED, and the cleanup command verifies it once the fault is gone", () => {
    const inputs = prepareDrill();
    const store = join(makeTmp("hc-e2e-store-"), "evidence");
    const r = cliRun(inputs, store, [], { HANDOFFCHECK_TEST_FAULT: "leak-resource" });
    expect(r.status).toBe(1);
    const out = parseJson<RunJson>(r.stdout);
    expect(out.state).toBe("CLEANUP_UNCONFIRMED");
    expect(out.cleanup.status).toBe("UNCONFIRMED");
    const still = runCli(["cleanup", "--run", out.run_id, "--output", store, "--json"], { cwd: makeTmp("hc-e2e-"), env: { HANDOFFCHECK_TEST_FAULT: "leak-resource" } });
    expect(still.status).toBe(1);
    const healed = runCli(["cleanup", "--run", out.run_id, "--output", store, "--json"], { cwd: makeTmp("hc-e2e-") });
    expect(healed.status).toBe(0);
  });

  it("negative control: record-intervention turns a passing run ASSISTED and `report` then exits 1", () => {
    const inputs = prepareDrill();
    const store = join(makeTmp("hc-e2e-store-"), "evidence");
    const out = parseJson<RunJson>(cliRun(inputs, store).stdout);
    const cwd = makeTmp("hc-e2e-");
    expect(runCli(["report", "--run", out.run_id, "--output", store, "--json"], { cwd }).status).toBe(0);
    const rec = runCli(["record-intervention", "--run", out.run_id, "--reason", "builder fixed the restore script", "--actor", "builder-b", "--output", store, "--json"], { cwd });
    expect(rec.status).toBe(0);
    const after = runCli(["report", "--run", out.run_id, "--output", store, "--json"], { cwd });
    expect(after.status).toBe(1);
    expect(parseJson<{ verdict: { verdict: string; exit_code: number } }>(after.stdout).verdict).toMatchObject({ verdict: "ASSISTED", exit_code: 1 });
  });

  it("planted secrets never reach the store, the reports or the exported bundle", () => {
    const noisy = sh(`"$NODE" "$SVC" install\necho "token=$(cat "$HC_STATE/credential.old")"\ncat "$HC_RELEASE/config/service.env"`);
    const inputs = prepareDrill({ scripts: { "install.sh": noisy } });
    const store = join(makeTmp("hc-e2e-store-"), "evidence");
    const cwd = makeTmp("hc-e2e-");
    const r = cliRun(inputs, store);
    expect(r.status).toBe(0);
    const out = parseJson<RunJson>(r.stdout);
    expect(runCli(["export", "--run", out.run_id, "--out", join(cwd, "b.hcb"), "--output", store], { cwd }).status).toBe(0);
    const needles = [PLANTED.oldToken, PLANTED.newToken];
    expect(r.stdout + r.stderr).not.toMatch(/HCFAKE_(OLD|NEW)/);
    expect(filesContaining(store, needles)).toEqual([]);
    expect(filesContaining(cwd, needles)).toEqual([]);
  });
});

describe("e2e: bundle round trip and corruption through the packaged CLI", () => {
  it("exports, verifies and imports into a clean store with the same binding; damaged bundles fail without state", () => {
    const inputs = prepareDrill();
    const store = join(makeTmp("hc-e2e-store-"), "evidence");
    const out = parseJson<RunJson>(cliRun(inputs, store).stdout);
    const cwd = makeTmp("hc-e2e-");
    const bundle = join(cwd, "run.hcb");
    expect(runCli(["export", "--run", out.run_id, "--out", bundle, "--output", store], { cwd }).status).toBe(0);
    expect(runCli(["verify-bundle", "--bundle", bundle, "--json"], { cwd }).status).toBe(0);
    const clean = join(cwd, "clean-store");
    expect(runCli(["import", "--bundle", bundle, "--output", clean, "--json"], { cwd }).status).toBe(0);
    // `report --json` prints the report document itself; its exit code is the effective verdict's
    const reportJson = (storeDir: string) =>
      parseJson<{ binding: { binding_digest: string }; run: { imported: boolean }; verdict: { verdict: string; exit_code: number; reasons: { code: string }[] }; steps: { status: string; evidence_hash: string }[] }>(
        runCli(["report", "--run", out.run_id, "--output", storeDir, "--json"], { cwd }).stdout
      );
    const a = reportJson(store);
    const b = reportJson(clean);
    expect(b.binding.binding_digest).toBe(a.binding.binding_digest);
    expect(b.run.imported).toBe(true);
    // an imported run proves integrity, not provenance: its effective verdict is UNKNOWN and exits 1, whatever the bundle claimed
    expect(b.verdict).toMatchObject({ verdict: "UNKNOWN", exit_code: 1 });
    expect(b.verdict.reasons.map((x) => x.code)).toContain("IMPORT_UNAUTHENTICATED");
    expect(runCli(["report", "--run", out.run_id, "--output", clean, "--json"], { cwd }).status).toBe(1);
    expect(b.steps.map((x) => [x.status, x.evidence_hash])).toEqual(a.steps.map((x) => [x.status, x.evidence_hash]));

    const full = readFileSync(bundle);
    const truncated = join(cwd, "truncated.hcb");
    writeFileSync(truncated, full.subarray(0, Math.floor(full.length / 2)));
    expect(runCli(["verify-bundle", "--bundle", truncated, "--json"], { cwd }).status).toBe(1);
    const fresh = join(cwd, "fresh-store");
    const imp = runCli(["import", "--bundle", truncated, "--output", fresh, "--json"], { cwd });
    expect(imp.status).toBe(2);
    expect(parseJson<{ error: { code: string } }>(imp.stdout).error.code).toBe("BUNDLE_CORRUPT");
    const leftovers = existsSync(join(fresh, "objects")) ? walkFiles(join(fresh, "objects")) : [];
    expect(leftovers).toEqual([]);
  });
});

describe("e2e: AC-09 offline demo with outbound network denied", () => {
  it("completes the deterministic local core with no accounts, no telemetry and zero network attempts", () => {
    const cwd = makeTmp("hc-e2e-demo-");
    const log = join(cwd, "network-attempts.log");
    const preload = join(REPO_ROOT, "tests", "helpers", "deny-network.cjs");
    const r = runCli(["demo", "--output", join(cwd, "demo-store"), "--json"], {
      cwd,
      env: { NODE_OPTIONS: `--require "${preload}"`, HC_DENY_LOG: log }
    });
    expect(r.status).toBe(0);
    const out = parseJson<RunJson>(r.stdout);
    expect(out.verdict.verdict).toBe("REHEARSAL");
    expect(out.isolation).toBe("none");
    expect(out.steps.every((s) => s.status === "PASS")).toBe(true);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  });

  it("negative control: the network-deny preload really blocks and logs an attempted connection", () => {
    const cwd = makeTmp("hc-e2e-demo-");
    const log = join(cwd, "attempts.log");
    const preload = join(REPO_ROOT, "tests", "helpers", "deny-network.cjs");
    const r = spawnSync(process.execPath, ["--require", preload, "-e", 'fetch("http://localhost:9/x").catch(() => {})'], {
      env: cleanEnv({ HC_DENY_LOG: log }),
      encoding: "utf8"
    });
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("fetch http://localhost:9/x");
  });

  it("runs with an empty environment: no credentials, proxies or telemetry switches are needed", () => {
    const cwd = makeTmp("hc-e2e-demo-");
    const r = spawnSync(process.execPath, [CLI_PATH, "demo", "--output", join(cwd, "s"), "--json"], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: cwd },
      encoding: "utf8"
    });
    expect(r.status).toBe(0);
  });

  it("the demo store is created owner-only", () => {
    const cwd = makeTmp("hc-e2e-demo-");
    const store = join(cwd, "s");
    expect(runCli(["demo", "--output", store, "--json"], { cwd }).status).toBe(0);
    expect(statSync(store).mode & 0o077).toBe(0);
  });
});

describe("e2e: AC-12 the documented synthetic smoke procedure (supplemental; the fresh-operator human receipt stays pending)", () => {
  it("executes verbatim from the README in a fresh directory and exits 0", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const m = /```sh smoke\n([\s\S]*?)```/.exec(readme);
    expect(m, "README has a ```sh smoke block").not.toBeNull();
    const cwd = makeTmp("hc-e2e-smoke-");
    writeFileSync(join(cwd, "smoke.sh"), m![1] as string);
    const r = spawnSync("sh", ["smoke.sh"], { cwd, env: cleanEnv({ HC_REPO: REPO_ROOT }), encoding: "utf8", timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("smoke ok");
    expect(readdirSync(cwd)).toEqual(expect.arrayContaining(["smoke-evidence", "smoke-clean-store", "smoke.hcb", "release.tar"]));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Static-report browser smoke: escaping, readable tables, empty and error states. Real Chromium (Playwright) loads
// the real report.html produced by the packaged CLI from disk; no route mocks, no JavaScript in the page.
// ---------------------------------------------------------------------------------------------------------------
describe("report smoke (browser): static HTML report", () => {
  let browser: Browser | undefined;
  let launchError = "";
  let cleanHtmlPath = "";
  let hostileHtmlPath = "";
  let failedHtmlPath = "";

  function reportOf(inputs: DrillInputs, store: string, run: RunJson): string {
    const rep = runCli(["report", "--run", run.run_id, "--output", store, "--format", "html", "--out", join(store, "x.html")], { cwd: makeTmp("hc-e2e-") });
    expect([0, 1]).toContain(rep.status);
    void inputs;
    return join(store, "x.html");
  }

  beforeAll(async () => {
    try {
      browser = await chromium.launch();
    } catch (err) {
      launchError = String((err as Error).message).split("\n")[0] ?? "launch failed";
    }
    const cleanInputs = prepareDrill();
    const cleanStore = join(makeTmp("hc-e2e-store-"), "evidence");
    cleanHtmlPath = reportOf(cleanInputs, cleanStore, parseJson<RunJson>(cliRun(cleanInputs, cleanStore).stdout));

    const evil = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1"><b id="evil">bold</b>';
    const hostileInputs = prepareDrill({
      scripts: { "install.sh": sh(`"$NODE" "$SVC" install\necho '${evil}'`), "health.sh": readFixtureScript("health.sh") },
      manifest: (m) => void (m.operator.ref = evil),
      runbook: `${fixtureRunbook()}\n${evil}\n`
    });
    const hostileStore = join(makeTmp("hc-e2e-store-"), "evidence");
    const hostileRun = parseJson<RunJson>(cliRun(hostileInputs, hostileStore).stdout);
    runCli(["record-intervention", "--run", hostileRun.run_id, "--reason", evil, "--actor", "<i>actor</i>", "--output", hostileStore], { cwd: makeTmp("hc-e2e-") });
    hostileHtmlPath = reportOf(hostileInputs, hostileStore, hostileRun);

    const failedInputs = prepareDrill({ scripts: { "rotate.sh": sh('cp "$HC_STATE/credential.old" "$HC_STATE/credential.new"') } });
    const failedStore = join(makeTmp("hc-e2e-store-"), "evidence");
    failedHtmlPath = reportOf(failedInputs, failedStore, parseJson<RunJson>(cliRun(failedInputs, failedStore).stdout));
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
  }, 120_000); // closing Chromium timed out under a loaded host with the default hook timeout

  const needBrowser = (ctx: { skip: (note: string) => void }) => {
    if (!browser) ctx.skip(`BLOCKED: chromium could not be launched (${launchError}); the HTML-parse report smoke tests still run`);
    return browser!;
  };

  it("report smoke: the clean report renders readable tables with the verdict, steps and cleanup, with no scripts or network", async (ctx) => {
    const b = needBrowser(ctx);
    const page = await b.newPage({ viewport: { width: 1100, height: 900 } });
    const requests: string[] = [];
    page.on("request", (req) => requests.push(req.url()));
    await page.goto(`file://${cleanHtmlPath}`);
    expect(await page.locator("script").count()).toBe(0);
    const text = await page.locator("body").innerText();
    for (const word of ["REHEARSAL", "install", "restore", "rotate", "recover", "VERIFIED", "PENDING_HUMAN_RECEIPT"]) expect(text).toContain(word);
    expect(text.toLowerCase()).toContain("isolation");
    const tables = await page.locator("table").count();
    expect(tables).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < tables; i++) {
      const t = page.locator("table").nth(i);
      expect(await t.locator("th").count(), `table ${i} has headers`).toBeGreaterThan(0);
      expect(await t.locator("tr").count(), `table ${i} has rows`).toBeGreaterThan(1);
    }
    expect(requests.every((u) => u.startsWith("file://") || u.startsWith("data:"))).toBe(true);
    await page.close();
  });

  it("report smoke: hostile HTML in titles, output, runbook text and interventions renders as inert text", async (ctx) => {
    const b = needBrowser(ctx);
    const page = await b.newPage();
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto(`file://${hostileHtmlPath}`);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(await page.locator("script").count()).toBe(0);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator("#evil").count()).toBe(0);
    expect(await page.locator("body").innerText()).toContain("<script>window.__pwned=1</script>");
    expect(await page.locator("body").innerText()).toContain("<b id=\"evil\">bold</b>");
    const source = readFileSync(hostileHtmlPath, "utf8");
    expect(source).not.toContain("<script");
    expect(source).not.toContain("<img src=x");
    await page.close();
  });

  it("report smoke: a failed run shows FAIL with the reason, never a pass, and remains readable on a phone-sized viewport", async (ctx) => {
    const b = needBrowser(ctx);
    const page = await b.newPage({ viewport: { width: 375, height: 800 }, colorScheme: "dark" });
    await page.goto(`file://${failedHtmlPath}`);
    const text = await page.locator("body").innerText();
    expect(text).toContain("FAIL");
    expect(text).toContain("ROTATION_NOT_ROTATED");
    expect(text).not.toMatch(/INDEPENDENT_PASS/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.close();
  });

  it("report smoke: empty and error states are explicit and never imply a result", async (ctx) => {
    const b = needBrowser(ctx);
    const dir = makeTmp("hc-e2e-views-");
    const empty = join(dir, "empty.html");
    const error = join(dir, "error.html");
    writeFileSync(empty, renderHtml(emptyView("2026-01-01T00:00:00.000Z", "0.0.0")));
    writeFileSync(error, renderHtml({ ...emptyView("2026-01-01T00:00:00.000Z", "0.0.0"), error: { code: "NOT_FOUND", message: "run <b>x</b> not found", request_id: "req_test" } }));
    const page = await b.newPage();
    await page.goto(`file://${empty}`);
    const emptyText = await page.locator("body").innerText();
    expect(emptyText).toContain("No run loaded");
    const banner = await page.locator(".banner").innerText();
    expect(banner).not.toMatch(/INDEPENDENT_PASS|REHEARSAL|\bPASS\b/);
    expect(await page.locator(".banner.pass").count()).toBe(0);
    await page.goto(`file://${error}`);
    const errorText = await page.locator("body").innerText();
    expect(errorText).toContain("NOT_FOUND");
    expect(errorText).toContain("run <b>x</b> not found");
    expect(await page.locator("b").count()).toBe(0);
    await page.close();
  });
});

describe("report smoke (no browser): the report HTML is escaped, has no script and states empty and unknown values", () => {
  it("report smoke: the generated HTML files contain no script, no external reference and escape hostile text", () => {
    // Parse the files produced by the CLI without a browser so this check still runs when chromium is unavailable.
    const dir = makeTmp("hc-e2e-parse-");
    const inputs = prepareDrill({ manifest: (m) => void (m.operator.ref = "<script>alert(1)</script>") });
    const store = join(dir, "evidence");
    const run = parseJson<RunJson>(cliRun(inputs, store).stdout);
    const out = join(dir, "r.html");
    runCli(["report", "--run", run.run_id, "--output", store, "--format", "html", "--out", out], { cwd: dir });
    const html = readFileSync(out, "utf8");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/i);
    expect(html).toMatch(/Content-Security-Policy/i);
  });

  it("report smoke: an unknown status word renders as UNKNOWN, never as a pass", () => {
    const html = renderHtml({ ...emptyView("2026-01-01T00:00:00.000Z", "0.0.0"), notices: ["<b>note</b>"] });
    expect(html).toContain("&lt;b&gt;note&lt;/b&gt;");
    expect(html).not.toContain("<b>note</b>");
    expect(html).toMatch(/UNKNOWN/);
  });
});
