import {
  ACTIVE_RUN_LIMIT_UNDER_TEST,
  KILL_ESCALATION_MS_UNDER_TEST,
  TRACKED_RUN_LIMIT_UNDER_TEST,
  cleanupSpawnState,
  client,
  createSpawnControl,
  deleteReport,
  markReportUpdatedAfter,
  markReportUpdatedBefore,
  mockNextSpawn,
  mockProcessGroupSignalFailure,
  mockProcessGroupSignalSuccess,
  parseRunStatusResult,
  parseTrackedRunStatusResult,
  resetSpawnState,
  setupMcpClient,
  spawnMock,
  stats,
  suites,
  waitForRunEvents,
  writeCustomReport,
  writeDefaultReport,
} from './helpers/mcp.js';
import type { TextContent } from './helpers/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

setupMcpClient();

describe('run_tests — non-blocking status polling', () => {
  beforeEach(() => {
    resetSpawnState();
  });

  afterEach(() => {
    cleanupSpawnState();
  });

  it('starts a run without waiting and returns a stable runId', async () => {
    const run = mockNextSpawn(createSpawnControl());

    const data = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    expect(data.runId).toMatch(/^run-/);
    expect(data.state).toBe('running');
    expect(data.pid).toBe(4321);
    expect(data.progress).toEqual({ current: null, total: null });
    expect(data).not.toHaveProperty('stdoutTail');
    expect(data).not.toHaveProperty('stderrTail');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(run.child.kill).not.toHaveBeenCalled();
  });

  it('reports the status of an active run with command metadata and results.json state', async () => {
    writeDefaultReport();
    mockNextSpawn(createSpawnControl(9876));
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, tag: '@smoke' } })
    );
    markReportUpdatedBefore(started.startedAt);

    const status = parseTrackedRunStatusResult(
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
    expect(status.progress).toEqual({ current: null, total: null });
    expect(status).not.toHaveProperty('stdoutTail');
    expect(status).not.toHaveProperty('stderrTail');
    expect(status.elapsedMs).toEqual(expect.any(Number));
  });

  it('reports compact numeric progress parsed from Playwright stdout', async () => {
    const run = mockNextSpawn(createSpawnControl(1357));
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    run.child.stdout.write('Running 662 tests using 4 workers\n');
    run.child.stdout.write('[12/662] [Chromium] › tests/navigation.spec.ts:13:3 › / title\n');
    run.child.stdout.write('[528/662] [Firefox] › tests/forms.spec.ts:9:1 › form works\n');
    run.child.stderr.write('warning that should not be retained');

    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status.progress).toEqual({ current: 528, total: 662 });
    expect(status).not.toHaveProperty('stdoutTail');
    expect(status).not.toHaveProperty('stderrTail');
    expect(JSON.stringify(status)).not.toContain('warning that should not be retained');
  });

  it('parses progress markers split across stdout chunks', async () => {
    const run = mockNextSpawn(createSpawnControl(1357));
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    run.child.stdout.write('Running 662 tests using 4 workers\n[52');
    run.child.stdout.write('8/662] [Firefox] › tests/forms.spec.ts:9:1 › form works\n');

    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status.progress).toEqual({ current: 528, total: 662 });
    expect(JSON.stringify(status)).not.toContain('Running 662 tests');
  });

  it('reports live stats for a running run after results.json is updated', async () => {
    const liveStats = { expected: 3, unexpected: 1, skipped: 0, duration: 321 };
    mockNextSpawn(createSpawnControl(1357));
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    writeCustomReport({ suites, stats: liveStats });
    markReportUpdatedAfter(started.startedAt);

    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status.state).toBe('running');
    expect(status.resultsFile.updatedAfterStart).toBe(true);
    expect(status.stats).toEqual(liveStats);
  });

  it('caches live stats while the results.json mtime is unchanged', async () => {
    const liveStats = { expected: 3, unexpected: 1, skipped: 0, duration: 321 };
    mockNextSpawn(createSpawnControl(1357));
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    writeCustomReport({ suites, stats: liveStats });
    markReportUpdatedAfter(started.startedAt);
    const firstStatus = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    writeCustomReport({ suites: [], stats: { expected: 0 } });
    markReportUpdatedAfter(started.startedAt);
    const secondStatus = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(firstStatus.stats).toEqual(liveStats);
    expect(secondStatus.stats).toEqual(liveStats);
  });

  it('uses the latest tracked run for the working directory when runId is omitted', async () => {
    mockNextSpawn(createSpawnControl(2468));
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: {} })
    );

    expect(status.runId).toBe(started.runId);
    expect(status.state).toBe('running');
    expect(status.pid).toBe(2468);
  });

  it('uses insertion order to select the latest run when two runs start in the same millisecond', async () => {
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const first = mockNextSpawn(createSpawnControl(1111));
      const firstStarted = parseTrackedRunStatusResult(
        await client.callTool({ name: 'run_tests', arguments: { wait: false } })
      );
      first.finish({ code: 0 });

      mockNextSpawn(createSpawnControl(2222));
      const secondStarted = parseTrackedRunStatusResult(
        await client.callTool({ name: 'run_tests', arguments: { wait: false } })
      );

      const status = parseTrackedRunStatusResult(
        await client.callTool({ name: 'get_run_status', arguments: {} })
      );

      expect(firstStarted.runId).not.toBe(secondStarted.runId);
      expect(status.runId).toBe(secondStarted.runId);
      expect(status.pid).toBe(2222);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('returns idle status when runId is omitted and no run is tracked for the working directory', async () => {
    const status = parseRunStatusResult(
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

  it('reports terminal failed status with compact progress and parsed stats', async () => {
    const run = mockNextSpawn(createSpawnControl());
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    writeDefaultReport();
    markReportUpdatedAfter(started.startedAt);
    run.finish({ code: 1, stderr: 'one test failed' });
    await waitForRunEvents();

    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status).toMatchObject({
      runId: started.runId,
      state: 'failed',
      exitCode: 1,
      signal: null,
      stats,
      progress: { current: 2, total: 2 },
    });
    expect(status).not.toHaveProperty('stdoutTail');
    expect(status).not.toHaveProperty('stderrTail');
    expect(JSON.stringify(status)).not.toContain('one test failed');
    expect(status.completedAt).toEqual(expect.any(String));
  });

  it('includes flaky tests when deriving terminal progress from stats', async () => {
    const flakyStats = { expected: 1, unexpected: 0, flaky: 1, skipped: 1, duration: 4000 };
    const run = mockNextSpawn(createSpawnControl());
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    writeCustomReport({ suites, stats: flakyStats });
    markReportUpdatedAfter(started.startedAt);
    run.finish({ code: 0 });
    await waitForRunEvents();

    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status.stats).toEqual(flakyStats);
    expect(status.progress).toEqual({ current: 3, total: 3 });
  });

  it('keeps report stats isolated to the run that produced them', async () => {
    const firstStats = { expected: 11, unexpected: 0, skipped: 0, duration: 110 };
    const secondStats = { expected: 22, unexpected: 1, skipped: 0, duration: 220 };

    const first = mockNextSpawn(createSpawnControl(1111));
    const firstStarted = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );
    writeCustomReport({ suites, stats: firstStats });
    markReportUpdatedAfter(firstStarted.startedAt);
    first.finish({ code: 0 });
    await waitForRunEvents();

    const second = mockNextSpawn(createSpawnControl(2222));
    const secondStarted = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );
    writeCustomReport({ suites, stats: secondStats });
    markReportUpdatedAfter(secondStarted.startedAt);
    second.finish({ code: 0 });
    await waitForRunEvents();

    const firstStatus = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: firstStarted.runId } })
    );
    const secondStatus = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: secondStarted.runId } })
    );

    expect(firstStatus.stats).toEqual(firstStats);
    expect(secondStatus.stats).toEqual(secondStats);
  });

  it('reports timeout status after killing a long-running process', async () => {
    vi.useFakeTimers();
    mockProcessGroupSignalFailure();
    const run = mockNextSpawn(createSpawnControl());
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );

    await vi.advanceTimersByTimeAsync(1);

    const status = parseTrackedRunStatusResult(
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
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(run.child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(KILL_ESCALATION_MS_UNDER_TEST);

    const status = parseTrackedRunStatusResult(
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
    const closedStatus = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(closedStatus.state).toBe('timedOut');
    expect(closedStatus.completedAt).toEqual(expect.any(String));
  });

  it('preserves timeout status when the child emits an error after timeout', async () => {
    vi.useFakeTimers();
    mockProcessGroupSignalFailure();
    const run = mockNextSpawn(createSpawnControl({ closeOnKill: false }));
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false, timeout: 1 } })
    );

    await vi.advanceTimersByTimeAsync(1);
    run.fail(new Error('post-timeout process error'));

    const status = parseTrackedRunStatusResult(
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
    const started = parseTrackedRunStatusResult(
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
    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status.state).toBe('timedOut');
    expect(status.signal).toBe('SIGTERM');

    await vi.advanceTimersByTimeAsync(KILL_ESCALATION_MS_UNDER_TEST);
    if (process.platform === 'win32') {
      expect(run.child.kill).not.toHaveBeenCalledWith('SIGKILL');
    } else {
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
    }
  });

  it('reports spawn failure status', async () => {
    deleteReport();
    const run = mockNextSpawn(createSpawnControl());
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    run.fail(new Error('ENOENT'));
    await waitForRunEvents();

    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );
    expect(status.state).toBe('failed');
    expect(status.error).toContain('Failed to spawn Playwright');
    expect(status.error).toContain('ENOENT');
    expect(status.progress).toEqual({ current: null, total: null });
    expect(status).not.toHaveProperty('stdoutTail');
    expect(status).not.toHaveProperty('stderrTail');
  });

  it('reports synchronous spawn exceptions as failed tracked runs', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn threw');
    });

    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );
    const status = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: started.runId } })
    );

    expect(status.state).toBe('failed');
    expect(status.error).toContain('spawn threw');
  });

  it('reports a completed run with missing results.json without reading stale data', async () => {
    deleteReport();
    const run = mockNextSpawn(createSpawnControl());
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    run.finish({ code: 0 });
    await waitForRunEvents();

    const status = parseTrackedRunStatusResult(
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
    const started = parseTrackedRunStatusResult(
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
    const started = parseTrackedRunStatusResult(
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
      parseTrackedRunStatusResult(
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
    const started = parseTrackedRunStatusResult(
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
    const started = parseTrackedRunStatusResult(
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
    const started = parseTrackedRunStatusResult(
      await client.callTool({ name: 'run_tests', arguments: { wait: false } })
    );

    const status = parseTrackedRunStatusResult(
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
      const started = parseTrackedRunStatusResult(
        await client.callTool({ name: 'run_tests', arguments: { wait: false } })
      );
      if (i === 0) firstRunId = started.runId;
      lastRunId = started.runId;
      run.finish({ code: 0 });
      await waitForRunEvents();
    }

    const result = await client.callTool({
      name: 'get_run_status',
      arguments: { runId: firstRunId },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('Unknown runId');

    const retained = parseTrackedRunStatusResult(
      await client.callTool({ name: 'get_run_status', arguments: { runId: lastRunId } })
    );
    expect(retained.runId).toBe(lastRunId);
    expect(retained.state).toBe('completed');
  });
});
