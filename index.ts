#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

// `launchCwd` is the working directory of the MCP server process at spawn
// time. MCP stdio transports freeze the cwd for the process lifetime, so we
// resolve it once here and use it as the anchor for per-call workingDirectory
// resolution and for relative PW_ALLOWED_DIRS entries.
const launchCwd = process.cwd();

/**
 * Parse PW_ALLOWED_DIRS into an array of absolute directory paths. Unset or
 * empty collapses to a single "." entry (authorizing only launchCwd). Each
 * entry is resolved against launchCwd exactly once at startup so relative
 * entries in a committed .mcp.json encode layout, not per-user absolute paths.
 */
function parseAllowedDirs(raw: string | undefined, cwd: string): string[] {
  const entries = raw === undefined || raw === '' ? ['.'] : raw.split(delimiter).filter(Boolean);
  return entries.map((e) => resolve(cwd, e));
}

/**
 * Canonicalize a path via realpathSync, falling back to the lexical input when
 * the path does not yet exist. Used to close symlink bypasses of the
 * allowlist and attachment-path checks: lexical containment alone is
 * insufficient because `spawnSync`'s `cwd` and `readFileSync` both follow
 * symlinks, so a symlink inside an authorized directory can otherwise escape
 * the allowlist.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const ALLOWED_DIRS = parseAllowedDirs(process.env.PW_ALLOWED_DIRS, launchCwd);
// Canonicalized allowlist entries, computed once at startup. A non-existent
// entry falls back to the lexical path — that entry simply never matches a
// real resolved path until the directory exists.
const ALLOWED_DIRS_REAL = ALLOWED_DIRS.map(canonicalize);

// Absolute override for results.json. If unset, the path is computed per-call
// against the resolved workingDirectory.
const RESULTS_FILE_OVERRIDE = process.env.PW_RESULTS_FILE
  ? resolve(launchCwd, process.env.PW_RESULTS_FILE)
  : null;

// ---------- types (subset of Playwright JSON reporter output) ----------

interface PwAttachment {
  name: string;
  contentType: string;
  path?: string;
}

interface PwResult {
  status: 'passed' | 'failed' | 'skipped' | 'timedOut';
  duration: number;
  error?: { message?: string };
  attachments: PwAttachment[];
}

interface PwTest {
  projectName: string;
  status: string;
  results: PwResult[];
}

interface PwSpec {
  title: string;
  file: string;
  line: number;
  ok: boolean;
  tags?: string[];
  tests: PwTest[];
}

interface PwSuite {
  title: string;
  file?: string;
  specs: PwSpec[];
  suites?: PwSuite[];
}

interface PwReport {
  suites: PwSuite[];
  stats: {
    expected: number;
    unexpected: number;
    skipped: number;
    duration: number;
  };
}

// ---------- helpers ----------

/**
 * Segment-level containment check. Returns true when `child` equals `parent`
 * or is a descendant of it. Rejects sibling-name bypasses (`/a/b` does not
 * contain `/a/bextra`) by going through path.relative rather than a raw
 * string-prefix match against `parent`.
 */
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve a caller-supplied workingDirectory against launchCwd and apply the
 * allowlist check. Returns the absolute directory on success, or an error
 * string pinpointing the failed check.
 */
function resolveWorkingDir(
  workingDirectory: string | undefined
): { dir: string } | { error: string } {
  const dir = resolve(launchCwd, workingDirectory ?? '.');
  const lexicallyOk = ALLOWED_DIRS.some((entry) => isInside(entry, dir));
  if (!lexicallyOk) {
    return {
      error:
        `workingDirectory "${dir}" is not under any entry in PW_ALLOWED_DIRS ` +
        `(allowed: ${ALLOWED_DIRS.join(', ')}). ` +
        `Set PW_ALLOWED_DIRS to authorize additional directories.`,
    };
  }
  // Explicit existence + directory check so the error pinpoints the failed check.
  // Otherwise Playwright spawns with a missing cwd and ENOENT bubbles up as a
  // generic "Failed to spawn" — a silent fall-through the issue specifically calls out.
  if (!existsSync(dir)) return { error: `workingDirectory "${dir}" does not exist.` };
  try {
    if (!statSync(dir).isDirectory())
      return { error: `workingDirectory "${dir}" exists but is not a directory.` };
  } catch (e) {
    return { error: `workingDirectory "${dir}" could not be stat'd: ${(e as Error).message}` };
  }
  // Symlink-safe containment: canonicalize the resolved directory and re-check
  // against the canonicalized allowlist. This prevents a symlink inside an
  // authorized directory from escaping the allowlist — `spawnSync`'s cwd
  // follows symlinks at the OS level, so the lexical check alone is bypassable
  // by anyone able to create a symlink under an authorized path.
  const realDir = realpathSync(dir);
  const reallyOk = ALLOWED_DIRS_REAL.some((entry) => isInside(entry, realDir));
  if (!reallyOk) {
    return {
      error:
        `workingDirectory "${dir}" resolves via symlink to "${realDir}", which is not under any ` +
        `entry in PW_ALLOWED_DIRS (allowed: ${ALLOWED_DIRS_REAL.join(', ')}).`,
    };
  }
  return { dir: realDir };
}

