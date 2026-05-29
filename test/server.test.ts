import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import pkg from '../package.json' with { type: 'json' };
import { stats, suites } from './fixtures/data.js';

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
import {
  ALLOWED_DIRS,
  buildListTestsCmd,
  formatStartupBanner,
  isInside,
  loadPackageMeta,
  parseAllowedDirs,
  parseListJson,
  server,
} from '../index.js';

const KILL_ESCALATION_MS_UNDER_TEST = 5_000;
const ACTIVE_RUN_LIMIT_UNDER_TEST = 4;
const TRACKED_RUN_LIMIT_UNDER_TEST = 50;
const spawnSyncMock = vi.mocked(spawnSync);
const spawnMock = vi.mocked(spawn);

function spawnSyncResult(
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

type SpawnControl = {
  child: SpawnChildMock;
  fail: (error: Error) => void;
  finish: (result?: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
  }) => void;
};

function createSpawnControl(
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

let spawnControls: SpawnControl[] = [];
let processKillSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockProcessGroupSignalSuccess() {
  processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  return processKillSpy;
}

function mockProcessGroupSignalFailure() {
  processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('no such process group');
  });
  return processKillSpy;
}

function mockNextSpawn(control: SpawnControl): SpawnControl {
  spawnControls.push(control);
  spawnMock.mockReturnValueOnce(control.child);
  return control;
}

function waitForRunEvents() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const resultsDir = fileURLToPath(new URL('./fixtures/test-results', import.meta.url));
const resultsFile = join(resultsDir, 'results.json');

function writeDefaultReport() {
  writeFileSync(resultsFile, JSON.stringify({ suites, stats }, null, 2));
}

function writeCustomReport(report: unknown) {
  writeFileSync(resultsFile, JSON.stringify(report));
}

function markReportUpdatedAfter(startedAt: string) {
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) throw new Error(`Invalid startedAt timestamp: ${startedAt}`);
  const updatedAt = new Date(startedAtMs + 1000);
  utimesSync(resultsFile, updatedAt, updatedAt);
}

function deleteReport() {
  try {
    unlinkSync(resultsFile);
  } catch {
    // already gone
  }
}

let client: Client;

beforeAll(async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

type TextContent = { type: 'text'; text: string };

function parseResult(result: Awaited<ReturnType<typeof client.callTool>>) {
  expect(result.isError).toBeFalsy();
  const text = (result.content as TextContent[])[0].text;
  return JSON.parse(text);
}

describe('server identity', () => {
  // Covers the source-layout branch of loadPackageMeta (index.ts sibling to package.json).
  // The dist-layout branch is covered by test/e2e.test.ts.
  it('advertises name and version from package.json', () => {
    const info = client.getServerVersion();
    expect(info).toMatchObject({ name: pkg.name, version: pkg.version });
  });
});

describe('get_failed_tests', () => {
  let data: ReturnType<typeof parseResult>;

  beforeAll(async () => {
    data = parseResult(await client.callTool({ name: 'get_failed_tests', arguments: {} }));
  });

  it('returns only failed tests', () => {
    expect(data.failedCount).toBe(1);
    expect(data.tests[0].title).toBe('login fails with wrong password');
  });

  it('includes error message', () => {
    expect(data.tests[0].failures[0].error).toContain('Login failed');
  });

  it('includes attachment metadata', () => {
    const attachments = data.tests[0].failures[0].attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('diagnosis');
  });
});

describe('get_test_attachment', () => {
  it('returns attachment content', async () => {
    const data = parseResult(
      await client.callTool({
        name: 'get_test_attachment',
        arguments: { testTitle: 'login fails with wrong password', attachmentName: 'diagnosis' },
      })
    );
    expect(data.content).toContain('Button selector');
  });

  it('returns error for unknown test', async () => {
    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: { testTitle: 'nonexistent test', attachmentName: 'diagnosis' },
    });
    expect(result.isError).toBe(true);
  });

  it('returns error for unknown attachment', async () => {
    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: { testTitle: 'login fails with wrong password', attachmentName: 'screenshot' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('run_tests — spec path validation', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('rejects spec paths outside the project directory', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: '../../etc/passwd' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('within the project directory');
  });

  it('accepts an absolute spec path that resolves inside the working directory', async () => {
    // Positive counterpart to the `..` rejection test: `resolve(wd, absPath)` returns
    // absPath unchanged, so the validation must still accept it when it falls within wd.
    const absInside = join(ALLOWED_DIRS[0], 'tests', 'auth.spec.ts');
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: absInside },
    });
    expect(result.isError).toBeFalsy();
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain(absInside);
  });
});

