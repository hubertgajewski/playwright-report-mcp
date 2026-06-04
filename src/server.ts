import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { loadConfig, type ServerConfig } from './config.js';
import { errorMessage } from './errors.js';
import { loadPackageMeta, type PackageMeta } from './package-meta.js';
import { resolveContainedRealPath, resolveWorkingDir } from './path-policy.js';
import {
  buildListTestsCmd,
  collectSpecs,
  findSpec,
  parseListJson,
  readLastReportResult,
  summarizeReport,
  type PwReport,
} from './results.js';
import { RunTracker } from './run-tracker.js';

function runPlaywright(cmd: string[], cwd: string, timeoutMs: number) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd,
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

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

type ToolResult = ReturnType<typeof ok> | ReturnType<typeof err>;

type ReportOrError = { ok: true; report: PwReport } | { ok: false; response: ToolResult };

type ResolvedSpecArgument = { ok: true; arg: string } | { ok: false; response: ToolResult };

type SpecCandidateResult =
  | { ok: true; path: string }
  | { ok: false; response: ToolResult; missing: boolean };

const LAST_REPORT_MESSAGES = {
  missing: 'No results.json found — run tests first.',
  invalid: (error: string, path: string) => `Invalid results.json at "${path}": ${error}`,
};

function withWorkingDir(
  config: ServerConfig,
  workingDirectory: string | undefined,
  handler: (wd: { dir: string }) => ToolResult | Promise<ToolResult>
) {
  const wd = resolveWorkingDir(config, workingDirectory);
  if ('error' in wd) return err(wd.error);
  return handler(wd);
}

function spawnFailure(result: ReturnType<typeof runPlaywright>, timeoutMessage: string) {
  if (!result.error) return null;
  // Node's spawnSync({ timeout }) populates BOTH error.code='ETIMEDOUT' and signal='SIGTERM'
  // when the timer fires, so this check must precede the generic spawn-failure branch.
  if ('code' in result.error && result.error.code === 'ETIMEDOUT') return err(timeoutMessage);
  return err(`Failed to spawn Playwright: ${result.error.message}`);
}

function parseLocationSuffix(spec: string): { path: string; suffix: string } | null {
  const match = spec.match(/^(.+?)(:\d+(?::\d+)?)$/);
  return match ? { path: match[1], suffix: match[2] } : null;
}

function specPathError(
  wdDir: string,
  spec: string,
  specPath: ReturnType<typeof resolveContainedRealPath>
) {
  if (specPath.ok === true) {
    if (!specPath.stat.isFile()) return err(`spec path must point to a file: "${spec}"`);
    return null;
  }

  switch (specPath.reason) {
    case 'escaped':
      return err('spec path must be within the project directory');
    case 'missing':
      return err(`spec path was not found: "${spec}"`);
    case 'symlink':
      return err(
        `spec path "${spec}" resolves via symlink to "${specPath.realPath}", which escapes workingDirectory "${wdDir}".`
      );
    default:
      return assertNever(specPath);
  }
}

function validateSpecCandidate(
  wdDir: string,
  spec: string,
  candidate: string
): SpecCandidateResult {
  const specPath = resolveContainedRealPath(wdDir, candidate);
  const response = specPathError(wdDir, spec, specPath);
  if (!response && specPath.ok === true) return { ok: true, path: specPath.path };

  return {
    ok: false,
    missing: specPath.ok === false && specPath.reason === 'missing',
    response: response ?? err(`Unable to validate spec path: "${spec}"`),
  };
}

function resolveSpecArgument(wdDir: string, spec: string): ResolvedSpecArgument {
  const direct = validateSpecCandidate(wdDir, spec, spec);
  if (direct.ok) return { ok: true, arg: direct.path };
  if (!direct.missing) return { ok: false, response: direct.response };

  const location = parseLocationSuffix(spec);
  if (!location) return { ok: false, response: direct.response };

  const filtered = validateSpecCandidate(wdDir, spec, location.path);
  if (filtered.ok) return { ok: true, arg: `${filtered.path}${location.suffix}` };

  return { ok: false, response: filtered.response };
}

function readReportOrError(
  config: ServerConfig,
  dir: string,
  messages: { missing: string; invalid: (error: string, path: string) => string }
): ReportOrError {
  const report = readLastReportResult(config, dir);
  if (report.ok) return { ok: true, report: report.report };

  switch (report.reason) {
    case 'missing':
      return { ok: false, response: err(messages.missing) };
    case 'invalid':
      return { ok: false, response: err(messages.invalid(report.error, report.path)) };
    default:
      return assertNever(report);
  }
}

