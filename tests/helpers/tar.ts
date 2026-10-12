// Independent minimal ustar reader for tests (does not reuse the product's tar code).
export interface TarEntryRead {
  name: string;
  type: string;
  data: Buffer;
  linkname: string;
}

export function readTarEntries(buf: Buffer): TarEntryRead[] {
  const entries: TarEntryRead[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (s: number, l: number) => h.subarray(s, s + l).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = str(156, 1) || "0";
    off += 512;
    const data = Buffer.from(buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
    entries.push({ name: str(0, 100), type, data, linkname: str(157, 100) });
  }
  return entries;
}
