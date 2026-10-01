import { sha256Hex, buildTar } from "../../scripts/build-fixture-release.mjs";
import { readTarEntries, type TarEntryRead } from "./tar.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ForgeOptions {
  /** Mutate the parsed run.json before it is re-hashed into the header. */
  run?: (run: Json) => void;
  /** Replace run.json bytes entirely (still re-hashed unless rehash is false). */
  runRaw?: string;
  /** Mutate the header AFTER re-hashing, so it can be made deliberately inconsistent. */
  header?: (header: Json) => void;
  /** Replace bundle.json bytes entirely, after everything else. */
  headerRaw?: string;
  /** Edit the final tar entries (order, extra files, removal). */
  entries?: (entries: TarEntryRead[]) => TarEntryRead[];
  /** Skip recomputing the run.json hash, size and root hash. */
  rehash?: boolean;
}

/** Rebuild a bundle with a consistent (or deliberately inconsistent) header so deep verification branches are reachable. */
export function forgeBundle(source: Buffer, opts: ForgeOptions = {}): Buffer {
  const entries = readTarEntries(source);
  const headerEntry = entries.find((e) => e.name === "bundle.json") as TarEntryRead;
  const runEntry = entries.find((e) => e.name === "run.json") as TarEntryRead;
  const header = JSON.parse(headerEntry.data.toString("utf8")) as Json;
  const run = JSON.parse(runEntry.data.toString("utf8")) as Json;
  opts.run?.(run);
  const runBytes = Buffer.from(opts.runRaw ?? JSON.stringify(run));
  if (opts.rehash !== false) {
    const f = header.files.find((x: Json) => x.path === "run.json");
    f.sha256 = sha256Hex(runBytes);
    f.size_bytes = runBytes.length;
    header.metadata_bytes = runBytes.length;
    const sorted = [...header.files].sort((a: Json, b: Json) => (a.path < b.path ? -1 : 1));
    header.root_hash = sha256Hex(sorted.map((x: Json) => `${x.path}:${x.sha256}`).join("\n"));
  }
  opts.header?.(header);
  let out: TarEntryRead[] = [
    { name: "bundle.json", type: "0", data: Buffer.from(opts.headerRaw ?? JSON.stringify(header)), linkname: "" },
    { name: "run.json", type: "0", data: runBytes, linkname: "" },
    ...entries.filter((e) => e.name.startsWith("objects/"))
  ];
  if (opts.entries) out = opts.entries(out);
  return buildTar(out.map((e) => ({ path: e.name, data: e.data, type: e.type, linkname: e.linkname })));
}
