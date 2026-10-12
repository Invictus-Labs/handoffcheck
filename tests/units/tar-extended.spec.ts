// Extended tar formats and numeric edge cases of the product's tar reader (src/security/tar.ts).
import { describe, expect, it } from "vitest";
import { buildTar } from "../../scripts/build-fixture-release.mjs";
import { foldPathKey, isAsciiPath, resolveLinkInside } from "../../src/security/paths.js";
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

describe("case- and normalization-insensitive filesystems (default macOS APFS)", () => {
  it("negative control (P0): a write through a symlink named with different case is rejected (`L` link, `l/PWNED` file)", () => {
    const tar = buildTar([
      { path: "A/", type: "5" },
      { path: "A/up", type: "2", linkname: ".." },
      { path: "L", type: "2", linkname: "a/up/../.." },
      { path: "l/PWNED", data: "x" }
    ]);
    expect(code(() => readTar(tar, limits))).toBe("UNSAFE");
  });

  it("negative control (P1): a link chain that only escapes when `a` resolves to `A` is rejected as physically outside the root", () => {
    const tar = buildTar([
      { path: "A/", type: "5" },
      { path: "A/up", type: "2", linkname: ".." },
      { path: "s", type: "2", linkname: "a/up/a/up/../../../.." }
    ]);
    expect(() => readTar(tar, limits)).toThrow(/outside the archive root/);
  });

  it("negative control: entries whose paths collide after case folding or Unicode normalization are duplicates", () => {
    expect(code(() => readTar(buildTar([{ path: "Readme", data: "a" }, { path: "README", data: "b" }]), limits))).toBe("UNSAFE");
    expect(code(() => readTar(buildTar([{ path: "café", data: "a" }, { path: "café", data: "b" }]), limits))).toBe("UNSAFE");
  });

  it("still accepts an in-root link chain whose case matches", () => {
    const tar = buildTar([
      { path: "A/", type: "5" },
      { path: "A/up", type: "2", linkname: ".." },
      { path: "L", type: "2", linkname: "A/up/A" },
      { path: "A/f.txt", data: "x" }
    ]);
    expect(readTar(tar, limits).map((e) => e.path)).toEqual(["A", "A/up", "L", "A/f.txt"]);
  });
});

describe("non-ASCII archive names are refused (round 3: no attempt at a complete Unicode case fold)", () => {
  // APFS treats these spellings as one name, but no portable fold reproduces its rules: U+00DF (sharp s), U+1E9E (capital
  // sharp s) and "ss"; the Greek dialytika-tonos forms U+0390/U+03B0 and their decomposed/uppercased variants; NFC vs NFD
  const SHARP_S = "ß";
  const CAPITAL_SHARP_S = "ẞ";
  const nonAscii = [
    SHARP_S,
    CAPITAL_SHARP_S,
    "ΐ",
    "ΰ",
    "ΐ",
    "ΰ",
    "ΐ",
    "ΰ",
    "café",
    "café",
    "K" // KELVIN SIGN, which case-folds to ASCII "k"
  ];
  const message = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    return "NO_ERROR";
  };

  it("negative control (P0): the reviewer's sharp-s symlink chain is rejected (`d/U+1E9E -> ..`, `x -> d/U+00DF/d/U+00DF/../../../..`)", () => {
    const tar = buildTar([
      { path: "d/", type: "5" },
      { path: `d/${CAPITAL_SHARP_S}`, type: "2", linkname: ".." },
      { path: "x", type: "2", linkname: `d/${SHARP_S}/d/${SHARP_S}/../../../..` }
    ]);
    expect(code(() => readTar(tar, limits))).toBe("UNSAFE");
    expect(message(() => readTar(tar, limits))).toMatch(/non-ASCII/);
  });

  it("negative control: an ASCII link reached through a non-ASCII alias in a target is rejected (`d/ss -> ..`, `x -> d/U+00DF/../..`)", () => {
    const tar = buildTar([
      { path: "d/", type: "5" },
      { path: "d/ss", type: "2", linkname: ".." },
      { path: "x", type: "2", linkname: `d/${SHARP_S}/../..` }
    ]);
    expect(message(() => readTar(tar, limits))).toMatch(/target with non-ASCII/);
  });

  it("negative control: every non-ASCII spelling (sharp s, Greek dialytika-tonos, NFC/NFD) is refused as a name and as a link target", () => {
    for (const n of nonAscii) {
      expect(message(() => readTar(buildTar([{ path: `dir/${n}`, data: "x" }]), limits)), JSON.stringify(n)).toMatch(/non-ASCII/);
      expect(message(() => readTar(buildTar([{ path: `${n}/`, type: "5" }]), limits)), JSON.stringify(n)).toMatch(/non-ASCII/);
      expect(message(() => readTar(buildTar([{ path: "l", type: "2", linkname: n }]), limits)), JSON.stringify(n)).toMatch(/non-ASCII/);
    }
    // NFC and NFD forms of the same name are both refused, so they can never be staged as two different files
    expect(code(() => readTar(buildTar([{ path: "café".normalize("NFD"), data: "x" }]), limits))).toBe("UNSAFE");
    expect(code(() => readTar(buildTar([{ path: "café".normalize("NFC"), data: "x" }]), limits))).toBe("UNSAFE");
  });

  it("negative control: plain ASCII case collisions are still duplicates (file/file, dir/file, nested, link/dir)", () => {
    expect(message(() => readTar(buildTar([{ path: "ss", data: "a" }, { path: "SS", data: "b" }]), limits))).toMatch(/duplicate entry/);
    expect(message(() => readTar(buildTar([{ path: "Dir/", type: "5" }, { path: "dir", data: "b" }]), limits))).toMatch(/duplicate entry/);
    expect(message(() => readTar(buildTar([{ path: "a/B/c", data: "a" }, { path: "A/b/C", data: "b" }]), limits))).toMatch(/duplicate entry/);
    expect(message(() => readTar(buildTar([{ path: "Link", type: "2", linkname: "x" }, { path: "LINK/", type: "5" }]), limits))).toMatch(/duplicate entry/);
  });

  it("negative control: a write through an in-root link spelled with different ASCII case is rejected (`l -> A` + `L/x`, `L -> A` + `l/x`)", () => {
    for (const [link, file] of [["l", "L/x"], ["L", "l/x"]] as const) {
      const tar = buildTar([
        { path: "A/", type: "5" },
        { path: link, type: "2", linkname: "A" },
        { path: file, data: "x" }
      ]);
      expect(message(() => readTar(tar, limits)), `${link} ${file}`).toMatch(/written through a symlink/);
    }
  });

  it("resolveLinkInside folds raw (unfolded) link maps itself and refuses non-ASCII hops", () => {
    const links = new Map([["A/up", ".."]]);
    expect(resolveLinkInside("s", "a/up/a/up/../..", links)).toBeNull();
    expect(resolveLinkInside("s", "a/up/A", links)).toBe("A");
    expect(resolveLinkInside("s", `d/${SHARP_S}`, new Map())).toBeNull();
    expect(resolveLinkInside("s", "d/x", new Map([[`d/${CAPITAL_SHARP_S}`, ".."]]))).toBeNull();
    expect(resolveLinkInside("s", "d/x", new Map([["d/x", SHARP_S]]))).toBeNull();
    expect(foldPathKey("AbC/É")).toBe("abc/É"); // ASCII-only fold: non-ASCII never reaches it from the tar reader
    expect(isAsciiPath("plain/ascii name.txt")).toBe(true);
    expect(isAsciiPath(`a/${SHARP_S}`)).toBe(false);
    expect(isAsciiPath("tab\there")).toBe(false);
  });
});
