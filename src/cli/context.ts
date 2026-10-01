import type { Parsed } from "./args.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface Context extends Io {
  version: string;
  parsed: Parsed;
  json: boolean;
}

export function str(ctx: Context, name: string): string {
  const v = ctx.parsed.values[name];
  if (typeof v !== "string") throw new Error(`internal: option --${name} missing after validation`);
  return v;
}

export function optStr(ctx: Context, name: string): string | undefined {
  const v = ctx.parsed.values[name];
  return typeof v === "string" ? v : undefined;
}

export function flag(ctx: Context, name: string): boolean {
  return ctx.parsed.values[name] === true;
}
