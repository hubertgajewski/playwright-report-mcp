import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventEmitter } from 'events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { z } from 'zod';
import pkgJson from '../../package.json' with { type: 'json' };
import { loadConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { stats as fixtureStats, suites as fixtureSuites } from '../fixtures/data.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn(() => ({
      pid: 1234,
      output: [null, '', ''],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
    })),
  };
});

import { spawn, spawnSync } from 'child_process';
import type { SpawnSyncReturns } from 'child_process';

export const pkg = pkgJson;
export const stats = fixtureStats;

const baseResultsDir = fileURLToPath(new URL('../fixtures/test-results', import.meta.url));
mkdirSync(baseResultsDir, { recursive: true });

export const resultsDir = mkdtempSync(join(baseResultsDir, 'split-'));
export const resultsFile = join(resultsDir, 'results.json');

const attachmentPath = join(resultsDir, 'diagnosis.txt');
writeFileSync(attachmentPath, 'AI diagnosis: Button selector .submit-btn not found in DOM.\n');

export const suites = structuredClone(fixtureSuites);
suites[0].specs[1].tests[0].results[0].attachments = [
  { name: 'diagnosis', contentType: 'text/plain', path: attachmentPath },
];

export const KILL_ESCALATION_MS_UNDER_TEST = 5_000;
export const ACTIVE_RUN_LIMIT_UNDER_TEST = 4;
export const TRACKED_RUN_LIMIT_UNDER_TEST = 50;
export const TEST_CONFIG = loadConfig({ ...process.env, PW_RESULTS_FILE: resultsFile });
export const ALLOWED_DIRS = TEST_CONFIG.allowedDirs;

export const spawnSyncMock = vi.mocked(spawnSync);
export const spawnMock = vi.mocked(spawn);

export function spawnSyncResult(
  overrides: Partial<SpawnSyncReturns<string>> = {}
): SpawnSyncReturns<string> {
  const stdout = overrides.stdout ?? '';
  const stderr = overrides.stderr ?? '';
  return {
    pid: overrides.pid ?? 1234,
    output: overrides.output ?? [null, stdout, stderr],
    stdout,
    stderr,
    status: overrides.status === undefined ? 0 : overrides.status,
    signal: overrides.signal === undefined ? null : overrides.signal,
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

type SpawnChildMock = ReturnType<typeof spawn> &
  EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };

export type SpawnControl = {
  child: SpawnChildMock;
  fail: (error: Error) => void;
  finish: (result?: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
  }) => void;
};

let spawnControls: SpawnControl[] = [];
let processKillSpy: ReturnType<typeof vi.spyOn> | null = null;

export function createSpawnControl(
  options: number | { pid?: number; closeOnKill?: boolean } = 4321
): SpawnControl {
  const pid = typeof options === 'number' ? options : (options.pid ?? 4321);
  const closeOnKill = typeof options === 'number' ? true : (options.closeOnKill ?? true);
  const child = new EventEmitter() as SpawnChildMock;
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  let closed = false;
  const finish: SpawnControl['finish'] = (result = {}) => {
    if (closed) return;
    closed = true;
    if (result.stdout) child.stdout.write(result.stdout);
    if (result.stderr) child.stderr.write(result.stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', result.code ?? 0, result.signal ?? null);
  };

  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (closeOnKill) finish({ code: null, signal });
    return true;
  });

  return {
    child,
    fail: (error: Error) => child.emit('error', error),
    finish,
  };
}

export function mockProcessGroupSignalSuccess() {
  processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  return processKillSpy;
}

export function mockProcessGroupSignalFailure() {
  processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('no such process group');
  });
  return processKillSpy;
}

export function mockNextSpawn(control: SpawnControl): SpawnControl {
  spawnControls.push(control);
  spawnMock.mockReturnValueOnce(control.child);
  return control;
}

export function resetSpawnState() {
  spawnMock.mockReset();
  spawnControls = [];
  processKillSpy = null;
}

export function cleanupSpawnState() {
  for (const control of spawnControls) control.finish({ code: 0 });
  spawnControls = [];
  processKillSpy?.mockRestore();
  processKillSpy = null;
  vi.useRealTimers();
  writeDefaultReport();
}

export function waitForRunEvents() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function writeDefaultReport() {
  writeFileSync(resultsFile, JSON.stringify({ suites, stats }, null, 2));
}

export function writeCustomReport(report: unknown) {
  writeFileSync(resultsFile, JSON.stringify(report));
}

