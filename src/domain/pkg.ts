import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version from the nearest package.json at or above `startDir` that names this package ("0.0.0" when none is found).
 * Exported with a parameter so it can be tested against temporary directory trees.
 */
export function readPackageVersion(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "handoffcheck") return pkg.version as string;
    }
    const parent = dirname(dir);
    if (parent === dir) return "0.0.0";
    dir = parent;
  }
}

let cached: string | null = null;

/** Version of the running package (for bundle producer metadata). */
export function packageVersion(): string {
  cached ??= readPackageVersion(dirname(fileURLToPath(import.meta.url)));
  return cached;
}
