#!/usr/bin/env node
// Builds a byte-for-byte deterministic ustar archive of the synthetic fixture release.
// Fixed mtime, uid/gid 0, sorted entries, no host tar dependency: same input => same sha256.
// Usage: node scripts/build-fixture-release.mjs <out.tar> [--sha256] [--variant node|sh]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_MTIME = 1767225600; // 2026-01-01T00:00:00Z
const HERE = dirname(fileURLToPath(import.meta.url));
export const RELEASE_DIR = resolve(HERE, "..", "fixtures", "release");
export const RELEASE_SH_DIR = resolve(HERE, "..", "fixtures", "release-sh");

/** Collect the release tree as [{path, data(Buffer), mode}] sorted by path. */
export function collectTree(dir = RELEASE_DIR) {
  const entries = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else entries.push({ path: relative(dir, full).split(sep).join("/"), data: readFileSync(full), mode: st.mode & 0o111 ? 0o755 : 0o644 });
    }
  };
  walk(dir);
  return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";

function header(path, size, mode, type, linkname = "") {
  if (Buffer.byteLength(path) > 100) throw new Error(`path too long for plain ustar: ${path}`);
  const h = Buffer.alloc(512, 0);
  h.write(path, 0, "utf8");
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(FIXTURE_MTIME, 12), 136);
  h.write("        ", 148); // checksum placeholder (spaces)
  h.write(type, 156);
  if (linkname) h.write(linkname, 157, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** Build a tar Buffer from entries [{path, data, mode?, type?, linkname?, declaredSize?}]. Written in the given order. */
export function buildTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const type = e.type ?? "0";
    const size = ["0", "x", "g", "L", "K"].includes(type) ? data.length : 0;
    parts.push(header(e.path, e.declaredSize ?? size, e.mode ?? 0o644, type, e.linkname));
    if (size > 0) {
      parts.push(data);
      const pad = (512 - (size % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** Variant "sh": the POSIX-sh service (fixtures/release-sh) plus the shared seed, backup and config from fixtures/release. */
export function collectVariantTree(variant = "node") {
  if (variant === "node") return collectTree();
  const shared = collectTree().filter((e) => /^(seed|backup|config)\//.test(e.path));
  return [...collectTree(RELEASE_SH_DIR), ...shared].sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function buildFixtureRelease(overrides = {}, extra = [], variant = "node") {
  const tree = collectVariantTree(variant).filter((e) => !(e.path in overrides && overrides[e.path] === null));
  const files = tree.map((e) => (e.path in overrides && overrides[e.path] !== null ? { ...e, data: Buffer.from(overrides[e.path], "utf8") } : e));
  return buildTar([...files, ...extra]);
}

// Compare real paths: a symlinked temp directory or checkout (for example macOS /var -> /private/var) must still count as "run directly".
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write("usage: build-fixture-release.mjs <out.tar> [--sha256]\n");
    process.exit(2);
  }
  const vi = process.argv.indexOf("--variant");
  const tar = buildFixtureRelease({}, [], vi > 0 ? process.argv[vi + 1] : "node");
  writeFileSync(out, tar);
  if (process.argv.includes("--sha256")) process.stdout.write(`${sha256Hex(tar)}  ${out}\n`);
}
