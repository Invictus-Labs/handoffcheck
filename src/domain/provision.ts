import type { ResourceRecord } from "./types.js";

/**
 * Thrown by a provider when provisioning failed. `resources` lists anything that may still exist (a half-created VM,
 * a staging directory) so the engine can audit it and record CLEANUP_UNCONFIRMED instead of claiming a clean slate.
 */
export class ProvisionError extends Error {
  readonly resources: ResourceRecord[];
  constructor(message: string, resources: ResourceRecord[] = []) {
    super(message);
    this.name = "ProvisionError";
    this.resources = resources;
  }
}