/**
 * Format the one-line startup banner written to stderr when the server runs as
 * a CLI. Extracted from the inline `process.stderr.write(...)` so operators'
 * assumptions about what appears in their logs are covered by unit tests.
 */
function formatStartupBanner(cwd: string, allowed: string[], rawEnv: string | undefined): string {
  const isDefault = rawEnv === undefined || rawEnv === '';
  const suffix = isDefault ? ' (default — authorizing only launchCwd)' : '';
  return (
    `[playwright-report-mcp] launchCwd=${cwd}\n` +
    `[playwright-report-mcp] PW_ALLOWED_DIRS=${allowed.join(', ')}${suffix}\n`
  );
}

function resultsFileFor(dir: string): string {
  return RESULTS_FILE_OVERRIDE ?? join(dir, 'test-results', 'results.json');
}

function readLastReport(dir: string): PwReport | null {
  try {
    return JSON.parse(readFileSync(resultsFileFor(dir), 'utf8')) as PwReport;
  } catch {
    return null;
  }
}

/** Flatten nested suites into a list of specs with their file paths. */
function collectSpecs(suites: PwSuite[], filePath = ''): Array<{ spec: PwSpec; file: string }> {
  const out: Array<{ spec: PwSpec; file: string }> = [];
  for (const suite of suites) {
    const file = suite.file ?? filePath;
    for (const spec of suite.specs ?? []) {
      out.push({ spec, file });
    }
    if (suite.suites) {
      out.push(...collectSpecs(suite.suites, file));
    }
  }
  return out;
}

function runPlaywright(cmd: string[], cwd: string, timeoutMs: number) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function buildListTestsCmd(tag?: string): string[] {
  const cmd = ['npx', 'playwright', 'test', '--list', '--reporter=json'];
  if (tag) cmd.push('--grep', tag);
  return cmd;
}

/**
 * Extract a balanced JSON object from stdout. The JSON reporter writes `{` at
 * column 0; we scan forward tracking string state and brace depth so that any
 * trailing warnings Playwright prints after the report don't poison the slice.
 */
function extractJsonObject(stdout: string): string {
  const start = stdout.search(/^\{/m);
  if (start < 0) throw new Error('Playwright --list output contained no JSON object.');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return stdout.slice(start, i + 1);
  }
  throw new Error('Playwright --list output had unbalanced JSON braces.');
}

/**
 * Parse `npx playwright test --list --reporter=json` stdout into a deduplicated
 * list of tests with @-prefixed tags. Dotenv/warning lines before or after the
 * JSON body are tolerated; malformed or missing JSON throws.
 */
function parseListJson(stdout: string): Array<{ title: string; file: string; tags: string[] }> {
  const report = JSON.parse(extractJsonObject(stdout)) as { suites?: PwSuite[] };

  const seen = new Set<string>();
  const tests: Array<{ title: string; file: string; tags: string[] }> = [];
  for (const { spec, file } of collectSpecs(report.suites ?? [])) {
    const key = `${file}::${spec.line}::${spec.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = (spec.tags ?? []).map((t) => (t.startsWith('@') ? t : `@${t}`));
    tests.push({ title: spec.title, file, tags });
  }
  return tests;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], isError: true };
}

// ---------- server ----------

// Load identity from package.json so clients see the real published name/version via MCP `initialize`.
// Two candidates because the module runs in two layouts: source (`<repo>/index.ts` sibling to package.json)
// and published (`<repo>/dist/index.js` one level below package.json). A hardcoded relative path would
// silently break in one of them; `tsc` does not rewrite JSON specifiers.
// `baseDir` is injectable so unit tests can exercise failure/fallback paths against a tmpdir.
function loadPackageMeta(baseDir?: string): { name: string; version: string } {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'package.json'), join(here, '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      // Reject empty/whitespace-only values — MCP clients would otherwise render a blank server
      // identity, which defeats the whole point of sourcing these from package.json.
      if (
        typeof pkg.name === 'string' &&
        pkg.name.trim().length > 0 &&
        typeof pkg.version === 'string' &&
        pkg.version.trim().length > 0
      )
        return { name: pkg.name.trim(), version: pkg.version.trim() };
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Could not locate package.json relative to ${here}`);
}

