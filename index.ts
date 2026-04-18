#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawnSync } from 'child_process';
import { readFileSync, realpathSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const PW_DIR = resolve(process.env.PW_DIR ?? process.cwd());
const RESULTS_FILE = resolve(
  process.env.PW_RESULTS_FILE ?? join(PW_DIR, 'test-results', 'results.json')
);

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

function readLastReport(): PwReport | null {
  try {
    return JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as PwReport;
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

function runPlaywright(cmd: string[], timeoutMs: number) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd: PW_DIR,
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

const server = new McpServer({ name: 'playwright-report', version: '1.0.0' });

server.registerTool(
  'run_tests',
  {
    description: 'Run Playwright tests and return structured results.',
    inputSchema: {
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
        .describe('Timeout in seconds for the whole test run. Defaults to 300.'),
    },
  },
  async ({ spec, browser, tag, timeout }) => {
    const cmd = ['npx', 'playwright', 'test'];
    if (spec) {
      const resolved = resolve(PW_DIR, spec);
      if (relative(PW_DIR, resolved).startsWith('..'))
        return err('spec path must be within the project directory');
      cmd.push(resolved);
    }
    if (browser) cmd.push('--project', browser);
    if (tag) cmd.push('--grep', tag);

    const result = runPlaywright(cmd, timeout ? timeout * 1000 : 300_000);

    if (result.error) return err(`Failed to spawn Playwright: ${result.error.message}`);

    const report = readLastReport();
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
    inputSchema: {},
  },
  async () => {
    const report = readLastReport();
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
      testTitle: z.string().describe('Exact test title as shown in the report'),
      attachmentName: z.string().describe('Attachment name, e.g. "AI diagnosis", "DOM"'),
    },
  },
  async ({ testTitle, attachmentName }) => {
    const report = readLastReport();
    if (!report) return err('No results.json found — run tests first.');

    const match = collectSpecs(report.suites).find(({ spec }) => spec.title === testTitle);
    if (!match) return err(`Test not found in last report: "${testTitle}"`);

    for (const test of match.spec.tests) {
      const result = test.results.at(-1);
      if (!result) continue;
      const attachment = result.attachments.find((a) => a.name === attachmentName);
      if (attachment?.path) {
        if (!attachment.contentType.startsWith('text/'))
          return err(
            `Attachment "${attachmentName}" is binary (${attachment.contentType}) and cannot be returned as text.`
          );
        try {
          const MAX_BYTES = 1_000_000;
          const { size } = statSync(attachment.path);
          if (size > MAX_BYTES)
            return err(
              `Attachment "${attachmentName}" is too large to return inline (${size} bytes).`
            );
          return ok({ testTitle, attachmentName, content: readFileSync(attachment.path, 'utf8') });
        } catch {
          // attachment path recorded in results.json but file no longer on disk
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
      tag: z.string().optional().describe('Filter by tag, e.g. @smoke'),
    },
  },
  async ({ tag }) => {
    const result = runPlaywright(buildListTestsCmd(tag), 30_000);

    if (result.error) return err(`Failed to spawn Playwright: ${result.error.message}`);

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

export { buildListTestsCmd, collectSpecs, parseListJson, server };

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
