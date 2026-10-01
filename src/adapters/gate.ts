import { AdapterError } from "./envelope.js";

export const ADAPTERS_ENV = "HANDOFFCHECK_ADAPTERS";

/** Adapters are disabled unless the operator opts in with the flag or HANDOFFCHECK_ADAPTERS=1. */
export function adaptersEnabled(flag: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return flag === true || env[ADAPTERS_ENV] === "1";
}

export function assertEnabled(enabled: boolean): void {
  if (enabled !== true) {
    throw new AdapterError(
      "CONNECTOR_DISCONNECTED",
      `adapters are disabled by default; pass --enable-adapters or set ${ADAPTERS_ENV}=1 to use local receipt export / acceptance import`
    );
  }
}