const pkg = loadPackageMeta();
const server = new McpServer({ name: pkg.name, version: pkg.version });

const workingDirectoryField = z
  .string()
  .optional()
  .describe(
    'Playwright project directory. Absolute or relative to the MCP server launch directory. Defaults to ".". Must be under PW_ALLOWED_DIRS.'
  );

server.registerTool(
  'run_tests',
  {
    description: 'Run Playwright tests and return structured results.',
    inputSchema: {
      workingDirectory: workingDirectoryField,
      spec: z.string().optional().describe('Spec file path, e.g. tests/navigation.spec.ts'),
      browser: z
        .enum(['Chromium', 'Firefox', 'Webkit', 'Mobile Chrome', 'Mobile Safari'])
        .optional(),
      tag: z.string().optional().describe('Tag filter, e.g. @smoke or @regression'),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Timeout in milliseconds for the whole test run. Defaults to 300000.'),
    },
  },
  async ({ workingDirectory, spec, browser, tag, timeout }) => {
    const wd = resolveWorkingDir(workingDirectory);
    if ('error' in wd) return err(wd.error);

    const cmd = ['npx', 'playwright', 'test'];
    if (spec) {
      const resolved = resolve(wd.dir, spec);
      if (!isInside(wd.dir, resolved)) return err('spec path must be within the project directory');
      cmd.push(resolved);
    }
    if (browser) cmd.push('--project', browser);
    if (tag) cmd.push('--grep', tag);

    const effectiveTimeout = timeout ?? 300_000;
    const result = runPlaywright(cmd, wd.dir, effectiveTimeout);

    if (result.error) {
      // Node's spawnSync({ timeout }) populates BOTH error.code='ETIMEDOUT' and signal='SIGTERM'
      // when the timer fires, so this check must precede the generic spawn-failure branch.
      if ('code' in result.error && result.error.code === 'ETIMEDOUT')
        return err(
          `Playwright test run exceeded the ${effectiveTimeout}ms timeout and was killed.`
        );
      return err(`Failed to spawn Playwright: ${result.error.message}`);
    }

    const report = readLastReport(wd.dir);
    if (!report)
      return err(
        `Test run completed but results.json was not found.\nstderr: ${result.stderr ?? ''}`
      );

    const specs = collectSpecs(report.suites);
    const summary = specs.map(({ spec: s, file }) => ({
      title: s.title,
      file,
      ok: s.ok,
      // results.at(-1) = final retry attempt — authoritative outcome when Playwright retries are configured
      results: s.tests.map((t) => {
        const last = t.results.at(-1);
        return {
          project: t.projectName,
          status: last?.status ?? 'unknown',
          duration: last?.duration ?? 0,
          error: last?.error?.message ?? null,
        };
      }),
    }));

    return ok({ exitCode: result.status ?? -1, stats: report.stats, tests: summary });
  }
);

server.registerTool(
  'get_failed_tests',
  {
    description: 'Return failed tests from the last run with error messages and attachment paths.',
    inputSchema: {
      workingDirectory: workingDirectoryField,
    },
  },
  async ({ workingDirectory }) => {
    const wd = resolveWorkingDir(workingDirectory);
    if ('error' in wd) return err(wd.error);

    const report = readLastReport(wd.dir);
    if (!report) return err('No results.json found — run tests first.');

    const failed = collectSpecs(report.suites)
      .filter(({ spec }) => !spec.ok)
      .map(({ spec, file }) => ({
        title: spec.title,
        file,
        failures: spec.tests
          .filter((t) => {
            const s = t.results.at(-1)?.status;
            return s === 'failed' || s === 'timedOut';
          })
          .map((t) => {
            const last = t.results.at(-1);
            return {
              project: t.projectName,
              status: last?.status,
              error: last?.error?.message ?? null,
              attachments: last?.attachments.map((a) => ({ name: a.name, path: a.path })),
            };
          }),
      }));

    return ok({ failedCount: failed.length, tests: failed });
  }
);