export interface CreateServerOptions {
  config?: ServerConfig;
  packageMeta?: PackageMeta;
}

export function createServer(options: CreateServerOptions = {}) {
  const config = options.config ?? loadConfig();
  const pkg = options.packageMeta ?? loadPackageMeta();
  const server = new McpServer({ name: pkg.name, version: pkg.version });
  const runTracker = new RunTracker(config);

  const workingDirectoryField = z
    .string()
    .optional()
    .describe(
      'Playwright project directory. Absolute or relative to the MCP server launch directory. Defaults to ".". Must be under PW_ALLOWED_DIRS.'
    );

  const runStatusWorkingDirectoryField = z
    .string()
    .optional()
    .describe(
      'Playwright project directory. Absolute or relative to the MCP server launch directory. Defaults to ".". Must be under PW_ALLOWED_DIRS. Used to find the latest tracked run when runId is omitted; when supplied with runId, it must resolve to that run working directory.'
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
        wait: z
          .boolean()
          .optional()
          .describe(
            'Wait for completion before returning. Defaults to true. Set false to start a background run and poll it with get_run_status.'
          ),
        updateSnapshots: z
          .enum(['all', 'changed', 'missing', 'none'])
          .optional()
          .describe(
            'Update snapshot baselines. Playwright default is "missing"; "changed" updates differing + missing.'
          ),
        headed: z
          .boolean()
          .optional()
          .describe(
            'Run with a visible browser window. Omitting or setting false leaves playwright.config.ts intact — Playwright has no --no-headed flag, so false does not force headless when the config sets headed.'
          ),
        workers: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Number of parallel workers (positive integer).'),
        retries: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Maximum retry count for flaky tests; 0 disables retries.'),
        maxFailures: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Stop the run after this many failures.'),
        trace: z
          .enum([
            'on',
            'off',
            'on-first-retry',
            'on-all-retries',
            'retain-on-failure',
            'retain-on-first-failure',
            'retain-on-failure-and-retries',
          ])
          .optional()
          .describe('Force Playwright tracing mode, overriding playwright.config.ts.'),
      },
    },
    async ({
      workingDirectory,
      spec,
      browser,
      tag,
      timeout,
      wait,
      updateSnapshots,
      headed,
      workers,
      retries,
      maxFailures,
      trace,
    }) => {
      return withWorkingDir(config, workingDirectory, async (wd) => {
        const cmd = ['npx', 'playwright', 'test'];
        if (spec) {
          const specArg = resolveSpecArgument(wd.dir, spec);
          if (!specArg.ok) return specArg.response;
          cmd.push(specArg.arg);
        }
        if (browser) cmd.push('--project', browser);
        if (tag) cmd.push('--grep', tag);
        if (updateSnapshots) cmd.push('--update-snapshots', updateSnapshots);
        if (headed) cmd.push('--headed');
        if (workers !== undefined) cmd.push('--workers', String(workers));
        if (retries !== undefined) cmd.push('--retries', String(retries));
        if (maxFailures !== undefined) cmd.push('--max-failures', String(maxFailures));
        if (trace) cmd.push('--trace', trace);

        const effectiveTimeout = timeout ?? 300_000;
        if (wait === false) {
          const started = runTracker.startTrackedRun(cmd, wd.dir, effectiveTimeout);
          if ('error' in started) return err(started.error);
          return ok(runTracker.runStatus(started.run));
        }

        const result = runPlaywright(cmd, wd.dir, effectiveTimeout);
        const failure = spawnFailure(
          result,
          `Playwright test run exceeded the ${effectiveTimeout}ms timeout and was killed.`
        );
        if (failure) return failure;

        const report = readReportOrError(config, wd.dir, {
          missing: `Test run completed but results.json was not found.\nstderr: ${result.stderr ?? ''}`,
          invalid: (error) =>
            `Test run completed but results.json was invalid: ${error}\nstderr: ${result.stderr ?? ''}`,
        });
        if (!report.ok) return report.response;

        return ok(summarizeReport(report.report, result.status ?? -1));
      });
    }
  );

  server.registerTool(
    'get_run_status',
    {
      description:
        'Return status for a tracked Playwright run. Pass runId for a specific background run, or omit it to inspect the latest tracked run for a workingDirectory. If no tracked run exists, returns idle with current results.json metadata; it does not inspect unrelated OS processes.',
      inputSchema: {
        workingDirectory: runStatusWorkingDirectoryField,
        runId: z
          .string()
          .optional()
          .describe('Run identifier returned by run_tests with wait=false.'),
      },
    },
    async ({ workingDirectory, runId }) => {
      if (runId) {
        const run = runTracker.getRun(runId);
        if (!run) return err(`Unknown runId: ${runId}`);
        if (workingDirectory !== undefined) {
          return withWorkingDir(config, workingDirectory, (wd) => {
            if (wd.dir !== run.cwd) {
              return err(
                `workingDirectory "${wd.dir}" does not match runId ${runId} workingDirectory "${run.cwd}".`
              );
            }
            return ok(runTracker.runStatus(run));
          });
        }
        return ok(runTracker.runStatus(run));
      }

      return withWorkingDir(config, workingDirectory, (wd) => {
        const run = runTracker.latestRunForDir(wd.dir);
        return ok(run ? runTracker.runStatus(run) : runTracker.idleStatus(wd.dir));
      });
    }
  );

  server.registerTool(
    'get_failed_tests',
    {
      description:
        'Return failed tests from the last run with error messages and attachment paths.',
      inputSchema: {
        workingDirectory: workingDirectoryField,
      },
    },
    async ({ workingDirectory }) => {
      return withWorkingDir(config, workingDirectory, (wd) => {
        const report = readReportOrError(config, wd.dir, LAST_REPORT_MESSAGES);
        if (!report.ok) return report.response;

        const failed = collectSpecs(report.report.suites)
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
      });
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
      return withWorkingDir(config, workingDirectory, (wd) => {
        const report = readReportOrError(config, wd.dir, LAST_REPORT_MESSAGES);
        if (!report.ok) return report.response;

        const match = findSpec(report.report.suites, (spec) => spec.title === testTitle);
        if (!match) return err(`Test not found in last report: "${testTitle}"`);

        for (const test of match.spec.tests) {
          const result = test.results.at(-1);
          if (!result) continue;
          const attachment = result.attachments.find((a) => a.name === attachmentName);
          if (!attachment?.path) continue;
          if (!attachment.contentType.startsWith('text/'))
            return err(
              `Attachment "${attachmentName}" is binary (${attachment.contentType}) and cannot be returned as text.`
            );

          const attachmentPath = resolveContainedRealPath(wd.dir, attachment.path);
          if (attachmentPath.ok === false) {
            switch (attachmentPath.reason) {
              case 'escaped':
                return err(
                  `Attachment "${attachmentName}" path "${attachment.path}" escapes workingDirectory "${wd.dir}".`
                );
              case 'symlink':
                return err(
                  `Attachment "${attachmentName}" path "${attachment.path}" resolves via symlink to "${attachmentPath.realPath}", which escapes workingDirectory "${wd.dir}".`
                );
              case 'missing':
                continue;
              default:
                return assertNever(attachmentPath);
            }
          }

          const MAX_BYTES = 1_000_000;
          if (attachmentPath.stat.size > MAX_BYTES)
            return err(
              `Attachment "${attachmentName}" is too large to return inline (${attachmentPath.stat.size} bytes).`
            );
          try {
            return ok({
              testTitle,
              attachmentName,
              content: readFileSync(attachmentPath.path, 'utf8'),
            });
          } catch {
            // The attachment can disappear between stat and read; fall
            // through to the stable "not found" response below.
          }
        }

        return err(`Attachment "${attachmentName}" not found for test "${testTitle}".`);
      });
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
      return withWorkingDir(config, workingDirectory, (wd) => {
        const listTimeout = 30_000;
        const result = runPlaywright(buildListTestsCmd(tag), wd.dir, listTimeout);
        const failure = spawnFailure(
          result,
          `Listing Playwright tests exceeded the ${listTimeout}ms timeout and was killed.`
        );
        if (failure) return failure;

        const stdout = result.stdout ?? '';
        let tests: Array<{ title: string; file: string; tags: string[] }>;
        try {
          tests = parseListJson(stdout);
        } catch (e) {
          return err(
            `Failed to parse Playwright --list JSON output: ${errorMessage(e)}\nstderr: ${result.stderr ?? ''}`
          );
        }

        return ok({ count: tests.length, tests });
      });
    }
  );

  return server;
}
