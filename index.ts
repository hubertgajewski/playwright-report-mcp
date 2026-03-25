#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawnSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const PW_DIR = resolve(process.env.PW_DIR ?? process.cwd());
const RESULTS_FILE = resolve(process.env.PW_RESULTS_FILE ?? join(PW_DIR, 'test-results', 'results.json'));

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
    },
  },
  async ({ spec, browser, tag }) => {
    const cmd = ['npx', 'playwright', 'test'];
    if (spec) {
      const resolved = resolve(PW_DIR, spec);
      if (relative(PW_DIR, resolved).startsWith('..'))
        return err('spec path must be within the project directory');
      cmd.push(resolved);
    }
    if (browser) cmd.push('--project', browser);
    if (tag) cmd.push('--grep', tag);

    const result = runPlaywright(cmd, 300_000);

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
    const cmd = ['npx', 'playwright', 'test', '--list'];
    if (tag) cmd.push('--grep', tag);

    const result = runPlaywright(cmd, 30_000);

    if (result.error) return err(`Failed to spawn Playwright: ${result.error.message}`);

    // Output format: "  [Chromium] › tests/navigation.spec.ts:6:1 › home page @smoke"
    const lines = (result.stdout ?? '').split('\n');
    const seen = new Set<string>();
    const tests: Array<{ title: string; file: string; tags: string[] }> = [];

    for (const line of lines) {
      const m = line.match(/›\s+(.+?):(\d+):\d+\s+›\s+(.+)/);
      if (!m) continue;
      const [, file, , titleRaw] = m;
      const tags = [...titleRaw.matchAll(/@\w+/g)].map((t) => t[0]);
      const title = titleRaw.trim();
      const key = `${file}::${title}`;
      if (!seen.has(key)) {
        seen.add(key);
        tests.push({ title, file, tags });
      }
    }

    if (tests.length === 0 && lines.some((l) => l.trim().length > 0))
      return err(
        'list_tests parsed 0 tests from non-empty output — Playwright --list format may have changed.'
      );

    return ok({ count: tests.length, tests });
  }
);

export { collectSpecs, server };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