describe('run_tests — timeout', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('defaults to 300000 ms when timeout is omitted', async () => {
    await client.callTool({ name: 'run_tests', arguments: {} });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0][2]).toMatchObject({ timeout: 300_000 });
  });

  it('passes the custom timeout through to spawnSync verbatim (milliseconds)', async () => {
    await client.callTool({ name: 'run_tests', arguments: { timeout: 60_000 } });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0][2]).toMatchObject({ timeout: 60_000 });
  });

  it('rejects non-positive timeout values', async () => {
    const result = await client.callTool({ name: 'run_tests', arguments: { timeout: 0 } });
    expect(result.isError).toBe(true);
  });

  it('surfaces an explicit error when spawnSync times out under a caller-specified timeout', async () => {
    // Node's spawnSync({ timeout }) populates BOTH error.code='ETIMEDOUT' and signal='SIGTERM'
    // when the timer fires; the error branch runs first, so assert on that path.
    const timeoutError = Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncMock.mockReturnValueOnce(
      spawnSyncResult({
        status: null,
        signal: 'SIGTERM',
        error: timeoutError,
        stdout: '',
        stderr: '',
      })
    );
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { timeout: 1000 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('exceeded the 1000ms timeout');
    expect(text).not.toContain('Failed to spawn');
  });

  it('reports the default 300000 ms in the timeout message when no timeout was specified', async () => {
    const timeoutError = Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncMock.mockReturnValueOnce(
      spawnSyncResult({
        status: null,
        signal: 'SIGTERM',
        error: timeoutError,
        stdout: '',
        stderr: '',
      })
    );
    const result = await client.callTool({ name: 'run_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('exceeded the 300000ms timeout');
  });
});

describe('run_tests — non-blocking status polling', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnControls = [];
    processKillSpy = null;
  });

  afterEach(() => {
    for (const control of spawnControls) control.finish({ code: 0 });
    spawnControls = [];
    processKillSpy?.mockRestore();
    processKillSpy = null;
    vi.useRealTimers();
    writeDefaultReport();
  });

  it('starts a run without waiting and returns a stable runId', async () => {
    const run = mockNextSpawn(createSpawnControl());

    const data = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    expect(data.runId).toMatch(/^run-/);
    expect(data.state).toBe('running');
    expect(data.pid).toBe(4321);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(run.child.kill).not.toHaveBeenCalled();
  });

  it('reports the status of an active run with command metadata and results.json state', async () => {
    writeDefaultReport();
    await new Promise((resolve) => setTimeout(resolve, 5));
    mockNextSpawn(createSpawnControl(9876));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, tag: '@smoke' } })
    );

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status).toMatchObject({
      runId: started.runId,
      state: 'running',
      pid: 9876,
      exitCode: null,
      signal: null,
      error: null,
    });
    expect(status.command.args).toContain('--grep');
    expect(status.command.args).toContain('@smoke');
    expect(status.resultsFile.exists).toBe(true);
    expect(status.resultsFile.updatedAfterStart).toBe(false);
    expect(status.resultsFile.mtimeMs).toEqual(expect.any(Number));
    expect(status.stats).toBeNull();
    expect(status.elapsedMs).toEqual(expect.any(Number));
  });

  it('reports live stats for a running run after results.json is updated', async () => {
    const liveStats = { expected: 3, unexpected: 1, skipped: 0, duration: 321 };
    mockNextSpawn(createSpawnControl(1357));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeCustomReport({ suites, stats: liveStats });

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status.state).toBe('running');
    expect(status.resultsFile.updatedAfterStart).toBe(true);
    expect(status.stats).toEqual(liveStats);
  });

  it('uses the latest tracked run for the working directory when runId is omitted', async () => {
    mockNextSpawn(createSpawnControl(2468));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    const status = parseResult(await client.callTool({ name: 'get_run_status', arguments: {} }));

    expect(status.runId).toBe(started.runId);
    expect(status.state).toBe('running');
    expect(status.pid).toBe(2468);
  });

  it('uses insertion order to select the latest run when two runs start in the same millisecond', async () => {
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const first = mockNextSpawn(createSpawnControl(1111));
      const firstStarted = parseResult(
        await client.callTool({ name: 'run_tests', arguments: { wait: false } })
      );
      first.finish({ code: 0 });

      mockNextSpawn(createSpawnControl(2222));
      const secondStarted = parseResult(
        await client.callTool({ name: 'run_tests', arguments: { wait: false } })
      );

      const status = parseResult(await client.callTool({ name: 'get_run_status', arguments: {} }));

      expect(firstStarted.runId).not.toBe(secondStarted.runId);
      expect(status.runId).toBe(secondStarted.runId);
      expect(status.pid).toBe(2222);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('returns idle status when runId is omitted and no run is tracked for the working directory', async () => {
    const status = parseResult(
      await client.callTool({
        name: 'get_run_status',
        arguments: { workingDirectory: 'test/fixtures/pw-project' },
      })
    );

    expect(status).toMatchObject({
      runId: null,
      state: 'idle',
      tracking: false,
      pid: null,
      command: null,
      exitCode: null,
      signal: null,
      error: null,
    });
    expect(status.resultsFile.exists).toEqual(expect.any(Boolean));
  });

  it('reports terminal failed status with stderr tail and parsed stats', async () => {
    const run = mockNextSpawn(createSpawnControl());
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    writeDefaultReport();
    markReportUpdatedAfter(started.startedAt);
    run.finish({ code: 1, stderr: 'one test failed' });
    await waitForRunEvents();

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status).toMatchObject({
      runId: started.runId,
      state: 'failed',
      exitCode: 1,
      signal: null,
      stderrTail: 'one test failed',
      stats,
    });
    expect(status.completedAt).toEqual(expect.any(String));
  });

  it('keeps report stats isolated to the run that produced them', async () => {
    const firstStats = { expected: 11, unexpected: 0, skipped: 0, duration: 110 };
    const secondStats = { expected: 22, unexpected: 1, skipped: 0, duration: 220 };

    const first = mockNextSpawn(createSpawnControl(1111));
    const firstStarted = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );
    writeCustomReport({ suites, stats: firstStats });
    markReportUpdatedAfter(firstStarted.startedAt);
    first.finish({ code: 0 });

    const second = mockNextSpawn(createSpawnControl(2222));
    const secondStarted = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );
    writeCustomReport({ suites, stats: secondStats });
    markReportUpdatedAfter(secondStarted.startedAt);
    second.finish({ code: 0 });

    const firstStatus = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: firstStarted.runId } })
    );
    const secondStatus = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: secondStarted.runId } })
    );

    expect(firstStatus.stats).toEqual(firstStats);
    expect(secondStatus.stats).toEqual(secondStats);
  });

  it('reports timeout status after killing a long-running process', async () => {
    mockProcessGroupSignalFailure();
    const run = mockNextSpawn(createSpawnControl());
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status.state).toBe('timedOut');
    expect(status.signal).toBe('SIGTERM');
    expect(status.error).toContain('exceeded the 1ms timeout');
    expect(run.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates a timed-out run to SIGKILL when SIGTERM does not close the process', async () => {
    vi.useFakeTimers();
    const killSpy = mockProcessGroupSignalFailure();
    const run = mockNextSpawn(createSpawnControl({ closeOnKill: false }));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(run.child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(KILL_ESCALATION_MS_UNDER_TEST);

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(run.child.kill).toHaveBeenCalledWith('SIGKILL');
    if (process.platform !== 'win32') {
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
    }
    expect(status.state).toBe('running');
    expect(status.signal).toBe('SIGKILL');
    expect(status.completedAt).toBeNull();
    expect(status.error).toContain('exceeded the 1ms timeout');

    run.finish({ code: null, signal: 'SIGKILL' });
    const closedStatus = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(closedStatus.state).toBe('timedOut');
    expect(closedStatus.completedAt).toEqual(expect.any(String));
  });

  it('preserves timeout status when the child emits an error after timeout', async () => {
    vi.useFakeTimers();
    mockProcessGroupSignalFailure();
    const run = mockNextSpawn(createSpawnControl({ closeOnKill: false }));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );

    await vi.advanceTimersByTimeAsync(1);
    run.fail(new Error('post-timeout process error'));

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status.state).toBe('timedOut');
    expect(status.error).toContain('exceeded the 1ms timeout');
    expect(status.error).not.toContain('post-timeout process error');
    expect(status.completedAt).toEqual(expect.any(String));
  });

  it('signals the process group instead of the direct child when the group signal succeeds', async () => {
    vi.useFakeTimers();
    const killSpy = mockProcessGroupSignalSuccess();
    const run = mockNextSpawn(createSpawnControl({ closeOnKill: false }));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );
    expect(spawnMock.mock.calls[0][2]).toMatchObject({
      detached: process.platform !== 'win32',
    });

    await vi.advanceTimersByTimeAsync(1);

    if (process.platform === 'win32') {
      expect(run.child.kill).toHaveBeenCalledWith('SIGTERM');
    } else {
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(run.child.kill).not.toHaveBeenCalled();
    }

    run.finish({ code: null, signal: 'SIGTERM' });
    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status.state).toBe('timedOut');
    expect(status.signal).toBe('SIGTERM');

    await vi.advanceTimersByTimeAsync(KILL_ESCALATION_MS_UNDER_TEST);
    if (process.platform !== 'win32') {
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
    }
  });

  it('reports spawn failure status', async () => {
    const run = mockNextSpawn(createSpawnControl());
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    run.fail(new Error('ENOENT'));
    await waitForRunEvents();

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status.state).toBe('failed');
    expect(status.error).toContain('Failed to spawn Playwright');
    expect(status.error).toContain('ENOENT');
  });

  it('reports synchronous spawn exceptions as failed tracked runs', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn threw');
    });

    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );
    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status.state).toBe('failed');
    expect(status.error).toContain('spawn threw');
  });

  it('reports a completed run with missing results.json without reading stale data', async () => {
    deleteReport();
    const run = mockNextSpawn(createSpawnControl());
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    run.finish({ code: 0 });
    await waitForRunEvents();

    const status = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status.state).toBe('completed');
    expect(status.resultsFile.exists).toBe(false);
    expect(status.resultsFile.mtimeMs).toBeNull();
    expect(status.stats).toBeNull();
  });

  it('returns a structured error for an unknown runId', async () => {
    const result = await client.callTool({
      name: 'get_run_status',
      arguments: { runId: 'run-does-not-exist' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('Unknown runId');
  });

  it('rejects starting a second tracked run in the same working directory while one is active', async () => {
    mockNextSpawn(createSpawnControl(1111));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    const result = await client.callTool({ name: 'run_tests', arguments: { wait: false } });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('already running');
    expect((result.content as TextContent[])[0].text).toContain(started.runId);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out process active until timeout cleanup completes', async () => {
    vi.useFakeTimers();
    mockProcessGroupSignalFailure();
    mockNextSpawn(createSpawnControl({ closeOnKill: false }));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );
    await vi.advanceTimersByTimeAsync(1);

    const result = await client.callTool({ name: 'run_tests', arguments: { wait: false } });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('already running');
    expect((result.content as TextContent[])[0].text).toContain(started.runId);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects new tracked runs when the global active run limit is reached', async () => {
    const workingDirectories = [
      '.',
      'test',
      'test/fixtures',
      'test/fixtures/test-results',
      'test/fixtures/pw-project',
    ];

    for (let i = 0; i < ACTIVE_RUN_LIMIT_UNDER_TEST; i++) {
      mockNextSpawn(createSpawnControl(6_000 + i));
      parseResult(
        await client.callTool({
          name: 'run_tests',
          arguments: { wait: false, workingDirectory: workingDirectories[i] },
        })
      );
    }

    const result = await client.callTool({
      name: 'run_tests',
      arguments: {
        wait: false,
        workingDirectory: workingDirectories[ACTIVE_RUN_LIMIT_UNDER_TEST],
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('Too many active Playwright runs');
    expect(spawnMock).toHaveBeenCalledTimes(ACTIVE_RUN_LIMIT_UNDER_TEST);
  });

  it('requires a supplied workingDirectory to match the requested runId', async () => {
    mockNextSpawn(createSpawnControl());
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    const result = await client.callTool({
      name: 'get_run_status',
      arguments: { runId: started.runId, workingDirectory: 'test/fixtures/pw-project' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('does not match');
  });

  it('validates supplied workingDirectory before matching it to a runId', async () => {
    mockNextSpawn(createSpawnControl());
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    const result = await client.callTool({
      name: 'get_run_status',
      arguments: { runId: started.runId, workingDirectory: 'test/fixtures/does-not-exist' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('does not exist');
  });

  it('accepts runId with a matching supplied workingDirectory', async () => {
    mockNextSpawn(createSpawnControl(7777));
    const started = parseResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    const status = parseResult(
      await client.callTool({
        name: 'get_run_status',
        arguments: { runId: started.runId, workingDirectory: '.' },
      })
    );

    expect(status.runId).toBe(started.runId);
    expect(status.pid).toBe(7777);
  });

  it('evicts old terminal runs after the tracked run limit', async () => {
    let firstRunId = '';
    let lastRunId = '';
    for (let i = 0; i < TRACKED_RUN_LIMIT_UNDER_TEST + 1; i++) {
      const run = mockNextSpawn(createSpawnControl(5_000 + i));
      const started = parseResult(
        await client.callTool({ name: 'run_tests', arguments: { wait: false } })
      );
      if (i === 0) firstRunId = started.runId;
      lastRunId = started.runId;
      run.finish({ code: 0 });
    }

    const result = await client.callTool({
      name: 'get_run_status',
      arguments: { runId: firstRunId },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('Unknown runId');

    const retained = parseResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: lastRunId } })
    );
    expect(retained.runId).toBe(lastRunId);
    expect(retained.state).toBe('completed');
  });
});

describe('parseListJson — tag extraction', () => {
  it('returns each spec with @-prefixed tags', () => {
    const input = JSON.stringify({
      suites: [
        {
          title: 'nav.spec.ts',
          file: 'tests/nav.spec.ts',
          specs: [
            {
              title: 'home page loads',
              file: 'tests/nav.spec.ts',
              line: 6,
              tags: ['smoke', 'regression'],
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    const tests = parseListJson(input);
    expect(tests).toEqual([
      {
        title: 'home page loads',
        file: 'tests/nav.spec.ts',
        tags: ['@smoke', '@regression'],
      },
    ]);
  });

  it('deduplicates specs that appear once per project', () => {
    const spec = (projectName: string) => ({
      title: 'login succeeds',
      file: 'tests/auth.spec.ts',
      line: 5,
      tags: ['smoke'],
      tests: [{ projectName, results: [] }],
    });
    const input = JSON.stringify({
      suites: [
        {
          title: 'auth.spec.ts',
          file: 'tests/auth.spec.ts',
          specs: [spec('Chromium'), spec('Firefox'), spec('Webkit')],
        },
      ],
    });
    const tests = parseListJson(input);
    expect(tests).toHaveLength(1);
    expect(tests[0].tags).toEqual(['@smoke']);
  });

  it('flattens tags from nested suites', () => {
    const input = JSON.stringify({
      suites: [
        {
          title: 'nav.spec.ts',
          file: 'tests/nav.spec.ts',
          specs: [],
          suites: [
            {
              title: 'navigation',
              specs: [
                {
                  title: 'menu opens',
                  file: 'tests/nav.spec.ts',
                  line: 20,
                  tags: ['smoke'],
                  tests: [{ projectName: 'Chromium', results: [] }],
                },
              ],
            },
          ],
        },
      ],
    });
    const tests = parseListJson(input);
    expect(tests).toEqual([{ title: 'menu opens', file: 'tests/nav.spec.ts', tags: ['@smoke'] }]);
  });

  it('returns an empty tags array when a spec has no tags', () => {
    const input = JSON.stringify({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'untagged',
              file: 'tests/x.spec.ts',
              line: 1,
              tags: [],
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    const tests = parseListJson(input);
    expect(tests).toEqual([{ title: 'untagged', file: 'tests/x.spec.ts', tags: [] }]);
  });

  it('ignores leading non-JSON stdout pollution', () => {
    const json = JSON.stringify({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 't',
              file: 'tests/x.spec.ts',
              line: 1,
              tags: ['smoke'],
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    const polluted = `◇ injected env (0) from .env\n◇ tip { override: true }\n${json}`;
    const tests = parseListJson(polluted);
    expect(tests).toHaveLength(1);
    expect(tests[0].tags).toEqual(['@smoke']);
  });

  it('throws when output contains no JSON object', () => {
    expect(() => parseListJson('no json here')).toThrow();
  });

  it('throws when JSON is malformed', () => {
    expect(() => parseListJson('{"suites": [')).toThrow();
  });

  it('ignores trailing warnings after the JSON body', () => {
    const json = JSON.stringify({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 't',
              file: 'tests/x.spec.ts',
              line: 1,
              tags: ['smoke'],
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    const trailed = `${json}\n(node:123) DeprecationWarning: The something is deprecated\n`;
    const tests = parseListJson(trailed);
    expect(tests).toHaveLength(1);
    expect(tests[0].tags).toEqual(['@smoke']);
  });

  it('handles braces inside string values', () => {
    const json = JSON.stringify({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'renders {placeholder} and "quoted" text',
              file: 'tests/x.spec.ts',
              line: 1,
              tags: ['smoke'],
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    const tests = parseListJson(json);
    expect(tests).toEqual([
      {
        title: 'renders {placeholder} and "quoted" text',
        file: 'tests/x.spec.ts',
        tags: ['@smoke'],
      },
    ]);
  });

  it('throws when the opening brace has no matching close', () => {
    expect(() => parseListJson('prefix\n{"suites": [1, 2')).toThrow(/unbalanced/i);
  });
});

describe('buildListTestsCmd', () => {
  it('requests the JSON reporter with --list', () => {
    expect(buildListTestsCmd()).toEqual(['npx', 'playwright', 'test', '--list', '--reporter=json']);
  });

  it('appends --grep when a tag is provided', () => {
    expect(buildListTestsCmd('@smoke')).toEqual([
      'npx',
      'playwright',
      'test',
      '--list',
      '--reporter=json',
      '--grep',
      '@smoke',
    ]);
  });
});

describe('run_tests — spawn failure', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('returns error when Playwright cannot be spawned', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ error: new Error('ENOENT') }));
    const result = await client.callTool({ name: 'run_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('Failed to spawn Playwright');
    expect(text).toContain('ENOENT');
  });
});

describe('run_tests — missing results.json', () => {
  beforeEach(() => deleteReport());
  afterEach(() => writeDefaultReport());

  it('returns error referencing stderr when the report file is absent', async () => {
    spawnSyncMock.mockReturnValueOnce(
      spawnSyncResult({ status: 1, stderr: 'reporter failed to write output' })
    );
    const result = await client.callTool({ name: 'run_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('results.json was not found');
    expect(text).toContain('reporter failed to write output');
  });
});

describe('run_tests — happy-path summarization', () => {
  it('returns stats and per-test statuses sourced from the last results.json', async () => {
    const data = parseResult(await client.callTool({ name: 'run_tests', arguments: {} }));
    expect(data.stats).toEqual(stats);
    expect(data.tests).toHaveLength(2);
    const byTitle = Object.fromEntries(data.tests.map((t: { title: string }) => [t.title, t]));
    expect(byTitle['login succeeds'].ok).toBe(true);
    expect(byTitle['login succeeds'].results[0]).toMatchObject({
      project: 'Chromium',
      status: 'passed',
      error: null,
    });
    expect(byTitle['login fails with wrong password'].ok).toBe(false);
    expect(byTitle['login fails with wrong password'].results[0]).toMatchObject({
      project: 'Chromium',
      status: 'failed',
    });
    expect(byTitle['login fails with wrong password'].results[0].error).toContain('Login failed');
  });
});

describe('get_failed_tests — missing report', () => {
  beforeEach(() => deleteReport());
  afterEach(() => writeDefaultReport());

  it('returns error when results.json is missing', async () => {
    const result = await client.callTool({ name: 'get_failed_tests', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('No results.json');
  });
});

describe('get_test_attachment — error gates', () => {
  afterEach(() => writeDefaultReport());

  it('returns error when results.json is missing', async () => {
    deleteReport();
    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: { testTitle: 'anything', attachmentName: 'anything' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('No results.json');
  });

  it('rejects binary attachments with a descriptive error', async () => {
    const binaryPath = join(resultsDir, 'screenshot.png');
    writeFileSync(binaryPath, 'fake-png-bytes');
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'binary test',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                {
                  projectName: 'Chromium',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 10,
                      attachments: [
                        { name: 'screenshot', contentType: 'image/png', path: binaryPath },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });

    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: { testTitle: 'binary test', attachmentName: 'screenshot' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('binary');
    expect(text).toContain('image/png');
    unlinkSync(binaryPath);
  });

  it('rejects attachments larger than MAX_BYTES', async () => {
    const bigPath = join(resultsDir, 'big.txt');
    writeFileSync(bigPath, 'x'.repeat(1_000_001));
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'big test',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                {
                  projectName: 'Chromium',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 10,
                      attachments: [{ name: 'diag', contentType: 'text/plain', path: bigPath }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });

    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: { testTitle: 'big test', attachmentName: 'diag' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('too large');
    unlinkSync(bigPath);
  });

  it('falls through to "not found" when the attachment file is missing from disk', async () => {
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'ghost test',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                {
                  projectName: 'Chromium',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 10,
                      attachments: [
                        {
                          name: 'diag',
                          contentType: 'text/plain',
                          path: join(resultsDir, 'does-not-exist.txt'),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });

    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: { testTitle: 'ghost test', attachmentName: 'diag' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('not found');
  });
});

describe('run_tests — command construction', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('passes spec, browser, and tag through to the Playwright command', async () => {
    await client.callTool({
      name: 'run_tests',
      arguments: {
        spec: 'tests/auth.spec.ts',
        browser: 'Chromium',
        tag: '@smoke',
      },
    });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain('--project');
    expect(args).toContain('Chromium');
    expect(args).toContain('--grep');
    expect(args).toContain('@smoke');
    expect(args.some((a) => a.endsWith('tests/auth.spec.ts'))).toBe(true);
  });

  it('passes --update-snapshots with the requested mode', async () => {
    await client.callTool({
      name: 'run_tests',
      arguments: { updateSnapshots: 'changed' },
    });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    const i = args.indexOf('--update-snapshots');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('changed');
  });

  it('omits --update-snapshots when the field is not set', async () => {
    await client.callTool({ name: 'run_tests', arguments: {} });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--update-snapshots');
  });

  it('rejects an invalid updateSnapshots mode at the schema boundary', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { updateSnapshots: 'sometimes' as unknown as 'all' },
    });
    expect(result.isError).toBe(true);
  });

  it('passes --headed when headed is true', async () => {
    await client.callTool({ name: 'run_tests', arguments: { headed: true } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain('--headed');
  });

  it('omits --headed when headed is false', async () => {
    await client.callTool({ name: 'run_tests', arguments: { headed: false } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--headed');
  });

  it('passes --workers with the requested positive integer', async () => {
    await client.callTool({ name: 'run_tests', arguments: { workers: 4 } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    const i = args.indexOf('--workers');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('4');
  });

  it('rejects non-positive workers values at the schema boundary', async () => {
    const result = await client.callTool({ name: 'run_tests', arguments: { workers: 0 } });
    expect(result.isError).toBe(true);
  });

  it('passes --retries with zero when retries is 0', async () => {
    // Retries=0 is a meaningful value (disable retries), not a "not set" signal.
    await client.callTool({ name: 'run_tests', arguments: { retries: 0 } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    const i = args.indexOf('--retries');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('0');
  });

  it('rejects negative retries values at the schema boundary', async () => {
    const result = await client.callTool({ name: 'run_tests', arguments: { retries: -1 } });
    expect(result.isError).toBe(true);
  });

  it('passes --max-failures with the requested positive integer', async () => {
    await client.callTool({ name: 'run_tests', arguments: { maxFailures: 3 } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    const i = args.indexOf('--max-failures');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('3');
  });

  it('rejects non-positive maxFailures values at the schema boundary', async () => {
    const result = await client.callTool({ name: 'run_tests', arguments: { maxFailures: 0 } });
    expect(result.isError).toBe(true);
  });

  it('passes --trace with the requested mode', async () => {
    await client.callTool({
      name: 'run_tests',
      arguments: { trace: 'retain-on-failure' },
    });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    const i = args.indexOf('--trace');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('retain-on-failure');
  });

  it("passes --trace 'off' when the caller explicitly disables tracing", async () => {
    // 'off' is a truthy string, so `if (trace)` still fires. A regression that
    // changed the conditional to `if (trace && trace !== 'off')` would drop this
    // mode silently — worth a dedicated test against the whole enum surface.
    await client.callTool({ name: 'run_tests', arguments: { trace: 'off' } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    const i = args.indexOf('--trace');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('off');
  });

  it('rejects an invalid trace mode at the schema boundary', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { trace: 'sometimes' as unknown as 'on' },
    });
    expect(result.isError).toBe(true);
  });

  it('combines multiple flags in one call without interfering with each other', async () => {
    // Assert adjacency, not just presence — a regression that pushed the value
    // and flag as one string or reordered them would still pass a .toContain
    // check but fail Playwright at runtime.
    await client.callTool({
      name: 'run_tests',
      arguments: {
        updateSnapshots: 'all',
        headed: true,
        workers: 2,
        retries: 1,
        maxFailures: 5,
        trace: 'on',
      },
    });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    // Guard against a future change that drops a flag entirely — without this,
    // a missing flag would return args[0] ('npx') and produce a confusing
    // "expected 'npx' to be 'all'" failure message instead of pinpointing the
    // flag that went missing.
    const pair = (flag: string) => {
      const i = args.indexOf(flag);
      expect(i, `${flag} not found in args: ${args.join(' ')}`).toBeGreaterThanOrEqual(0);
      return args[i + 1];
    };
    expect(pair('--update-snapshots')).toBe('all');
    expect(args).toContain('--headed');
    expect(pair('--workers')).toBe('2');
    expect(pair('--retries')).toBe('1');
    expect(pair('--max-failures')).toBe('5');
    expect(pair('--trace')).toBe('on');
  });
});

describe('run_tests — edge cases in spawn result', () => {
  afterEach(() => writeDefaultReport());

  it('reports exitCode -1 when spawn result has null status', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: null }));
    const data = parseResult(await client.callTool({ name: 'run_tests', arguments: {} }));
    expect(data.exitCode).toBe(-1);
  });

  it('reports unknown status and zero duration for tests with no result attempts', async () => {
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'never ran',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: true,
              tests: [{ projectName: 'Chromium', status: 'expected', results: [] }],
            },
          ],
        },
      ],
      stats: { expected: 1, unexpected: 0, skipped: 0, duration: 0 },
    });
    const data = parseResult(await client.callTool({ name: 'run_tests', arguments: {} }));
    expect(data.tests[0].results[0]).toMatchObject({
      project: 'Chromium',
      status: 'unknown',
      duration: 0,
      error: null,
    });
  });

  it('handles spawn result with no stderr field when the report is missing', async () => {
    deleteReport();
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: 1 }));
    const result = await client.callTool({ name: 'run_tests', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toMatch(/stderr:\s*$/);
  });
});

describe('get_failed_tests — edge cases', () => {
  afterEach(() => writeDefaultReport());

  it('returns null error when the failing result has no error object', async () => {
    // Exercises the `?? null` fallback in the failure-to-error mapping.
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'errorless failure',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                {
                  projectName: 'Chromium',
                  status: 'unexpected',
                  results: [{ status: 'failed', duration: 10, attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });
    const data = parseResult(await client.callTool({ name: 'get_failed_tests', arguments: {} }));
    expect(data.tests[0].failures[0].error).toBeNull();
  });

  it('returns the failing spec with empty failures when its tests have no result attempts', async () => {
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'empty results',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [{ projectName: 'Chromium', status: 'unexpected', results: [] }],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 0 },
    });
    const data = parseResult(await client.callTool({ name: 'get_failed_tests', arguments: {} }));
    expect(data.failedCount).toBe(1);
    expect(data.tests[0].failures).toEqual([]);
  });
});

describe('get_test_attachment — skips entries without result attempts', () => {
  afterEach(() => writeDefaultReport());

  it('falls through from a missing-on-disk attachment to a later test entry with a readable file', async () => {
    // The first project lists the attachment but its file is gone from disk; the loop must
    // continue past the swallowed statSync error and return content from the second project.
    const workingPath = join(resultsDir, 'works.txt');
    writeFileSync(workingPath, 'readable payload');
    try {
      writeCustomReport({
        suites: [
          {
            title: 'x.spec.ts',
            file: 'tests/x.spec.ts',
            specs: [
              {
                title: 'shared name',
                file: 'tests/x.spec.ts',
                line: 1,
                ok: false,
                tests: [
                  {
                    projectName: 'Chromium',
                    status: 'unexpected',
                    results: [
                      {
                        status: 'failed',
                        duration: 10,
                        attachments: [
                          {
                            name: 'diag',
                            contentType: 'text/plain',
                            path: join(resultsDir, 'missing.txt'),
                          },
                        ],
                      },
                    ],
                  },
                  {
                    projectName: 'Firefox',
                    status: 'unexpected',
                    results: [
                      {
                        status: 'failed',
                        duration: 10,
                        attachments: [
                          { name: 'diag', contentType: 'text/plain', path: workingPath },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        stats: { expected: 0, unexpected: 1, skipped: 0, duration: 20 },
      });

      const data = parseResult(
        await client.callTool({
          name: 'get_test_attachment',
          arguments: { testTitle: 'shared name', attachmentName: 'diag' },
        })
      );
      expect(data.content).toBe('readable payload');
    } finally {
      try {
        unlinkSync(workingPath);
      } catch {
        // already gone
      }
    }
  });

  it('continues past tests whose results array is empty and returns not-found', async () => {
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'mixed',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                { projectName: 'Chromium', status: 'unexpected', results: [] },
                {
                  projectName: 'Firefox',
                  status: 'unexpected',
                  results: [{ status: 'failed', duration: 10, attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });
    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: { testTitle: 'mixed', attachmentName: 'diag' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('not found');
  });
});

describe('list_tests — via MCP client', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('returns tests parsed from the JSON reporter output', async () => {
    const reporterJson = JSON.stringify({
      suites: [
        {
          title: 'nav.spec.ts',
          file: 'tests/nav.spec.ts',
          specs: [
            {
              title: 'home loads',
              file: 'tests/nav.spec.ts',
              line: 3,
              tags: ['smoke'],
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ stdout: reporterJson }));

    const data = parseResult(await client.callTool({ name: 'list_tests', arguments: {} }));
    expect(data.count).toBe(1);
    expect(data.tests[0]).toEqual({
      title: 'home loads',
      file: 'tests/nav.spec.ts',
      tags: ['@smoke'],
    });
  });

  it('passes --grep to Playwright when a tag filter is provided', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ stdout: '{"suites":[]}' }));
    await client.callTool({ name: 'list_tests', arguments: { tag: '@smoke' } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain('--grep');
    expect(args).toContain('@smoke');
  });

  it('returns error when Playwright cannot be spawned', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ error: new Error('ENOENT') }));
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('Failed to spawn Playwright');
  });

  it('surfaces an explicit error when spawnSync times out under the 30s list_tests cap', async () => {
    const timeoutError = Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncMock.mockReturnValueOnce(
      spawnSyncResult({
        status: null,
        signal: 'SIGTERM',
        error: timeoutError,
        stdout: '',
        stderr: '',
      })
    );
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('exceeded the 30000ms timeout');
    expect(text).not.toContain('Failed to spawn');
  });

  it('returns error when --list output cannot be parsed as JSON', async () => {
    spawnSyncMock.mockReturnValueOnce(
      spawnSyncResult({
        status: 0,
        stdout: 'no json here',
        stderr: 'some warning',
      })
    );
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('Failed to parse');
    expect(text).toContain('some warning');
  });

  it('returns a parse error when --list stdout is empty', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult());
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('Failed to parse');
    expect(text).toMatch(/stderr:\s*$/);
  });

  it('returns zero tests when the reporter JSON has no suites field', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ stdout: '{}' }));
    const data = parseResult(await client.callTool({ name: 'list_tests', arguments: {} }));
    expect(data).toEqual({ count: 0, tests: [] });
  });
});

describe('parseListJson — tag normalization edge cases', () => {
  it('preserves already @-prefixed tags without doubling', () => {
    const input = JSON.stringify({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'already prefixed',
              file: 'tests/x.spec.ts',
              line: 1,
              tags: ['@smoke'],
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    expect(parseListJson(input)).toEqual([
      { title: 'already prefixed', file: 'tests/x.spec.ts', tags: ['@smoke'] },
    ]);
  });

  it('defaults to an empty tags array when the tags field is missing', () => {
    const input = JSON.stringify({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'no tags field',
              file: 'tests/x.spec.ts',
              line: 1,
              tests: [{ projectName: 'Chromium', results: [] }],
            },
          ],
        },
      ],
    });
    expect(parseListJson(input)).toEqual([
      { title: 'no tags field', file: 'tests/x.spec.ts', tags: [] },
    ]);
  });
});

describe('loadPackageMeta', () => {
  // Layout under test: tmpRoot/
  //                      ├── package.json      ← parent candidate
  //                      └── dist/
  //                          └── package.json  ← first candidate
  // Tests drive loadPackageMeta(join(tmpRoot, 'dist')) to exercise both candidates.
  let tmpRoot: string;
  let distDir: string;
  const firstPath = () => join(distDir, 'package.json');
  const parentPath = () => join(tmpRoot, 'package.json');

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'pw-report-mcp-pkgmeta-'));
    distDir = join(tmpRoot, 'dist');
    mkdirSync(distDir);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the first candidate when it has valid name/version', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first', version: '1.0.0' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '9.9.9' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'first', version: '1.0.0' });
  });

  it('falls through to the parent candidate when the first is missing', () => {
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '2.3.4' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '2.3.4' });
  });

  it('skips a candidate with malformed JSON and falls through', () => {
    writeFileSync(firstPath(), 'not valid json {{{');
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '3.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '3.0.0' });
  });

  it('skips a candidate missing version and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '4.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '4.0.0' });
  });

  it('skips a candidate missing name and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ version: '5.0.0' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '5.0.1' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '5.0.1' });
  });

  it('skips a candidate where name/version are not strings and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first', version: 1 }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '6.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '6.0.0' });
  });

  it('skips a candidate with an empty name and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '', version: '7.0.0' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '7.1.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '7.1.0' });
  });

  it('skips a candidate with an empty version and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first', version: '' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '8.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '8.0.0' });
  });

  it('skips a candidate with whitespace-only name/version and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '   ', version: '\t\n' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '9.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '9.0.0' });
  });

  it('trims leading/trailing whitespace from accepted name and version', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '  padded  ', version: '\t10.0.0\n' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'padded', version: '10.0.0' });
  });

  it('throws when the only candidate has empty name/version', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '', version: '' }));
    expect(() => loadPackageMeta(distDir)).toThrow(/Could not locate package\.json/);
  });

  it('throws when no candidate has valid metadata', () => {
    writeFileSync(firstPath(), 'garbage');
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent' })); // missing version
    expect(() => loadPackageMeta(distDir)).toThrow(/Could not locate package\.json/);
  });

  it('throws when neither candidate exists on disk', () => {
    expect(() => loadPackageMeta(distDir)).toThrow(/Could not locate package\.json/);
  });

  it('includes the baseDir in the thrown error message for diagnosability', () => {
    expect(() => loadPackageMeta(distDir)).toThrow(new RegExp(distDir.replace(/\./g, '\\.')));
  });
});

