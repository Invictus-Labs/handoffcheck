import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../domain/canonical.js";
import { HandoffCheckError } from "../domain/errors.js";

const SHA_RE = /^[0-9a-f]{64}$/;

/** Content-addressed object store: `objects/<aa>/<sha256>`, owner-only permissions, atomic writes. */
export class ObjectStore {
  readonly root: string;
  readonly staging: string;

  constructor(storeDir: string) {
    this.root = join(storeDir, "objects");
    this.staging = join(storeDir, ".staging");
    for (const dir of [this.root, this.staging]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  }

  pathFor(sha: string): string {
    if (!SHA_RE.test(sha)) throw new HandoffCheckError("BAD_REQUEST", "object id must be a lowercase sha256 hex digest");
    return join(this.root, sha.slice(0, 2), sha);
  }

  has(sha: string): boolean {
    return existsSync(this.pathFor(sha));
  }

  /** Store bytes under their own digest. Returns whether a new file was created. */
  put(bytes: Uint8Array): { sha256: string; created: boolean } {
    const sha256 = sha256Hex(bytes);
    const dest = this.pathFor(sha256);
    if (existsSync(dest)) return { sha256, created: false };
    const dir = join(this.root, sha256.slice(0, 2));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.staging, `${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, dest);
    chmodSync(dest, 0o600);
    return { sha256, created: true };
  }

  /** Read and re-verify the digest; a mismatch means the store was tampered with. */
  read(sha: string): Buffer {
    const path = this.pathFor(sha);
    if (!existsSync(path)) throw new HandoffCheckError("NOT_FOUND", `evidence object ${sha.slice(0, 12)} is missing from the store`);
    const data = readFileSync(path);
    if (sha256Hex(data) !== sha) throw new HandoffCheckError("BUNDLE_CORRUPT", `evidence object ${sha.slice(0, 12)} failed its hash check`);
    return data;
  }

  size(sha: string): number {
    return statSync(this.pathFor(sha)).size;
  }

  remove(sha: string): void {
    rmSync(this.pathFor(sha), { force: true });
  }
}
