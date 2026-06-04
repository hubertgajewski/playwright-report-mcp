import {
  client,
  deleteReport,
  parseFailedTestsResult,
  setupMcpClient,
  writeCustomReport,
  writeDefaultReport,
} from './helpers/mcp.js';
import type { TextContent } from './helpers/mcp.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

setupMcpClient();

describe('get_failed_tests', () => {
  let data: ReturnType<typeof parseFailedTestsResult>;

  beforeAll(async () => {
    data = parseFailedTestsResult(
      await client.callTool({ name: 'get_failed_tests', arguments: {} })
    );
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

describe('get_failed_tests — missing report', () => {
  beforeEach(() => deleteReport());
  afterEach(() => writeDefaultReport());

  it('returns error when results.json is missing', async () => {
    const result = await client.callTool({ name: 'get_failed_tests', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('No results.json');
  });
});

describe('get_failed_tests — invalid report', () => {
  afterEach(() => writeDefaultReport());

  it('returns a distinct error when results.json exists but is malformed', async () => {
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

    const result = await client.callTool({ name: 'get_failed_tests', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('Invalid results.json');
    expect(text).not.toContain('No results.json');
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
    const data = parseFailedTestsResult(
      await client.callTool({ name: 'get_failed_tests', arguments: {} })
    );
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
    const data = parseFailedTestsResult(
      await client.callTool({ name: 'get_failed_tests', arguments: {} })
    );
    expect(data.failedCount).toBe(1);
    expect(data.tests[0].failures).toEqual([]);
  });
});
