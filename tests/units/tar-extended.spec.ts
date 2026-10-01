// Extended tar formats and numeric edge cases of the product's tar reader (src/security/tar.ts).
import { describe, expect, it } from "vitest";
import { buildTar } from "../../scripts/build-fixture-release.mjs";
import { TarError, readTar, type TarLimits } from "../../src/security/tar.js";

const limits: TarLimits = { maxEntries: 100, maxTotalBytes: 1024 * 1024, symlinks: "in-root", strictTrailing: true };
const pax = (kv: Record<string, string>): string =>
  Object.entries(kv)
    .map(([k, v]) => {
      const body = ` ${k}=${v}\n`;
      let len = body.length + 1;
      while (String(len).length + body.length !== len) len = String(len).length + body.length;
      return `${len}${body}`;
    })
    .join("");
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TarError);
    return (e as TarError).code;
  }
  return "NO_ERROR";
};

describe("pax and GNU extended headers", () => {
  it("applies pax path and linkpath overrides to the following entry and ignores global headers", () => {
    const long = `${"a".repeat(120)}/file.txt`;
    const tar = buildTar([
      { path: "pax-global", type: "g", data: pax({ comment: "ignored" }) },
      { path: "pax-header", type: "x", data: pax({ path: long }) },
      { path: "short.txt", data: "hello" },
      { path: "pax-link", type: "x", data: pax({ linkpath: "target.txt" }) },
      { path: "link", type: "2", linkname: "ignored" },
      { path: "target.txt", data: "t" }
    ]);
    const entries = readTar(tar, limits);
    expect(entries.map((e) => e.path)).toEqual([long, "link", "target.txt"]);
    expect(entries[1]?.linkname).toBe("target.txt");
  });

  it("applies GNU long name and long link records", () => {
    const longName = `${"b".repeat(150)}.txt`;
    const tar = buildTar([
      { path: "././@LongLink", type: "L", data: `${longName}\0` },
      { path: "placeholder", data: "x" },
      { path: "././@LongLink", type: "K", data: "dest.txt\0" },
      { path: "lnk", type: "2", linkname: "ignored" }
    ]);
    const entries = readTar(tar, limits);
    expect(entries[0]?.path).toBe(longName);
    expect(entries[1]?.linkname).toBe("dest.txt");
  });

  it("negative control: malformed pax records are rejected", () => {
    for (const bad of ["nospace", "99 path=x\n", "12 nopath\n", "abc path=x\n"]) {
      const tar = buildTar([{ path: "h", type: "x", data: bad }, { path: "f", data: "x" }]);
      expect(code(() => readTar(tar, limits)), JSON.stringify(bad)).toBe("FORMAT");
    }
  });

  it("negative control: an unsafe path smuggled in through a pax or GNU record is rejected", () => {
    expect(code(() => readTar(buildTar([{ path: "h", type: "x", data: pax({ path: "../escape" }) }, { path: "f", data: "x" }]), limits))).toBe("UNSAFE");
    expect(code(() => readTar(buildTar([{ path: "h", type: "L", data: "/abs/path\0" }, { path: "f", data: "x" }]), limits))).toBe("UNSAFE");
  });
});

describe("tar entry kinds and numeric fields", () => {
  it("reads directory entries (typeflag 5 and trailing slash), NUL typeflag files and default modes", () => {
    const tar = buildTar([{ path: "d1", type: "5", mode: 0 }, { path: "d2/", data: "", mode: 0 }, { path: "d1/f", data: "x", mode: 0 }]);
    const entries = readTar(tar, limits);
    expect(entries.map((e) => `${e.type}:${e.path}`)).toEqual(["directory:d1", "directory:d2", "file:d1/f"]);
    expect(entries[2]?.mode).toBe(0o644);
    expect(entries[0]?.mode).toBe(0o755);
    const nul = Buffer.from(buildTar([{ path: "n", data: "z" }]));
    nul[156] = 0;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (nul[i] ?? 0);
    nul.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    expect(readTar(nul, limits)[0]?.type).toBe("file");
  });

  it("accepts a GNU base-256 encoded size and rejects non-octal numeric fields", () => {
    const base = Buffer.from(buildTar([{ path: "f", data: "abc" }]));
    const b256 = Buffer.from(base);
    b256.fill(0, 124, 136);
    b256[124] = 0x80;
    b256[135] = 3;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (b256[i] ?? 0);
    b256.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    expect(Buffer.from(readTar(b256, limits)[0]?.data ?? []).toString()).toBe("abc");
    const bad = Buffer.from(base);
    bad.write("zzzzzzzzzzz\0", 124, "ascii");
    expect(code(() => readTar(bad, limits))).toBe("FORMAT");
    const huge = Buffer.from(base);
    huge.fill(0xff, 125, 136);
    huge[124] = 0x80;
    expect(["FORMAT", "TRUNCATED", "LIMIT"]).toContain(code(() => readTar(huge, limits)));
  });

  it("negative control: an unsupported entry type and a header-only truncation are rejected", () => {
    expect(code(() => readTar(buildTar([{ path: "x", type: "6" }]), limits))).toBe("UNSAFE");
    expect(code(() => readTar(buildTar([{ path: "a", data: "x" }]).subarray(0, 700), limits))).toBe("TRUNCATED");
    const oneZero = Buffer.concat([buildTar([{ path: "a", data: "x" }]).subarray(0, 1024), Buffer.alloc(512)]);
    expect(code(() => readTar(oneZero, limits))).toBe("TRUNCATED");
  });

  it("an empty archive that has only the end marker is valid and empty", () => {
    expect(readTar(buildTar([]), limits)).toEqual([]);
  });
});
