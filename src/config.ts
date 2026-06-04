import { delimiter, resolve } from 'path';
import { canonicalize } from './path-policy.js';

export interface ServerConfig {
  launchCwd: string;
  allowedDirs: string[];
  allowedDirsReal: string[];
  resultsFileOverride: string | null;
}

/**
 * Parse PW_ALLOWED_DIRS into an array of absolute directory paths. Unset or
 * empty collapses to a single "." entry (authorizing only launchCwd). Each
 * entry is resolved against launchCwd exactly once at startup so relative
 * entries in a committed .mcp.json encode layout, not per-user absolute paths.
 */
export function parseAllowedDirs(raw: string | undefined, cwd: string): string[] {
  const entries = raw === undefined || raw === '' ? ['.'] : raw.split(delimiter).filter(Boolean);
  return entries.map((e) => resolve(cwd, e));
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): ServerConfig {
  const allowedDirs = parseAllowedDirs(env.PW_ALLOWED_DIRS, cwd);

  return {
    launchCwd: cwd,
    allowedDirs,
    // A non-existent entry falls back to the lexical path - that entry simply
    // never matches a real resolved path until the directory exists.
    allowedDirsReal: allowedDirs.map(canonicalize),
    resultsFileOverride: env.PW_RESULTS_FILE ? resolve(cwd, env.PW_RESULTS_FILE) : null,
  };
}

/**
 * Format the one-line startup banner written to stderr when the server runs as
 * a CLI. Extracted from the inline `process.stderr.write(...)` so operators'
 * assumptions about what appears in their logs are covered by unit tests.
 */
export function formatStartupBanner(
  cwd: string,
  allowed: string[],
  rawEnv: string | undefined
): string {
  const isDefault = rawEnv === undefined || rawEnv === '';
  const suffix = isDefault ? ' (default — authorizing only launchCwd)' : '';
  return (
    `[playwright-report-mcp] launchCwd=${cwd}\n` +
    `[playwright-report-mcp] PW_ALLOWED_DIRS=${allowed.join(', ')}${suffix}\n`
  );
}
