import { gunzipSync } from "node:zlib";
import type { ArtifactEntry } from "../domain/types.js";
import { linkTargetSyntaxOk, normalizeRelativePath, resolveLinkInside } from "./paths.js";

export type TarErrorCode = "TRUNCATED" | "UNSAFE" | "LIMIT" | "FORMAT" | "TRAILING_DATA";

export class TarError extends Error {
  readonly code: TarErrorCode;
  constructor(code: TarErrorCode, message: string) {
    super(message);
    this.name = "TarError";
    this.code = code;
  }
}

export interface TarLimits {
  maxEntries: number;
  /** Cumulative size of all entry payloads. */
  maxTotalBytes: number;
  /** "in-root": relative symlinks that stay inside the tree are allowed; "none": any symlink is rejected. */
  symlinks: "in-root" | "none";
  /** When true, bytes after the end-of-archive marker must be zero padding only. */
  strictTrailing: boolean;
}

const BLOCK = 512;

function readString(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  const stop = end === -1 || end > off + len ? off + len : end;
  return buf.toString("utf8", off, stop);
}

function readOctal(buf: Buffer, off: number, len: number): number {
  if (((buf[off] as number) & 0x80) !== 0) {
    // GNU base-256 encoding
    let value = (buf[off] as number) & 0x7f;
    for (let i = 1; i < len; i++) value = value * 256 + (buf[off + i] as number);
    if (!Number.isSafeInteger(value)) throw new TarError("FORMAT", "numeric field out of range");
    return value;
  }
  const s = buf.toString("ascii", off, off + len).replace(/\0.*$/s, "").trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError("FORMAT", "invalid numeric field in tar header");
  return parseInt(s, 8);
}

function isZeroBlock(buf: Buffer, off: number): boolean {
  for (let i = 0; i < BLOCK; i++) if (buf[off + i] !== 0) return false;
  return true;
}

