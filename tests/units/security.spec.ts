// Unit tests for the decision code in src/security: credential/destination patterns, redaction, paths, tar parsing.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildTar } from "../../scripts/build-fixture-release.mjs";
import {
  CREDENTIAL_PATTERNS,
  findCredentials,
  findDestinations,
  isDestinationAllowed,
  isLoopbackHost
} from "../../src/security/patterns.js";
import { hasSymlinkComponent, isSafeRelativePath, normalizeRelativePath, resolveInside, symlinkStaysInside } from "../../src/security/paths.js";
import { Redactor, redactText } from "../../src/security/redact.js";
import { TarError, inflateIfGzip, readTar, writeTar, type TarLimits } from "../../src/security/tar.js";
import { DECOYS, DECOY_KINDS } from "../helpers/decoys.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

registerTmpCleanup();

describe("credential patterns", () => {
  for (const kind of DECOY_KINDS) {
    it(`detects the ${kind} decoy`, () => {
      expect(findCredentials(`value = ${DECOYS[kind]} # end`).length).toBeGreaterThan(0);
    });
  }

  it("covers every documented pattern family", () => {
    expect(CREDENTIAL_PATTERNS.map((p) => p.kind)).toEqual(
      expect.arrayContaining(["aws-access-key", "private-key", "github-token", "slack-token", "stripe-live-key", "google-api-key", "llm-api-key", "npm-token", "jwt"])
    );
    const samples: Record<string, string> = {
      "google-api-key": ["AI", "za", "SyA-1234567890abcdefghijklmnopqrstu"].join(""),
      "llm-api-key": ["s", "k-", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
      "npm-token": ["npm", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
      jwt: ["ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcdefghijklmnop"].join("")
    };
    for (const [kind, text] of Object.entries(samples)) {
      expect(findCredentials(text).map((m) => m.kind), kind).toContain(kind);
    }
  });

  it("negative control: a match that carries the synthetic HCFAKE marker is a planted fake, not a finding", () => {
    expect(findCredentials(["AK", "IAHCFAKE0123456789"].join(""))).toEqual([]);
    expect(findCredentials(["gh", "p_HCFAKE0123456789012345678901234567890"].join(""))).toEqual([]);
  });

  it("ordinary text, short strings and near-misses are not findings", () => {
    for (const text of ["", "hello world", "AKIA123", "sk-short", "xoxb-1", "the ghp_ prefix alone", "token", "BEGIN PRIVATE KEY (no dashes)"]) {
      expect(findCredentials(text), text).toEqual([]);
    }
  });

  it("flags a connection string with an embedded password to a remote host but not loopback or a planted fake", () => {
    const conn = (user: string, password: string, host: string) => ["postgres", "://", user, ":", password, "@", host, "/app"].join("");
    expect(findCredentials(conn("user", "hunter2hunter2", "db.example.org:5432")).map((m) => m.kind)).toContain("connection-string-password");
    expect(findCredentials(conn("user", "hunter2", "localhost"))).toEqual([]);
    expect(findCredentials(conn("user", "hunter2", "127.0.0.1"))).toEqual([]);
    expect(findCredentials(conn("user", "HCFAKE_pw", "db.example.org"))).toEqual([]);
    expect(findCredentials("https://example.org/path")).toEqual([]);
  });

  it("reports the match index so findings can be located", () => {
    const hit = findCredentials(`xx ${DECOYS.awsAccessKey}`)[0];
    expect(hit?.index).toBe(3);
  });
});

describe("network destinations", () => {
  it("detects URLs, host:port pairs after network tools and IPv4 literals", () => {
    const hosts = (t: string) => findDestinations(t).map((d) => d.host);
    expect(hosts("fetch https://updates.example.org/check")).toContain("updates.example.org");
    expect(hosts("curl --silent updates.example.org:8443/x")).toContain("updates.example.org");
    expect(hosts("ssh admin@jump.example.org")).toContain("jump.example.org");
    expect(hosts("nc 203.0.113.9 4444")).toContain("203.0.113.9");
    expect(hosts("addr=203.0.113.9")).toContain("203.0.113.9");
    expect(findDestinations("curl http://example.org:8080/a")[0]?.port).toBe("8080");
    expect(findDestinations("nothing to see here, version 1.2.3")).toEqual([]);
    expect(findDestinations("999.999.999.999")).toEqual([]);
  });

  it("allows loopback always and declared hosts, ports and wildcard suffixes only when declared", () => {
    const d = (host: string, port: string | null = null) => ({ host, port, source: "url" as const });
    expect(isDestinationAllowed(d("localhost"), [])).toBe(true);
    expect(isDestinationAllowed(d("127.4.5.6"), [])).toBe(true);
    expect(isDestinationAllowed(d("example.org"), [])).toBe(false);
    expect(isDestinationAllowed(d("example.org"), ["example.org"])).toBe(true);
    expect(isDestinationAllowed(d("example.org", "443"), ["example.org:443"])).toBe(true);
    expect(isDestinationAllowed(d("example.org", "444"), ["example.org:443"])).toBe(false);
    expect(isDestinationAllowed(d("a.example.org"), ["*.example.org"])).toBe(true);
    expect(isDestinationAllowed(d("example.org"), ["*.example.org"])).toBe(false);
    expect(isDestinationAllowed(d("evil-example.org"), ["example.org"])).toBe(false);
  });

  it("recognises loopback spellings", () => {
    for (const h of ["localhost", "LOCALHOST", "::1", "[::1]", "127.0.0.1", "127.255.255.254", "0.0.0.0"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["128.0.0.1", "example.org", "10.0.0.1", "1270.0.0.1"]) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe("redaction", () => {
  it("removes declared literals verbatim and in base64 and URL-encoded forms", () => {
    const secret = "HCFAKE_declared_value_1234";
    const r = new Redactor([secret]);
    const b64 = Buffer.from(secret).toString("base64");
    const out = r.redact(`a ${secret} b ${b64} c ${encodeURIComponent(secret + "/x")}`);
    expect(out.text).not.toContain(secret);
    expect(out.text).not.toContain(b64);
    expect(out.count).toBeGreaterThanOrEqual(2);
    expect(r.literalCount).toBeGreaterThan(1);
  });

  it("ignores literals shorter than the minimum so common words are not shredded", () => {
    const r = new Redactor(["ab", "  "]);
    expect(r.literalCount).toBe(0);
    expect(r.redact("ab ab ab").text).toBe("ab ab ab");
  });

  it("redacts credential patterns, authorization headers, secret assignments and connection-string passwords", () => {
    const text = [
      `key ${DECOYS.awsAccessKey}`,
      "Authorization: Bearer abcdef0123456789",
      "password=hunter2hunter2",
      "API_KEY: 'zzzz9999'",
      ["postgres", "://", "svc", ":", "pw-9999", "@", "db.example.org/app"].join(""),
      "planted HCFAKE_TOKEN_77"
    ].join("\n");
    const { text: out, count } = redactText(text);
    for (const leaked of [DECOYS.awsAccessKey, "abcdef0123456789", "hunter2hunter2", "zzzz9999", "pw-9999", "HCFAKE_TOKEN_77"]) expect(out).not.toContain(leaked);
    expect(out).toContain("[REDACTED:aws-access-key]");
    expect(out).toContain("[REDACTED:authorization-header]");
    expect(out).toContain("[REDACTED:connection-string-password]");
    expect(out).toContain("svc:");
    expect(count).toBeGreaterThanOrEqual(6);
  });

  it("is idempotent and leaves clean text untouched", () => {
    const text = `x ${DECOYS.githubToken} y password=abcdefgh`;
    const once = redactText(text).text;
    expect(redactText(once).text).toBe(once);
    expect(redactText("nothing secret here").count).toBe(0);
    expect(redactText("nothing secret here").text).toBe("nothing secret here");
  });

  it("negative control: a truncated stream cannot end in the first characters of a secret", () => {
    const secret = "HCFAKE_declared_value_1234";
    const r = new Redactor([secret]);
    const out = r.redact(`line one\nHCFAKE_declared_va`, { truncated: true });
    expect(out.text).not.toContain("HCFAKE_declared_va");
    expect(out.text).toContain("line one");
    const kept = r.redact("whole line ends here", { truncated: true });
    expect(kept.text).toBe("whole line ends here");
  });

  it("redacts bytes and reports the count", () => {
    const r = new Redactor(["HCFAKE_bytes_secret"]);
    const { bytes, count } = r.redactBytes(Buffer.from("x HCFAKE_bytes_secret y"));
    expect(Buffer.from(bytes).toString()).toBe("x [REDACTED:declared-secret] y");
    expect(count).toBe(1);
  });
});

describe("path safety", () => {
  it("accepts clean relative paths only", () => {
    for (const p of ["a", "a/b", "scripts/install.sh", "state/notes/blobs/x.bin"]) expect(isSafeRelativePath(p), p).toBe(true);
    for (const p of ["", "/abs", "../x", "a/../b", "a//b", "./a", "a/./b", "a\\b", "C:foo", "a\0b", "x".repeat(513)]) expect(isSafeRelativePath(p), JSON.stringify(p)).toBe(false);
  });

  it("normalizes harmless noise and rejects traversal", () => {
    expect(normalizeRelativePath("./a//b/")).toBe("a/b");
    expect(normalizeRelativePath("a/../b")).toBeNull();
    expect(normalizeRelativePath("/a")).toBeNull();
    expect(normalizeRelativePath("")).toBeNull();
    expect(normalizeRelativePath(".")).toBeNull();
    expect(normalizeRelativePath("C:\\x")).toBeNull();
    expect(normalizeRelativePath("a".repeat(600))).toBeNull();
  });

  it("resolves inside a root and refuses to leave it", () => {
    expect(resolveInside("/tmp/root", "a/b")).toBe("/tmp/root/a/b");
    expect(resolveInside("/tmp/root", "../x")).toBeNull();
    expect(resolveInside("/tmp/root", "/etc/passwd")).toBeNull();
  });

  it("detects symlink components on disk and in-root symlink targets", () => {
    const root = makeTmp("hc-paths-");
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "f"), "x");
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(hasSymlinkComponent(root, "real/f")).toBe(false);
    expect(hasSymlinkComponent(root, "link/f")).toBe(true);
    expect(hasSymlinkComponent(root, "missing/f")).toBe(false);
    expect(symlinkStaysInside("a/link", "../b")).toBe(true);
    expect(symlinkStaysInside("a/link", "../../b")).toBe(false);
    expect(symlinkStaysInside("link", "/etc/passwd")).toBe(false);
    expect(symlinkStaysInside("link", "")).toBe(false);
    expect(symlinkStaysInside("link", "..\\x")).toBe(false);
  });
});

describe("tar reading", () => {
  const limits: TarLimits = { maxEntries: 100, maxTotalBytes: 1024 * 1024, symlinks: "in-root", strictTrailing: true };
  const expectCode = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(TarError);
      expect((e as TarError).code).toBe(code);
      return;
    }
    throw new Error(`expected TarError ${code}`);
  };

  it("round-trips files, directories and in-root symlinks written by the product writer", () => {
    const tar = writeTar([
      { path: "dir", type: "directory" },
      { path: "dir/a.txt", data: Buffer.from("hello") },
      { path: "dir/link", type: "symlink", linkname: "a.txt" }
    ]);
    const entries = readTar(tar, limits);
    expect(entries.map((e) => `${e.type}:${e.path}`)).toEqual(["directory:dir", "file:dir/a.txt", "symlink:dir/link"]);
    expect(Buffer.from(entries[1]!.data!).toString()).toBe("hello");
  });

  it("reads archives built by the independent test builder (cross-implementation check)", () => {
    const tar = buildTar([{ path: "bin/x.sh", data: "echo", mode: 0o755 }]);
    const entries = readTar(tar, limits);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.mode).toBe(0o755);
  });

  it("writes long paths with a prefix field and reads them back", () => {
    const path = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    expect(readTar(writeTar([{ path, data: Buffer.from("x") }]), limits)[0]?.path).toBe(path);
    expect(() => writeTar([{ path: "x".repeat(300), data: Buffer.from("x") }])).toThrow(/too long/);
  });

  it("negative control: hostile archives are rejected", () => {
    expectCode(() => readTar(buildTar([{ path: "../evil", data: "x" }]), limits), "UNSAFE");
    expectCode(() => readTar(buildTar([{ path: "/abs", data: "x" }]), limits), "UNSAFE");
    expectCode(() => readTar(buildTar([{ path: "a", data: "x" }, { path: "a", data: "y" }]), limits), "UNSAFE");
    expectCode(() => readTar(buildTar([{ path: "h", type: "1", linkname: "a" }]), limits), "UNSAFE");
    expectCode(() => readTar(buildTar([{ path: "d", type: "3" }]), limits), "UNSAFE");
    expectCode(() => readTar(buildTar([{ path: "l", type: "2", linkname: "../../x" }]), limits), "UNSAFE");
    expectCode(() => readTar(buildTar([{ path: "l", type: "2", linkname: "a" }]), { ...limits, symlinks: "none" }), "UNSAFE");
    expectCode(() => readTar(buildTar([{ path: "l", type: "2", linkname: "target" }, { path: "l/inside", data: "x" }]), limits), "UNSAFE");
  });

  it("negative control: truncated, oversized, over-count and corrupt archives are rejected before extraction", () => {
    const full = buildTar([{ path: "a", data: "x".repeat(2000) }]);
    expectCode(() => readTar(full.subarray(0, 300), limits), "TRUNCATED");
    expectCode(() => readTar(full.subarray(0, 1024), limits), "TRUNCATED");
    expectCode(() => readTar(full.subarray(0, full.length - 1024), limits), "TRUNCATED");
    expectCode(() => readTar(full.subarray(0, full.length - 600), limits), "TRUNCATED");
    expectCode(() => readTar(full, { ...limits, maxTotalBytes: 100 }), "LIMIT");
    expectCode(() => readTar(buildTar([{ path: "a", data: "1" }, { path: "b", data: "2" }]), { ...limits, maxEntries: 1 }), "LIMIT");
    const corrupt = Buffer.from(full);
    corrupt[10] = (corrupt[10] ?? 0) ^ 0xff;
    expectCode(() => readTar(corrupt, limits), "FORMAT");
    expectCode(() => readTar(Buffer.concat([full, Buffer.from("trailing")]), limits), "TRAILING_DATA");
    expect(() => readTar(Buffer.concat([full, Buffer.from("trailing")]), { ...limits, strictTrailing: false })).not.toThrow();
    expectCode(() => readTar(Buffer.alloc(0), limits), "TRUNCATED");
  });

  it("stops a gzip bomb at the inflation cap and rejects broken gzip", () => {
    const inner = buildTar([{ path: "z", data: Buffer.alloc(4 * 1024 * 1024) }]);
    const gz = gzipSync(inner);
    expectCode(() => inflateIfGzip(gz, 1024 * 1024), "LIMIT");
    expect(inflateIfGzip(gz, 8 * 1024 * 1024).length).toBe(inner.length);
    expectCode(() => inflateIfGzip(gz.subarray(0, gz.length - 20), 8 * 1024 * 1024), "FORMAT");
    expect(inflateIfGzip(inner, 10)).toBe(inner);
  });
});

describe("redaction and destination edge cases", () => {
  it("negative control: a truncated stream never ends in a partial planted marker or declared secret", () => {
    const r = new Redactor(["HCFAKE_declared_value_1234"]);
    expect(r.redact("ok line\nHCF", { truncated: true }).text).toBe("ok line\n");
    expect(r.redact("ok line\nHCFAKE_decl", { truncated: true }).text).not.toContain("HCFAKE_decl");
    expect(r.redact("nothing partial at the end", { truncated: true }).text).toBe("nothing partial at the end");
    expect(r.redact("short HC", { truncated: true }).text).toBe("short HC"); // fewer than 3 matching characters are not a marker
  });

  it("detects destinations in more realistic script text and allows only what is declared", () => {
    const hosts = (t: string) => findDestinations(t).map((d) => d.host);
    expect(hosts("curl -fsSL -o /tmp/x https://cdn.example.org:8443/pkg.tgz")).toContain("cdn.example.org");
    expect(findDestinations("curl https://cdn.example.org:8443/pkg.tgz").some((d) => d.port === "8443")).toBe(true);
    expect(hosts("rsync -a ./out/ backup@store.example.org:/data")).toContain("store.example.org");
    expect(hosts("ping -c1 198.51.100.4")).toContain("198.51.100.4");
    expect(hosts("ssh -p 2222 -i key ops@jump.example.org uptime")).toContain("jump.example.org");
    expect(findDestinations("curl --version")).toEqual([]);
    expect(findDestinations("echo hello && ls -la")).toEqual([]);
    expect(hosts("fetch ftp://files.example.org/x")).toContain("files.example.org");
  });
});
