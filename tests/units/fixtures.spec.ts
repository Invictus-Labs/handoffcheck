// The fixtures are the ground truth of the QA suite, so they must stay deterministic and consistent with
// fixtures/demo.json, and must contain only planted fakes.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixtureRelease, collectVariantTree, FIXTURE_MTIME } from "../../scripts/build-fixture-release.mjs";
import { findCredentials } from "../../src/security/patterns.js";
import { DRILL_DIR, DRILL_SH_DIR, FIXTURES } from "../helpers/drill.js";
import { readTarEntries } from "../helpers/tar.js";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const demo = JSON.parse(readFileSync(join(FIXTURES, "demo.json"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("fixture determinism and consistency (fixtures/demo.json)", () => {
  it("builds byte-identical artifacts whose hashes match demo.json, for both variants", () => {
    for (const variant of ["node", "sh"] as const) {
      const a = buildFixtureRelease({}, [], variant);
      const b = buildFixtureRelease({}, [], variant);
      expect(a.equals(b)).toBe(true);
      expect(sha(a)).toBe(demo.releases[variant].artifact_sha256);
      expect(collectVariantTree(variant).length).toBe(demo.releases[variant].files);
    }
  });

  it("uses fixed mtimes, root ownership and sorted entries (the artifact digest must not depend on the host)", () => {
    const tar = buildFixtureRelease();
    const entries = readTarEntries(tar);
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort());
    expect(tar.readUIntBE(0, 1)).toBeGreaterThan(0);
    for (let off = 0, i = 0; i < entries.length; i++) {
      const mtime = parseInt(tar.toString("ascii", off + 136, off + 147), 8);
      expect(mtime).toBe(FIXTURE_MTIME);
      const size = parseInt(tar.toString("ascii", off + 124, off + 135), 8);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(demo.clock.tar_mtime_epoch).toBe(FIXTURE_MTIME);
  });

  it("seed records, selected hashes and blob hashes match the dataset described in demo.json", () => {
    const lines = readFileSync(join(FIXTURES, "release", "seed", "records.ndjson"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(demo.dataset.record_count);
    for (const [id, want] of Object.entries(demo.dataset.selected_record_sha256 as Record<string, string>)) {
      expect(sha(lines.find((l) => (JSON.parse(l) as { id: string }).id === id) as string), id).toBe(want);
    }
    for (const blob of demo.dataset.blob_sha256 as string[]) expect(sha(readFileSync(join(FIXTURES, "release", "seed", "blobs", `${blob}.bin`))), blob).toBe(blob);
    expect((readFileSync(join(FIXTURES, "release", "seed", "jobs.ndjson"), "utf8").match(/"poison":true/g) ?? []).length).toBe(1);
  });

  it("the drill manifests expect exactly the dataset in demo.json", async () => {
    const YAML = (await import("yaml")).default;
    for (const dir of [DRILL_DIR, DRILL_SH_DIR]) {
      const m = YAML.parse(readFileSync(join(dir, "drill.yaml"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const restore = m.steps.find((s: { action: string }) => s.action === "restore");
      expect(restore.expect.record_counts).toEqual({ notes: demo.dataset.record_count, blobs: demo.dataset.blob_count });
      expect(restore.expect.data_hashes).toEqual(demo.dataset.selected_record_sha256);
      expect(restore.expect.blobs.map((b: { sha256: string }) => b.sha256).sort()).toEqual([...demo.dataset.blob_sha256].sort());
      expect(m.synthetic_secrets).toEqual(demo.planted_secrets);
      expect(m.scenario.synthetic).toBe(true);
    }
  });

  it("negative control: the shipped fixtures contain no production-credential-shaped value and every credential carries the HCFAKE marker", () => {
    const seen = new Set<string>();
    for (const variant of ["node", "sh"] as const) {
      for (const entry of collectVariantTree(variant)) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        expect(findCredentials(entry.data.toString("utf8")), entry.path).toEqual([]);
      }
    }
    for (const dir of [DRILL_DIR, DRILL_SH_DIR]) {
      for (const name of readdirSync(join(dir, "scripts"))) expect(findCredentials(readFileSync(join(dir, "scripts", name), "utf8")), `${dir}/${name}`).toEqual([]);
      expect(findCredentials(readFileSync(join(dir, "drill.yaml"), "utf8"))).toEqual([]);
    }
    for (const token of demo.planted_secrets as string[]) expect(token).toContain("HCFAKE");
    expect(readFileSync(join(FIXTURES, "release", "config", "service.env"), "utf8")).toContain(demo.planted_secrets[0]);
  });
});