server.registerTool(
  'get_test_attachment',
  {
    description: 'Read the content of a named attachment for a specific test from the last run.',
    inputSchema: {
      workingDirectory: workingDirectoryField,
      testTitle: z.string().describe('Exact test title as shown in the report'),
      attachmentName: z.string().describe('Attachment name, e.g. "AI diagnosis", "DOM"'),
    },
  },
  async ({ workingDirectory, testTitle, attachmentName }) => {
    const wd = resolveWorkingDir(workingDirectory);
    if ('error' in wd) return err(wd.error);

    const report = readLastReport(wd.dir);
    if (!report) return err('No results.json found — run tests first.');

    const match = collectSpecs(report.suites).find(({ spec }) => spec.title === testTitle);
    if (!match) return err(`Test not found in last report: "${testTitle}"`);

    for (const test of match.spec.tests) {
      const result = test.results.at(-1);
      if (!result) continue;
      const attachment = result.attachments.find((a) => a.name === attachmentName);
      if (attachment?.path) {
        // Defense-in-depth: refuse to read any attachment whose path escapes
        // the resolved workingDirectory, even if results.json recorded one.
        // Two checks — lexical first (fast, catches `..` traversal and absolute
        // paths outside wd.dir), then symlink-safe via realpathSync so a
        // symlink inside wd.dir pointing at /etc/passwd or ~/.ssh/id_rsa
        // cannot smuggle data out through readFileSync (which follows symlinks).
        const attachmentPath = resolve(wd.dir, attachment.path);
        if (!isInside(wd.dir, attachmentPath))
          return err(
            `Attachment "${attachmentName}" path "${attachment.path}" escapes workingDirectory "${wd.dir}".`
          );
        if (!attachment.contentType.startsWith('text/'))
          return err(
            `Attachment "${attachmentName}" is binary (${attachment.contentType}) and cannot be returned as text.`
          );
        try {
          const realAttachmentPath = realpathSync(attachmentPath);
          if (!isInside(wd.dir, realAttachmentPath))
            return err(
              `Attachment "${attachmentName}" path "${attachment.path}" resolves via symlink to "${realAttachmentPath}", which escapes workingDirectory "${wd.dir}".`
            );
          const MAX_BYTES = 1_000_000;
          const { size } = statSync(realAttachmentPath);
          if (size > MAX_BYTES)
            return err(
              `Attachment "${attachmentName}" is too large to return inline (${size} bytes).`
            );
          return ok({
            testTitle,
            attachmentName,
            content: readFileSync(realAttachmentPath, 'utf8'),
          });
        } catch {
          // realpathSync / statSync / readFileSync throw if the file no longer
          // exists on disk — fall through to the "not found" error below.
        }
      }
    }
    return err(`Attachment "${attachmentName}" not found for test "${testTitle}".`);
  }
);

server.registerTool(
  'list_tests',
  {
    description: 'List all tests with their spec file and tags without running them.',
    inputSchema: {
      workingDirectory: workingDirectoryField,
      tag: z.string().optional().describe('Filter by tag, e.g. @smoke'),
    },
  },
  async ({ workingDirectory, tag }) => {
    const wd = resolveWorkingDir(workingDirectory);
    if ('error' in wd) return err(wd.error);

    const listTimeout = 30_000;
    const result = runPlaywright(buildListTestsCmd(tag), wd.dir, listTimeout);

    if (result.error) {
      // Node's spawnSync({ timeout }) populates BOTH error.code='ETIMEDOUT' and signal='SIGTERM'
      // when the timer fires, so this check must precede the generic spawn-failure branch.
      if ('code' in result.error && result.error.code === 'ETIMEDOUT')
        return err(
          `Listing Playwright tests exceeded the ${listTimeout}ms timeout and was killed.`
        );
      return err(`Failed to spawn Playwright: ${result.error.message}`);
    }

    const stdout = result.stdout ?? '';
    let tests: Array<{ title: string; file: string; tags: string[] }>;
    try {
      tests = parseListJson(stdout);
    } catch (e) {
      return err(
        `Failed to parse Playwright --list JSON output: ${(e as Error).message}\nstderr: ${result.stderr ?? ''}`
      );
    }

    return ok({ count: tests.length, tests });
  }
);

export {
  ALLOWED_DIRS,
  ALLOWED_DIRS_REAL,
  buildListTestsCmd,
  canonicalize,
  collectSpecs,
  formatStartupBanner,
  isInside,
  loadPackageMeta,
  parseAllowedDirs,
  parseListJson,
  server,
};

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write(formatStartupBanner(launchCwd, ALLOWED_DIRS, process.env.PW_ALLOWED_DIRS));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
