import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import pkg from '../package.json' with { type: 'json' };
import { stats, suites } from './fixtures/data.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
});

import { spawnSync } from 'child_process';
import { buildListTestsCmd, loadPackageMeta, parseListJson, server } from '../index.js';

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;

const resultsDir = fileURLToPath(new URL('./fixtures/test-results', import.meta.url));
const resultsFile = join(resultsDir, 'results.json');

function writeDefaultReport() {
  writeFileSync(resultsFile, JSON.stringify({ suites, stats }, null, 2));
}

function writeCustomReport(report: unknown) {
  writeFileSync(resultsFile, JSON.stringify(report));
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
  it('rejects spec paths outside the project directory', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { spec: '../../etc/passwd' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('within the project directory');
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
    spawnSyncMock.mockReturnValueOnce({
      status: null,
      signal: 'SIGTERM',
      error: timeoutError,
      stdout: '',
      stderr: '',
    });
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
    spawnSyncMock.mockReturnValueOnce({
      status: null,
      signal: 'SIGTERM',
      error: timeoutError,
      stdout: '',
      stderr: '',
    });
    const result = await client.callTool({ name: 'run_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('exceeded the 300000ms timeout');
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
    spawnSyncMock.mockReturnValueOnce({
      error: new Error('ENOENT'),
      stdout: '',
      stderr: '',
    });
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
    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'reporter failed to write output',
    });
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
});

describe('run_tests — edge cases in spawn result', () => {
  afterEach(() => writeDefaultReport());

  it('reports exitCode -1 when spawn result has no status field', async () => {
    spawnSyncMock.mockReturnValueOnce({ stdout: '', stderr: '' });
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
    spawnSyncMock.mockReturnValueOnce({ status: 1 });
    const result = await client.callTool({ name: 'run_tests', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toMatch(/stderr:\s*$/);
  });
});

describe('get_failed_tests — edge cases', () => {
  afterEach(() => writeDefaultReport());

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
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: reporterJson, stderr: '' });

    const data = parseResult(await client.callTool({ name: 'list_tests', arguments: {} }));
    expect(data.count).toBe(1);
    expect(data.tests[0]).toEqual({
      title: 'home loads',
      file: 'tests/nav.spec.ts',
      tags: ['@smoke'],
    });
  });

  it('passes --grep to Playwright when a tag filter is provided', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: '{"suites":[]}', stderr: '' });
    await client.callTool({ name: 'list_tests', arguments: { tag: '@smoke' } });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain('--grep');
    expect(args).toContain('@smoke');
  });

  it('returns error when Playwright cannot be spawned', async () => {
    spawnSyncMock.mockReturnValueOnce({ error: new Error('ENOENT'), stdout: '', stderr: '' });
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('Failed to spawn Playwright');
  });

  it('surfaces an explicit error when spawnSync times out under the 30s list_tests cap', async () => {
    const timeoutError = Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncMock.mockReturnValueOnce({
      status: null,
      signal: 'SIGTERM',
      error: timeoutError,
      stdout: '',
      stderr: '',
    });
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('exceeded the 30000ms timeout');
    expect(text).not.toContain('Failed to spawn');
  });

  it('returns error when --list output cannot be parsed as JSON', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: 'no json here',
      stderr: 'some warning',
    });
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('Failed to parse');
    expect(text).toContain('some warning');
  });

  it('tolerates spawn result with missing stdout/stderr fields', async () => {
    spawnSyncMock.mockReturnValueOnce({});
    const result = await client.callTool({ name: 'list_tests', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('Failed to parse');
    expect(text).toMatch(/stderr:\s*$/);
  });

  it('returns zero tests when the reporter JSON has no suites field', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' });
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
