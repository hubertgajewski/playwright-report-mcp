import { buildListTestsCmd, parseListJson } from '../src/results.js';
import {
  client,
  parseListTestsResult,
  setupMcpClient,
  spawnSyncMock,
  spawnSyncResult,
} from './helpers/mcp.js';
import type { TextContent } from './helpers/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';

setupMcpClient();

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

  it('throws when JSON has an unexpected reporter shape', () => {
    const malformed = JSON.stringify({
      suites: [
        {
          file: 'tests/x.spec.ts',
          specs: [{ title: 'missing line', tags: ['smoke'] }],
        },
      ],
    });
    expect(() => parseListJson(malformed)).toThrow();
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

    const data = parseListTestsResult(await client.callTool({ name: 'list_tests', arguments: {} }));
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
    const data = parseListTestsResult(await client.callTool({ name: 'list_tests', arguments: {} }));
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
