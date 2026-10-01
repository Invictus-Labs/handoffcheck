// Deep verification branches of the evidence bundle reader/writer (src/evidence/bundle.ts). Bundles are forged with
// a consistent header so each check beyond the hash layer is reachable. Every defect must be rejected with no state.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { forgeBundle } from "../helpers/bundle.js";
import { makeCtx } from "../helpers/drill.js";
import { runDrill, type Executed } from "../helpers/run.js";
import { walkFiles } from "../helpers/scan.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

let source: Executed;
let bundle: Buffer;

beforeAll(async () => {
  source = await runDrill();
  const out = join(makeTmp("hc-bv-"), "b.hcb");
  await api.exportBundle(source.ctx, { runId: source.result.run_id, outPath: out });
  bundle = readFileSync(out);
}, 120_000);

const write = (data: Buffer): string => {
  const p = join(makeTmp("hc-bv-"), "x.hcb");
  writeFileSync(p, data);
  return p;
};

async function expectRejected(data: Buffer, code: string, importCode?: string, limits?: Partial<api.Limits>): Promise<void> {
  const path = write(data);
  const v = await api.verifyBundle({ ...(limits ? { limits } : {}) }, { bundlePath: path });
  expect(v.ok).toBe(false);
  expect(v.errors.map((e) => e.code), JSON.stringify(v.errors)).toContain(code);
  const target = makeCtx(limits ? { limits } : {});
  await expect(api.importBundle(target, { bundlePath: path })).rejects.toMatchObject({ code: importCode ?? "BUNDLE_CORRUPT" });
  expect(existsObjects(target.storeDir)).toBe(false);
}

const existsObjects = (storeDir: string): boolean => {
  try {
    return walkFiles(join(storeDir, "objects")).length > 0;
  } catch {
    return false;
  }
};

