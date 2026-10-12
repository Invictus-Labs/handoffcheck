import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** Version from the nearest package.json (works from src/ and from dist/src/). */
export function toolVersion(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "handoffcheck" && pkg.version) {
        cached = pkg.version;
        return cached;
      }
    }
    dir = dirname(dir);
  }
  cached = "0.0.0-unknown";
  return cached;
}
