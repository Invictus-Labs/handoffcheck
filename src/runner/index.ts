import type { ProviderRegistry } from "../domain/types.js";
import { LimaProvider } from "./lima.js";
import { LocalSandboxProvider } from "./local-sandbox.js";
import type { TestFault } from "./local-sandbox.js";

export { LimaProvider, findLimactl } from "./lima.js";
export { LocalSandboxProvider } from "./local-sandbox.js";

/** Built-in providers for an environment. Callers may override entries (tests inject fakes). */
export function defaultProviders(env: NodeJS.ProcessEnv): { providers: ProviderRegistry; faultInjected: boolean } {
  const raw = env["HANDOFFCHECK_TEST_FAULT"];
  const fault: TestFault = raw === "leak-resource" || raw === "leak-process" ? raw : null;
  return {
    providers: {
      "local-sandbox": new LocalSandboxProvider({ fault }),
      lima: new LimaProvider({ env, fault: fault === "leak-resource" ? fault : null })
    },
    faultInjected: fault !== null
  };
}
