// Types for scheduler.mjs (used by the tests).
export interface RunOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  out?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}
export function run(opts?: RunOptions): Promise<{ failures: number; summary: string[] }>;
