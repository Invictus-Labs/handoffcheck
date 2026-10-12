import { lstatSync } from "node:fs";
import { posix, resolve, sep } from "node:path";

const MAX_PATH = 512;

/** True for a clean relative path: no NUL, no backslash, no absolute/drive prefix, no `.`/`..`/empty segments. */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH) return false;
  if (p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** Normalizes `./a//b` style input to `a/b`; returns null when the path is unsafe. */
export function normalizeRelativePath(p: string): string | null {
  if (typeof p !== "string" || p.includes("\0") || p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..")) return null;
  const out = parts.join("/");
  return out.length > MAX_PATH ? null : out;
}

/** Resolve `rel` under `root`, guaranteeing the result stays inside `root` lexically. Returns null otherwise. */
export function resolveInside(root: string, rel: string): string | null {
  if (!isSafeRelativePath(rel)) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full.startsWith(base + sep) ? full : null; // a safe relative path never resolves to the root itself
}

/** True when any existing component of `rel` under `root` is a symlink. Missing components are not symlinks. */
export function hasSymlinkComponent(root: string, rel: string): boolean {
  let cur = resolve(root);
  for (const seg of rel.split("/")) {
    cur = resolve(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** A symlink target is acceptable only if it is relative and stays inside the extraction root. */
export function symlinkStaysInside(entryPath: string, target: string): boolean {
  if (target === "" || target.includes("\0") || target.startsWith("/") || /^[A-Za-z]:/.test(target) || target.includes("\\")) return false;
  const joined = posix.normalize(posix.join(posix.dirname(entryPath), target));
  return !(joined === ".." || joined.startsWith("../") || joined.startsWith("/"));
}

/** Syntactic checks for a symlink target: non-empty, relative, no NUL, no backslash, no drive prefix. */
export function linkTargetSyntaxOk(target: string): boolean {
  return target !== "" && !target.includes("\0") && !target.startsWith("/") && !/^[A-Za-z]:/.test(target) && !target.includes("\\");
}

/**
 * True when every character of `p` is printable ASCII (0x20-0x7e). Archive entry names and symlink targets must pass this:
 * a case- and normalization-insensitive filesystem (default macOS APFS) folds non-ASCII names with rules no portable
 * function reproduces exactly (ß/ẞ/ss, Greek dialytika-tonos forms, NFC/NFD, the Kelvin sign), so instead of attempting a
 * complete Unicode case fold the tar reader and the host staging code refuse non-ASCII names outright (a documented safety
 * limitation: such artifacts are rejected even though they would be valid on Linux).
 */
export function isAsciiPath(p: string): boolean {
  return /^[\x20-\x7e]*$/.test(p);
}

/**
 * Fold an ASCII relative path the way a case-insensitive filesystem (default macOS APFS) compares names: ASCII case only.
 * Two ASCII archive paths with the same folded key name the same file on such a filesystem. Only meaningful for paths that
 * pass {@link isAsciiPath}; non-ASCII paths are rejected before folding, so no Unicode case or normalization fold is attempted.
 */
export function foldPathKey(p: string): string {
  return p.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

// folded copies of link maps, built once per map (readTar resolves every link against the same map)
const foldedCache = new WeakMap<ReadonlyMap<string, string>, Map<string, string> | null>();
function foldedLinks(raw: ReadonlyMap<string, string>): Map<string, string> | null {
  let folded = foldedCache.get(raw);
  if (folded === undefined) {
    folded = new Map<string, string>();
    for (const [k, v] of raw) {
      if (!isAsciiPath(k)) {
        folded = null;
        break;
      }
      folded.set(foldPathKey(k), v);
    }
    foldedCache.set(raw, folded);
  }
  return folded;
}

/**
 * Physically resolve a symlink target inside an archive tree. `links` maps every symlink path in the archive to its
 * target, so chains (d/s1 -> .., d/s2 -> ../d/s1/..) are expanded exactly as the filesystem would after extraction.
 * Returns the normalized in-root path the link finally points at, or null when it escapes the root (a `..` above the
 * root at any hop), is not syntactically valid or not ASCII, or loops / chains deeper than 40 hops. Link lookups are
 * ASCII case-insensitive ({@link foldPathKey}, applied here to the keys of `links`), so `a/up` finds the link `A/up` exactly
 * as a case-insensitive filesystem would. Any non-ASCII path or target makes the result null (see {@link isAsciiPath}).
 */
export function resolveLinkInside(entryPath: string, target: string, rawLinks: ReadonlyMap<string, string>): string | null {
  if (!linkTargetSyntaxOk(target) || !isAsciiPath(target) || !isAsciiPath(entryPath)) return null;
  const links = foldedLinks(rawLinks);
  if (links === null) return null;
  let hops = 0;
  // components still to process, and the already-resolved directory stack
  let pending = target.split("/");
  let stack = entryPath.split("/").slice(0, -1);
  while (pending.length > 0) {
    const seg = pending.shift() as string;
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
    const here = stack.join("/");
    const link = links.get(foldPathKey(here));
    if (link !== undefined) {
      hops += 1;
      if (hops > 40 || !linkTargetSyntaxOk(link) || !isAsciiPath(link)) return null;
      stack = stack.slice(0, -1);
      pending = [...link.split("/"), ...pending];
    }
  }
  return stack.join("/");
}