export function markReportUpdatedAfter(startedAt: string) {
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) throw new Error(`Invalid startedAt timestamp: ${startedAt}`);
  const updatedAt = new Date(startedAtMs + 1000);
  utimesSync(resultsFile, updatedAt, updatedAt);
}

export function markReportUpdatedBefore(startedAt: string) {
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) throw new Error(`Invalid startedAt timestamp: ${startedAt}`);
  const updatedAt = new Date(startedAtMs - 1000);
  utimesSync(resultsFile, updatedAt, updatedAt);
}

export function deleteReport() {
  try {
    unlinkSync(resultsFile);
  } catch {
    // already gone
  }
}

export function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

export let client: Client;

export function setupMcpClient() {
  beforeAll(async () => {
    writeDefaultReport();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await createServer({ config: TEST_CONFIG }).connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    rmSync(resultsDir, { recursive: true, force: true });
  });
}

export type TextContent = { type: 'text'; text: string };

const ToolStatsSchema = z.object({
  expected: z.number(),
  unexpected: z.number(),
  flaky: z.number().optional(),
  skipped: z.number(),
  duration: z.number(),
});

const ResultsFileStatusSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  mtimeMs: z.number().nullable(),
  size: z.number().nullable(),
  updatedAfterStart: z.boolean().nullable(),
});

const ProgressSchema = z.object({
  current: z.number().nullable(),
  total: z.number().nullable(),
});

const RunCommandSchema = z.object({
  executable: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
});

const RunStatusResultSchema = z.object({
  runId: z.string().nullable(),
  state: z.string(),
  tracking: z.boolean(),
  pid: z.number().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  elapsedMs: z.number(),
  timeoutMs: z.number().nullable(),
  command: RunCommandSchema.nullable(),
  progress: ProgressSchema,
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
  resultsFile: ResultsFileStatusSchema,
  stats: ToolStatsSchema.nullable(),
});

const TrackedRunStatusResultSchema = RunStatusResultSchema.extend({
  runId: z.string(),
  startedAt: z.string(),
  command: RunCommandSchema,
});

const RunTestsResultSchema = z.object({
  exitCode: z.number(),
  stats: ToolStatsSchema,
  tests: z.array(
    z.object({
      title: z.string(),
      file: z.string(),
      ok: z.boolean(),
      results: z.array(
        z.object({
          project: z.string(),
          status: z.string(),
          duration: z.number(),
          error: z.string().nullable(),
        })
      ),
    })
  ),
});

const FailedTestsResultSchema = z.object({
  failedCount: z.number(),
  tests: z.array(
    z.object({
      title: z.string(),
      file: z.string(),
      failures: z.array(
        z.object({
          project: z.string(),
          status: z.string(),
          error: z.string().nullable(),
          attachments: z.array(
            z.object({
              name: z.string(),
              path: z.string().optional(),
            })
          ),
        })
      ),
    })
  ),
});

const AttachmentResultSchema = z.object({
  testTitle: z.string(),
  attachmentName: z.string(),
  content: z.string(),
});

const ListTestsResultSchema = z.object({
  count: z.number(),
  tests: z.array(
    z.object({
      title: z.string(),
      file: z.string(),
      tags: z.array(z.string()),
    })
  ),
});

export type RunStatusResult = z.infer<typeof RunStatusResultSchema>;
export type TrackedRunStatusResult = z.infer<typeof TrackedRunStatusResultSchema>;
export type RunTestsResult = z.infer<typeof RunTestsResultSchema>;
export type FailedTestsResult = z.infer<typeof FailedTestsResultSchema>;
export type AttachmentResult = z.infer<typeof AttachmentResultSchema>;
export type ListTestsResult = z.infer<typeof ListTestsResultSchema>;

function parseToolResult<T>(
  result: Awaited<ReturnType<Client['callTool']>>,
  schema: z.ZodType<T>
): T {
  expect(result.isError).toBeFalsy();
  const text = (result.content as TextContent[])[0].text;
  const parsed: unknown = JSON.parse(text);
  return schema.parse(parsed);
}

export function parseRunStatusResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return parseToolResult(result, RunStatusResultSchema);
}

export function parseTrackedRunStatusResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return parseToolResult(result, TrackedRunStatusResultSchema);
}

export function parseRunTestsResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return parseToolResult(result, RunTestsResultSchema);
}

export function parseFailedTestsResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return parseToolResult(result, FailedTestsResultSchema);
}

export function parseAttachmentResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return parseToolResult(result, AttachmentResultSchema);
}

export function parseListTestsResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return parseToolResult(result, ListTestsResultSchema);
}
