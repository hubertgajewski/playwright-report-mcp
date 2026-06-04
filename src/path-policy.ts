import { realpathSync, statSync } from 'fs';
import type { Stats } from 'fs';
import { isAbsolute, relative, resolve } from 'path';

interface PathPolicyConfig {
  launchCwd: string;
  allowedDirs: string[];
  allowedDirsReal: string[];
}

/**
 * Canonicalize a path via realpathSync, falling back to the lexical input when
 * the path does not yet exist. Used to close symlink bypasses of the
 * allowlist and attachment-path checks: lexical containment alone is
 * insufficient because `spawnSync`'s `cwd` and `readFileSync` both follow
 * symlinks, so a symlink inside an authorized directory can otherwise escape
 * the allowlist.
 */
export function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Segment-level containment check. Returns true when `child` equals `parent`
 * or is a descendant of it. Rejects sibling-name bypasses (`/a/b` does not
 * contain `/a/bextra`) by going through path.relative rather than a raw
 * string-prefix match against `parent`.
 */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export type ContainedRealPathResult =
  | { ok: true; path: string; stat: Stats }
  | { ok: false; reason: 'escaped' | 'missing'; path: string }
  | { ok: false; reason: 'symlink'; path: string; realPath: string };

export function resolveContainedRealPath(root: string, candidate: string): ContainedRealPathResult {
  const path = resolve(root, candidate);
  if (!isInside(root, path)) return { ok: false, reason: 'escaped', path };

  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    return { ok: false, reason: 'missing', path };
  }

  if (!isInside(root, realPath)) return { ok: false, reason: 'symlink', path, realPath };

  try {
    return { ok: true, path: realPath, stat: statSync(realPath) };
  } catch {
    return { ok: false, reason: 'missing', path: realPath };
  }
}

/**
 * Resolve a caller-supplied workingDirectory against launchCwd and apply the
 * allowlist check. Returns the absolute directory on success, or an error
 * string pinpointing the failed check.
 */
export function resolveWorkingDir(
  config: PathPolicyConfig,
  workingDirectory: string | undefined
): { dir: string } | { error: string } {
  const dir = resolve(config.launchCwd, workingDirectory ?? '.');
  const lexicallyOk = config.allowedDirs.some((entry) => isInside(entry, dir));
  if (!lexicallyOk) {
    return {
      error:
        `workingDirectory "${dir}" is not under any entry in PW_ALLOWED_DIRS ` +
        `(allowed: ${config.allowedDirs.join(', ')}). ` +
        `Set PW_ALLOWED_DIRS to authorize additional directories.`,
    };
  }

  // Pinpoint the failed check in the error message - otherwise Playwright
  // spawns with a missing cwd and ENOENT surfaces as a generic "Failed to
  // spawn", the silent fall-through the issue explicitly forbids.
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st) return { error: `workingDirectory "${dir}" does not exist.` };
  if (!st.isDirectory())
    return { error: `workingDirectory "${dir}" exists but is not a directory.` };

  // Symlink-safe containment: canonicalize the resolved directory and re-check
  // against the canonicalized allowlist. This prevents a symlink inside an
  // authorized directory from escaping the allowlist - `spawnSync`'s cwd
  // follows symlinks at the OS level, so the lexical check alone is bypassable
  // by anyone able to create a symlink under an authorized path.
  const realDir = realpathSync(dir);
  const reallyOk = config.allowedDirsReal.some((entry) => isInside(entry, realDir));
  if (!reallyOk) {
    return {
      error:
        `workingDirectory "${dir}" resolves via symlink to "${realDir}", which is not under any ` +
        `entry in PW_ALLOWED_DIRS (allowed: ${config.allowedDirsReal.join(', ')}).`,
    };
  }
  return { dir: realDir };
}
