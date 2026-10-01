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
 * Physically resolve a symlink target inside an archive tree. `links` maps every symlink path in the archive to its
 * target, so chains (d/s1 -> .., d/s2 -> ../d/s1/..) are expanded exactly as the filesystem would after extraction.
 * Returns the normalized in-root path the link finally points at, or null when it escapes the root (a `..` above the
 * root at any hop), is not syntactically valid, or loops / chains deeper than 40 hops.
 */
export function resolveLinkInside(entryPath: string, target: string, links: ReadonlyMap<string, string>): string | null {
  if (!linkTargetSyntaxOk(target)) return null;
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
    const link = links.get(here);
    if (link !== undefined) {
      hops += 1;
      if (hops > 40 || !linkTargetSyntaxOk(link)) return null;
      stack = stack.slice(0, -1);
      pending = [...link.split("/"), ...pending];
    }
  }
  return stack.join("/");
}
