import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
});

import { spawnSync } from 'child_process';
import { buildListTestsCmd, parseListJson, server } from '../index.js';

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;

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

  it('defaults to 300 seconds when timeout is omitted', async () => {
    await client.callTool({ name: 'run_tests', arguments: {} });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0][2]).toMatchObject({ timeout: 300_000 });
  });

  it('passes the custom timeout to spawnSync in milliseconds', async () => {
    await client.callTool({ name: 'run_tests', arguments: { timeout: 60 } });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0][2]).toMatchObject({ timeout: 60_000 });
  });

  it('rejects non-positive timeout values', async () => {
    const result = await client.callTool({ name: 'run_tests', arguments: { timeout: 0 } });
    expect(result.isError).toBe(true);
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
    expect(tests).toEqual([
      { title: 'menu opens', file: 'tests/nav.spec.ts', tags: ['@smoke'] },
    ]);
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
    expect(buildListTestsCmd()).toEqual([
      'npx',
      'playwright',
      'test',
      '--list',
      '--reporter=json',
    ]);
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