function checksumOk(buf: Buffer, off: number): boolean {
  const stored = readOctal(buf, off + 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (buf[off + i] as number);
  return sum === stored;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new TarError("FORMAT", "malformed pax record");
    const len = parseInt(data.toString("ascii", pos, space), 10);
    if (!Number.isFinite(len) || len <= space - pos + 1 || pos + len > data.length) throw new TarError("FORMAT", "malformed pax record length");
    const record = data.toString("utf8", space + 1, pos + len - 1);
    const eq = record.indexOf("=");
    if (eq === -1) throw new TarError("FORMAT", "malformed pax record");
    out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Inflate gzip input with a hard output cap (zip-bomb safe). Non-gzip input is returned as is. */
export function inflateIfGzip(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf, { maxOutputLength: maxBytes + 1024 * 1024 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw new TarError("LIMIT", `decompressed size exceeds ${maxBytes} bytes`);
      throw new TarError("FORMAT", "invalid or truncated gzip stream");
    }
  }
  return buf;
}

/**
 * Parse a tar archive fully in memory with strict safety checks. Header-declared sizes and entry counts are checked
 * before any payload is sliced. Throws TarError; never touches the filesystem.
 */
export function readTar(input: Buffer, limits: TarLimits): ArtifactEntry[] {
  const entries: ArtifactEntry[] = [];
  const seen = new Set<string>();
  let off = 0;
  let total = 0;
  let pendingPax: Record<string, string> | null = null;
  let pendingLongName: string | null = null;
  let pendingLongLink: string | null = null;
  let endSeen = false;

  while (off < input.length) {
    if (off + BLOCK > input.length) throw new TarError("TRUNCATED", "archive ends inside a header block");
    if (isZeroBlock(input, off)) {
      // end of archive needs two zero blocks; tolerate one only if the file ends right there with padding
      if (off + 2 * BLOCK <= input.length && isZeroBlock(input, off + BLOCK)) {
        endSeen = true;
        if (limits.strictTrailing) {
          for (let i = off; i < input.length; i++) if (input[i] !== 0) throw new TarError("TRAILING_DATA", "unexpected data after the end-of-archive marker");
        }
        break;
      }
      throw new TarError("TRUNCATED", "archive end marker is incomplete");
    }
    if (!checksumOk(input, off)) throw new TarError("FORMAT", "tar header checksum mismatch");

    const typeflag = String.fromCharCode(input[off + 156] as number);
    const size = readOctal(input, off + 124, 12);
    const dataStart = off + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + size > input.length) throw new TarError("TRUNCATED", "archive ends inside an entry payload");
    total += size;
    if (total > limits.maxTotalBytes) throw new TarError("LIMIT", `archive payload exceeds ${limits.maxTotalBytes} bytes`);

    const payload = input.subarray(dataStart, dataStart + size);
    off = dataStart + padded;

    if (typeflag === "x") {
      pendingPax = parsePax(payload);
      continue;
    }
    if (typeflag === "g") continue;
    if (typeflag === "L") {
      pendingLongName = payload.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (typeflag === "K") {
      pendingLongLink = payload.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }

    const headerStart = dataStart - BLOCK;
    const prefix = readString(input, headerStart + 345, 155);
    let name = readString(input, headerStart, 100);
    if (prefix) name = `${prefix}/${name}`;
    let linkname = readString(input, headerStart + 157, 100);
    if (pendingLongName !== null) name = pendingLongName;
    if (pendingLongLink !== null) linkname = pendingLongLink;
    if (pendingPax) {
      if (pendingPax["path"]) name = pendingPax["path"];
      if (pendingPax["linkpath"]) linkname = pendingPax["linkpath"];
    }
    pendingPax = null;
    pendingLongName = null;
    pendingLongLink = null;

    if (entries.length + 1 > limits.maxEntries) throw new TarError("LIMIT", `archive has more than ${limits.maxEntries} entries`);

    const isDir = typeflag === "5" || (name.endsWith("/") && (typeflag === "0" || typeflag === "\0"));
    // `tar -C dir .` emits the archive root itself ("./"): it names nothing, skip it
    if (isDir && /^(\.\/?)+$/.test(name.replace(/\/+$/, "/"))) continue;
    const clean = normalizeRelativePath(isDir ? name.replace(/\/+$/, "") : name);
    if (clean === null) throw new TarError("UNSAFE", `unsafe entry path ${JSON.stringify(name.slice(0, 80))}`);
    if (seen.has(clean)) throw new TarError("UNSAFE", `duplicate entry ${JSON.stringify(clean)}`);
    seen.add(clean);
    const mode = readOctal(input, headerStart + 100, 8) & 0o777;

    if (typeflag === "0" || typeflag === "\0") {
      if (isDir) entries.push({ path: clean, type: "directory", mode: mode || 0o755 });
      else entries.push({ path: clean, type: "file", mode: mode || 0o644, data: payload });
    } else if (typeflag === "5") {
      entries.push({ path: clean, type: "directory", mode: mode || 0o755 });
    } else if (typeflag === "2") {
      if (limits.symlinks === "none") throw new TarError("UNSAFE", `symlink entries are not allowed (${JSON.stringify(clean)})`);
      if (!linkTargetSyntaxOk(linkname)) throw new TarError("UNSAFE", `symlink ${JSON.stringify(clean)} has an absolute or malformed target`);
      entries.push({ path: clean, type: "symlink", mode: 0o777, linkname });
    } else if (typeflag === "1") {
      throw new TarError("UNSAFE", `hard link entries are not allowed (${JSON.stringify(clean)})`);
    } else {
      throw new TarError("UNSAFE", `unsupported entry type ${JSON.stringify(typeflag)} for ${JSON.stringify(clean)}`);
    }
  }

  if (!endSeen) throw new TarError("TRUNCATED", "archive has no end-of-archive marker");
  // physical containment: resolve every link through the complete link map so chains cannot climb out of the root
  const linkMap = new Map(entries.filter((e) => e.type === "symlink").map((e) => [e.path, e.linkname as string]));
  for (const [path, target] of linkMap) {
    if (resolveLinkInside(path, target, linkMap) === null) throw new TarError("UNSAFE", `symlink ${JSON.stringify(path)} points outside the archive root (physically resolved)`);
  }
  // symlink chains must not let a later file be written through an earlier symlink
  const links = new Set(entries.filter((e) => e.type === "symlink").map((e) => e.path));
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (links.has(parts.slice(0, i).join("/"))) throw new TarError("UNSAFE", `entry ${JSON.stringify(e.path)} is written through a symlink`);
    }
  }
  return entries;
}

function octal(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, "0") + "\0";
}

export interface TarWriteEntry {
  path: string;
  data?: Uint8Array;
  mode?: number;
  type?: "file" | "directory" | "symlink";
  linkname?: string;
}

/** Deterministic ustar writer (mtime fixed, owner 0). Paths over 100 bytes are split into prefix/name (max 255). */
export function writeTar(entries: readonly TarWriteEntry[], mtime = 0): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "file";
    let name = e.path;
    if (type === "directory" && !name.endsWith("/")) name += "/";
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const idx = name.lastIndexOf("/", name.length - 2);
      const p = name.slice(0, idx);
      const n = name.slice(idx + 1);
      if (idx <= 0 || Buffer.byteLength(p) > 155 || Buffer.byteLength(n) > 100) throw new Error(`tar path too long: ${e.path.slice(0, 40)}...`);
      prefix = p;
      name = n;
    }
    const data = type === "file" ? Buffer.from(e.data ?? new Uint8Array()) : Buffer.alloc(0);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, "utf8");
    header.write(octal(e.mode ?? (type === "directory" ? 0o755 : 0o644), 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii");
    header.write(octal(0, 8), 116, 8, "ascii");
    header.write(octal(data.length, 12), 124, 12, "ascii");
    header.write(octal(mtime, 12), 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write(type === "directory" ? "5" : type === "symlink" ? "2" : "0", 156, 1, "ascii");
    if (type === "symlink") header.write(e.linkname ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += header[i] as number;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}
