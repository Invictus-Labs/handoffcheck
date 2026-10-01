export const FIXTURE_MTIME: number;
export const RELEASE_DIR: string;
export interface TarEntry {
  path: string;
  data?: Buffer | string;
  mode?: number;
  /** ustar type flag: "0" file (default), "5" directory, "2" symlink. */
  type?: string;
  linkname?: string;
  /** Size written into the header instead of the real data length (archive-bomb / truncation tests). */
  declaredSize?: number;
}
export interface TreeEntry {
  path: string;
  data: Buffer;
  mode: number;
}
export function collectTree(dir?: string): TreeEntry[];
export function buildTar(entries: TarEntry[]): Buffer;
export function sha256Hex(buf: Buffer | string): string;
/** Build the fixture release tar. overrides: path -> new text content, or null to drop the file. extra: appended entries. */
export function buildFixtureRelease(overrides?: Record<string, string | null>, extra?: TarEntry[], variant?: "node" | "sh"): Buffer;
export const RELEASE_SH_DIR: string;
export function collectVariantTree(variant?: "node" | "sh"): TreeEntry[];