describe("bundle structure", () => {
  it("a forged-but-consistent copy of a good bundle still verifies (the helper itself is sound)", async () => {
    const v = await api.verifyBundle({}, { bundlePath: write(forgeBundle(bundle)) });
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });

  it("negative control: unreadable, non-file and oversized bundle files are rejected", async () => {
    const dir = makeTmp("hc-bv-");
    expect((await api.verifyBundle({}, { bundlePath: join(dir, "missing.hcb") })).errors[0]?.code).toBe("MISSING_FILE");
    mkdirSync(join(dir, "adir"));
    expect((await api.verifyBundle({}, { bundlePath: join(dir, "adir") })).errors[0]?.code).toBe("BAD_FORMAT");
    await expect(api.importBundle(makeCtx(), { bundlePath: join(dir, "adir") })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.importBundle(makeCtx(), { bundlePath: join(dir, "missing.hcb") })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const big = join(dir, "big.hcb");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 64));
    expect((await api.verifyBundle({ limits: { max_blob_bytes: 1, max_metadata_bytes: 1 } }, { bundlePath: big })).errors[0]?.code).toBe("LIMIT_EXCEEDED");
    await expect(api.importBundle(makeCtx({ limits: { max_blob_bytes: 1, max_metadata_bytes: 1 } }), { bundlePath: big })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("negative control: header problems (not first, bad JSON, wrong format, wrong version, schema, duplicates, hashes) are rejected", async () => {
    await expectRejected(forgeBundle(bundle, { entries: (e) => [e[1]!, e[0]!, ...e.slice(2)] }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { headerRaw: "{not json" }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { header: (h) => void (h.format = "something-else") }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { header: (h) => void (h.format_version = 2) }), "UNSUPPORTED_VERSION", "UNSUPPORTED_VERSION");
    await expectRejected(forgeBundle(bundle, { header: (h) => void (h.schema_version = 7) }), "UNSUPPORTED_VERSION", "UNSUPPORTED_VERSION");
    await expectRejected(forgeBundle(bundle, { header: (h) => void delete h.files }), "SCHEMA_INVALID");
    await expectRejected(forgeBundle(bundle, { header: (h) => void h.files.push({ ...h.files[0] }) }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { header: (h) => void (h.root_hash = "0".repeat(64)) }), "ROOT_HASH_MISMATCH");
    await expectRejected(forgeBundle(bundle, { header: (h) => void (h.files[0].size_bytes += 1) }), "HASH_MISMATCH");
    await expectRejected(forgeBundle(bundle, { header: (h) => void (h.blob_bytes += 1) }), "BAD_FORMAT");
  });

  it("negative control: a JSON array or null where the header should be is not a bundle", async () => {
    await expectRejected(forgeBundle(bundle, { headerRaw: "null" }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { headerRaw: "[]" }), "BAD_FORMAT");
  });

  it("negative control: metadata and blob limits are enforced after the hash layer", async () => {
    await expectRejected(forgeBundle(bundle), "LIMIT_EXCEEDED", "PAYLOAD_TOO_LARGE", { max_metadata_bytes: 1000 });
    await expectRejected(forgeBundle(bundle), "LIMIT_EXCEEDED", "PAYLOAD_TOO_LARGE", { max_blob_bytes: 50, max_metadata_bytes: 10 * 1024 * 1024 });
  });
});

describe("run document consistency", () => {
  it("negative control: an invalid or mismatched run.json is rejected", async () => {
    await expectRejected(forgeBundle(bundle, { runRaw: "not json at all" }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { run: (r) => void delete r.drill }), "SCHEMA_INVALID");
    const otherId = ["00000000", "0000", "4000", "8000", "00000000beef"].join("-");
    await expectRejected(forgeBundle(bundle, { header: (h) => void (h.run_id = otherId) }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { run: (r) => void (r.drill.binding_digest = "1".repeat(64)) }), "BAD_FORMAT");
    await expectRejected(forgeBundle(bundle, { run: (r) => void (r.steps[0].drill_id = ["00000000", "0000", "4000", "8000", "00000000cafe"].join("-")) }), "BAD_FORMAT");
  });

  it("negative control: evidence that points at a missing blob, a wrong size or an unreferenced blob is rejected", async () => {
    await expectRejected(forgeBundle(bundle, { run: (r) => void (r.evidence[0].sha256 = "2".repeat(64)) }), "MISSING_FILE");
    await expectRejected(forgeBundle(bundle, { run: (r) => void (r.evidence[0].size_bytes += 5) }), "HASH_MISMATCH");
    await expectRejected(forgeBundle(bundle, { run: (r) => void (r.steps[0].evidence_hash = "3".repeat(64)) }), "MISSING_FILE");
    await expectRejected(forgeBundle(bundle, { run: (r) => void (r.evidence = r.evidence.slice(1)) }), "EXTRA_FILE");
  });
});

describe("export limits and conflicts", () => {
  it("negative control: exporting a run that exceeds the file or blob limit fails with PAYLOAD_TOO_LARGE and writes nothing", async () => {
    const out = join(makeTmp("hc-bv-"), "x.hcb");
    await expect(api.exportBundle(makeCtx({ storeDir: source.ctx.storeDir, limits: { max_files: 2 } }), { runId: source.result.run_id, outPath: out })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(api.exportBundle(makeCtx({ storeDir: source.ctx.storeDir, limits: { max_blob_bytes: 10 } }), { runId: source.result.run_id, outPath: out })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(api.exportBundle(makeCtx({ storeDir: source.ctx.storeDir }), { runId: "no-such-run", outPath: out })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(() => readFileSync(out)).toThrow();
  });

  it("an import into a store that already holds a conflicting object set rolls back (no partial state)", async () => {
    const target = makeCtx();
    await api.importBundle(target, { bundlePath: write(bundle) });
    const before = walkFiles(join(target.storeDir, "objects")).length;
    await expect(api.importBundle(target, { bundlePath: write(bundle) })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(walkFiles(join(target.storeDir, "objects")).length).toBe(before);
  });
});