describe('isInside — segment-level containment', () => {
  it('treats parent equal to child as contained', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });

  it('treats a strict descendant as contained', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('rejects a path above the parent', () => {
    expect(isInside('/a/b', '/a')).toBe(false);
  });

  // Acceptance criterion: sibling-name bypass must be rejected. A raw
  // String.prototype.startsWith('/a/b') would accept '/a/b-extra'.
  it('rejects a sibling whose name shares a prefix with the parent', () => {
    expect(isInside('/a/b', '/a/b-extra')).toBe(false);
    expect(isInside('/Users/me/src/github/my-app', '/Users/me/src/github/my-app-evil')).toBe(false);
  });

  it('rejects a fully disjoint path', () => {
    expect(isInside('/a/b', '/c/d')).toBe(false);
  });
});

describe('parseAllowedDirs — startup resolution', () => {
  it('defaults to a single "." entry when env is unset', () => {
    expect(parseAllowedDirs(undefined, '/home/alice/proj')).toEqual(['/home/alice/proj']);
  });

  it('defaults to a single "." entry when env is the empty string', () => {
    expect(parseAllowedDirs('', '/home/alice/proj')).toEqual(['/home/alice/proj']);
  });

  // Acceptance criterion: relative entries resolve against launchCwd so a
  // committed .mcp.json works across contributors without baking absolute paths.
  it('resolves relative entries against launchCwd — contributor A', () => {
    expect(parseAllowedDirs('..', '/Users/alice/code/my-app')).toEqual(['/Users/alice/code']);
  });

  it('resolves relative entries against launchCwd — contributor B', () => {
    expect(parseAllowedDirs('..', '/home/bob/src/my-app')).toEqual(['/home/bob/src']);
  });

  it('preserves absolute entries verbatim', () => {
    expect(parseAllowedDirs('/etc', '/home/alice/proj')).toEqual(['/etc']);
  });

  it('splits multiple entries on path.delimiter', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(parseAllowedDirs(`.${sep}..`, '/home/alice/proj')).toEqual([
      '/home/alice/proj',
      '/home/alice',
    ]);
  });
});

