import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ALLOWED_DIRS,
  client,
  deleteReport,
  parseRunTestsResult,
  resultsDir,
  setupMcpClient,
  spawnSyncMock,
  spawnSyncResult,
  stats,
  trySymlink,
  writeCustomReport,
  writeDefaultReport,
} from './helpers/mcp.js';
import type { TextContent } from './helpers/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

setupMcpClient();

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

  it('rejects a missing in-project spec path without spawning Playwright', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: 'test/fixtures/pw-project/tests/does-not-exist.spec.ts' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('spec path was not found');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('accepts an absolute spec path that resolves inside the working directory', async () => {
    // Positive counterpart to the `..` rejection test: `resolve(wd, absPath)` returns
    // absPath unchanged, so the validation must still accept it when it falls within wd.
    const absInside = join(
      ALLOWED_DIRS[0],
      'test',
      'fixtures',
      'pw-project',
      'tests',
      'homepage.spec.ts'
    );
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: absInside },
    });
    expect(result.isError).toBeFalsy();
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain(absInside);
  });

  it('accepts Playwright line and column filters on a validated spec file', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: 'test/fixtures/pw-project/tests/homepage.spec.ts:3:1' },
    });

    expect(result.isError).toBeFalsy();
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(
      args.some((a) => a.endsWith('test/fixtures/pw-project/tests/homepage.spec.ts:3:1'))
    ).toBe(true);
  });

  it('rejects a missing in-project spec path with a line filter without spawning Playwright', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: 'test/fixtures/pw-project/tests/does-not-exist.spec.ts:3' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('spec path was not found');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects an existing directory passed as a spec without spawning Playwright', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: 'test/fixtures/pw-project/tests' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('spec path must point to a file');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a spec path whose symlink target escapes the project directory', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'pw-report-mcp-spec-target-'));
    const outsideSpec = join(outsideDir, 'outside.spec.ts');
    const symlinkSpec = join(resultsDir, 'outside-link.spec.ts');
    writeFileSync(outsideSpec, "import { test } from '@playwright/test';\ntest('x', () => {});\n");

    if (!trySymlink(outsideSpec, symlinkSpec)) {
      rmSync(outsideDir, { recursive: true, force: true });
      console.warn('[test] symlinkSync unavailable — skipping');
      return;
    }

    try {
      const result = await client.callTool({
        name: 'run_tests',
        arguments: { spec: symlinkSpec },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as TextContent[])[0].text;
      expect(text).toContain('resolves via symlink');
      expect(text).toContain('escapes workingDirectory');
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      unlinkSync(symlinkSpec);
      rmSync(outsideDir, { recursive: true, force: true });
    }
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
    const data = parseRunTestsResult(await client.callTool({ name: 'run_tests', arguments: {} }));
    expect(data.stats).toEqual(stats);
    expect(data.tests).toHaveLength(2);
    const byTitle = Object.fromEntries(data.tests.map((t) => [t.title, t]));
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

describe('run_tests — command construction', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('passes spec, browser, and tag through to the Playwright command', async () => {
    await client.callTool({
      name: 'run_tests',
      arguments: {
        spec: 'test/fixtures/pw-project/tests/homepage.spec.ts',
        browser: 'Chromium',
        tag: '@smoke',
      },
    });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain('--project');
    expect(args).toContain('Chromium');
    expect(args).toContain('--grep');
    expect(args).toContain('@smoke');
    expect(args.some((a) => a.endsWith('test/fixtures/pw-project/tests/homepage.spec.ts'))).toBe(
      true
    );
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
    const data = parseRunTestsResult(await client.callTool({ name: 'run_tests', arguments: {} }));
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
    const data = parseRunTestsResult(await client.callTool({ name: 'run_tests', arguments: {} }));
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

  it('rejects malformed reporter JSON instead of summarizing unchecked data', async () => {
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'missing ok flag',
              file: 'tests/x.spec.ts',
              line: 1,
              tests: [{ projectName: 'Chromium', status: 'expected', results: [] }],
            },
          ],
        },
      ],
      stats: { expected: 1, unexpected: 0, skipped: 0, duration: 0 },
    });

    const result = await client.callTool({ name: 'run_tests', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('results.json was invalid');
  });
});
