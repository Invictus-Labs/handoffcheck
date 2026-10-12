import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRILL_DIR } from "./drill.js";
import { makeTmp } from "./tmp.js";

const FAKE = join(DRILL_DIR, "..", "..", "tests", "helpers", "fake-limactl.sh");

export interface FakeLima {
  /** Environment entries to hand to the library (HANDOFFCHECK_LIMACTL and LIMA_HOME) */
  env: Record<string, string>;
  home: string;
  calls(): string[];
  instances(): string[];
}

/** A fake limactl that runs guest commands on the host. PROTOCOL TESTS ONLY: never live VM evidence. */
export function makeFakeLima(faults: string[] = []): FakeLima {
  const dir = makeTmp("hc-fakelima-");
  const home = join(dir, ".lima");
  mkdirSync(join(home, "bin"), { recursive: true });
  symlinkSync(process.execPath, join(home, "bin", "node"));
  const bin = join(dir, "limactl");
  copyFileSync(FAKE, bin);
  chmodSync(bin, 0o755);
  if (faults.length) writeFileSync(join(home, "fault"), `${faults.join("\n")}\n`);
  return {
    env: { PATH: process.env.PATH ?? "", HOME: dir, HANDOFFCHECK_LIMACTL: bin, LIMA_HOME: home },
    home,
    calls: () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []),
    instances: () => (existsSync(join(home, "instances")) ? readdirSync(join(home, "instances")) : [])
  };
}