describe('workingDirectory — allowlist gate', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('rejects workingDirectory outside the allowlist without spawning', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: '/etc' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // Acceptance criterion: sibling-name bypass at the tool boundary.
  // The allowlist is the repo root; '<repo-root>-evil' shares a prefix but is
  // a sibling, so it must be rejected exactly like a disjoint path.
  it('rejects sibling-name bypass at the tool boundary', async () => {
    const sibling = ALLOWED_DIRS[0] + '-evil';
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: sibling },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('passes a workingDirectory under the allowlist as the spawn cwd', async () => {
    await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures' },
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    expect(options.cwd.endsWith('test/fixtures')).toBe(true);
  });

  it('omitting workingDirectory defaults to launchCwd — spawn cwd matches ALLOWED_DIRS[0]', async () => {
    await client.callTool({ name: 'run_tests', arguments: {} });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    expect(options.cwd).toBe(ALLOWED_DIRS[0]);
  });

  it('gates list_tests on the allowlist', async () => {
    const result = await client.callTool({
      name: 'list_tests',
      arguments: { workingDirectory: '/etc' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('gates get_failed_tests on the allowlist', async () => {
    const result = await client.callTool({
      name: 'get_failed_tests',
      arguments: { workingDirectory: '/etc' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_DIRS');
  });

  it('gates get_test_attachment on the allowlist', async () => {
    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: {
        workingDirectory: '/etc',
        testTitle: 'login fails with wrong password',
        attachmentName: 'diagnosis',
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_DIRS');
  });
});

describe('get_test_attachment — path-traversal defense', () => {
  afterEach(() => writeDefaultReport());

  // Acceptance criterion: attachment paths that escape workingDirectory must
  // be rejected even if results.json records them. Craft a results.json whose
  // attachment.path contains `..` components that escape the working dir.
  it('rejects an attachment whose recorded path escapes workingDirectory via ..', async () => {
    const escapingPath = join(resultsDir, '..', '..', '..', 'etc', 'passwd');
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'traversal test',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                {
                  projectName: 'Chromium',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 10,
                      attachments: [
                        { name: 'diag', contentType: 'text/plain', path: escapingPath },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });

    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: {
        workingDirectory: 'test/fixtures',
        testTitle: 'traversal test',
        attachmentName: 'diag',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('escapes workingDirectory');
  });

  it('rejects an absolute attachment path outside workingDirectory', async () => {
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'absolute test',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                {
                  projectName: 'Chromium',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 10,
                      attachments: [
                        { name: 'diag', contentType: 'text/plain', path: '/etc/passwd' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });

    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: {
        workingDirectory: 'test/fixtures',
        testTitle: 'absolute test',
        attachmentName: 'diag',
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('escapes workingDirectory');
  });
});

describe('workingDirectory — existence check (AC9)', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  // Acceptance criterion: a nonexistent workingDirectory that would otherwise
  // pass the allowlist must be rejected with a specific error. Without the
  // existence check, Playwright spawns against a missing cwd and ENOENT
  // surfaces as a generic "Failed to spawn" — the silent fall-through the
  // issue explicitly forbids.
  it('rejects a nonexistent workingDirectory with a dedicated error and no spawn', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures/does-not-exist-xyzzy' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('does not exist');
    expect(text).not.toContain('Failed to spawn');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a workingDirectory that exists but is a file, not a directory', async () => {
    // The fixture results.json file exists under the allowlist; pointing at it
    // as a "directory" must be rejected with a file-vs-dir specific error.
    const filePath = fileURLToPath(
      new URL('./fixtures/test-results/results.json', import.meta.url)
    );
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: filePath },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('not a directory');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('workingDirectory — positive acceptance on the other three tools (AC5)', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  // AC5 says the parameter is accepted by list_tests, get_failed_tests, and
  // get_test_attachment with the same allowlist check. Negative paths are
  // covered above; these are the positive counterparts.

  it('list_tests accepts a workingDirectory under the allowlist and uses it as spawn cwd', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ stdout: '{"suites":[]}' }));
    const data = parseResult(
      await client.callTool({
        name: 'list_tests',
        arguments: { workingDirectory: 'test/fixtures' },
      })
    );
    expect(data).toEqual({ count: 0, tests: [] });
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    expect(options.cwd.endsWith('test/fixtures')).toBe(true);
  });

  it('get_failed_tests accepts a workingDirectory under the allowlist and returns the report', async () => {
    const data = parseResult(
      await client.callTool({
        name: 'get_failed_tests',
        arguments: { workingDirectory: 'test/fixtures' },
      })
    );
    expect(data.failedCount).toBe(1);
    expect(data.tests[0].title).toBe('login fails with wrong password');
  });

  it('get_test_attachment accepts a workingDirectory under the allowlist and returns content', async () => {
    const data = parseResult(
      await client.callTool({
        name: 'get_test_attachment',
        arguments: {
          workingDirectory: 'test/fixtures',
          testTitle: 'login fails with wrong password',
          attachmentName: 'diagnosis',
        },
      })
    );
    expect(data.content).toContain('Button selector');
  });
});

describe('formatStartupBanner — AC7 startup log', () => {
  // Acceptance criterion: when PW_ALLOWED_DIRS is unset, the server surfaces
  // "default — authorizing only launchCwd" so operators know what is allowed.
  it('annotates the default case when PW_ALLOWED_DIRS is unset', () => {
    const banner = formatStartupBanner('/some/launch/dir', ['/some/launch/dir'], undefined);
    expect(banner).toContain('launchCwd=/some/launch/dir');
    expect(banner).toContain('PW_ALLOWED_DIRS=/some/launch/dir');
    expect(banner).toContain('default — authorizing only launchCwd');
  });

  it('annotates the default case when PW_ALLOWED_DIRS is the empty string', () => {
    const banner = formatStartupBanner('/x', ['/x'], '');
    expect(banner).toContain('default — authorizing only launchCwd');
  });

  it('omits the default annotation when the env var is set', () => {
    const banner = formatStartupBanner('/x', ['/x', '/y'], '..');
    expect(banner).toContain('PW_ALLOWED_DIRS=/x, /y');
    expect(banner).not.toContain('default — authorizing only launchCwd');
  });

  it('terminates with a newline so it does not run into subsequent log lines', () => {
    const banner = formatStartupBanner('/x', ['/x'], undefined);
    expect(banner.endsWith('\n')).toBe(true);
  });
});

// Symlink-based allowlist/attachment bypasses are the highest-severity risk
// flagged in this PR's security review. These regressions exercise the
// `realpathSync` canonicalization that closes the lexical-only containment
// hole. Symlink creation needs elevated privileges on Windows, so each test
// self-skips via `trySymlink` when creation fails.

function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

describe('workingDirectory — symlink-based allowlist bypass (security)', () => {
  const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
  const symlinkPath = join(fixtures, 'symlink-escape');
  let escapeTarget: string;

  beforeAll(() => {
    escapeTarget = mkdtempSync(join(tmpdir(), 'pw-report-mcp-symlink-target-'));
  });

  afterAll(() => {
    rmSync(escapeTarget, { recursive: true, force: true });
    try {
      unlinkSync(symlinkPath);
    } catch {
      // absent or already cleaned
    }
  });

  beforeEach(() => spawnSyncMock.mockClear());
  afterEach(() => {
    try {
      unlinkSync(symlinkPath);
    } catch {
      // absent
    }
  });

  // Lexical isInside() passes because the symlink's path is literally under
  // the allowlist (repo root). Without realpathSync canonicalization, spawnSync
  // would chdir to the target and Playwright would load a malicious
  // playwright.config.ts from there. The fix is to reject such paths.
  it('rejects a workingDirectory that is a symlink escaping the allowlist', async () => {
    if (!trySymlink(escapeTarget, symlinkPath)) {
      console.warn('[test] symlinkSync unavailable — skipping');
      return;
    }
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures/symlink-escape' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('resolves via symlink');
    expect(text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // A symlink whose target is still inside the allowlist (e.g. a convenience
  // link within the same project) must continue to work.
  it('accepts a symlink whose target is inside the allowlist', async () => {
    const innerTarget = join(fixtures);
    if (!trySymlink(innerTarget, symlinkPath)) {
      console.warn('[test] symlinkSync unavailable — skipping');
      return;
    }
    await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures/symlink-escape' },
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    // cwd is canonicalized — matches the target, not the symlink path.
    expect(options.cwd).toBe(innerTarget);
  });
});

describe('get_test_attachment — symlink-based exfiltration (security)', () => {
  const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
  const attachmentSymlinkPath = join(fixtures, 'test-results', 'sneaky.txt');
  let secretPath: string;

  beforeAll(() => {
    // A secret file OUTSIDE the working directory (test/fixtures). Represents
    // anything the MCP process could otherwise read — ~/.ssh/id_rsa, .env, etc.
    const secretDir = mkdtempSync(join(tmpdir(), 'pw-report-mcp-secret-'));
    secretPath = join(secretDir, 'id_rsa');
    writeFileSync(secretPath, '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n');
  });

  afterAll(() => {
    rmSync(secretPath, { force: true });
    rmSync(join(secretPath, '..'), { recursive: true, force: true });
  });

  afterEach(() => {
    writeDefaultReport();
    try {
      unlinkSync(attachmentSymlinkPath);
    } catch {
      // absent
    }
  });

  // The attacker-controlled results.json declares a text attachment whose
  // path is a symlink pointing at a secret file outside the working dir.
  // Without canonicalizing the attachment path before readFileSync, the
  // server would follow the symlink and return the secret contents.
  it('rejects an attachment whose path is a symlink escaping workingDirectory', async () => {
    if (!trySymlink(secretPath, attachmentSymlinkPath)) {
      console.warn('[test] symlinkSync unavailable — skipping');
      return;
    }
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'symlink test',
              file: 'tests/x.spec.ts',
              line: 1,
              ok: false,
              tests: [
                {
                  projectName: 'Chromium',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 10,
                      attachments: [
                        {
                          name: 'diag',
                          contentType: 'text/plain',
                          path: attachmentSymlinkPath,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
    });

    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: {
        workingDirectory: 'test/fixtures',
        testTitle: 'symlink test',
        attachmentName: 'diag',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('resolves via symlink');
    expect(text).toContain('escapes workingDirectory');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
  });
});
