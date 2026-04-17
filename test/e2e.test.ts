/**
 * End-to-end tests that boot the built dist/index.js as a real subprocess via
 * StdioClientTransport and drive all four MCP tools against a minimal fixture
 * Playwright project at test/fixtures/pw-project/.
 *
 * Skipped automatically (with a console.warn) when the Playwright Chromium
 * browser is not present in the local browser cache.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PW_PROJECT = resolve(__dirname, 'fixtures/pw-project');
const DIST_INDEX = resolve(__dirname, '../dist/index.js');

function fixtureInstalled(): boolean {
  return existsSync(join(PW_PROJECT, 'node_modules', '.bin', 'playwright'));
}

function chromiumInstalled(): boolean {
  const cacheDir =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
  try {
    return readdirSync(cacheDir).some((e) => e.startsWith('chromium-'));
  } catch {
    return false;
  }
}

const skipReasons: string[] = [];
if (!fixtureInstalled())
  skipReasons.push('fixture not installed — run: npm ci --prefix test/fixtures/pw-project');
if (!chromiumInstalled())
  skipReasons.push(
    'Chromium not in Playwright cache — run: cd test/fixtures/pw-project && npx playwright install --with-deps chromium'
  );

const SKIP = skipReasons.length > 0;
if (SKIP) {
  console.warn('[e2e] e2e suite skipped:\n' + skipReasons.map((r) => `  • ${r}`).join('\n'));
}

type TextContent = { type: 'text'; text: string };

let client: Client;

function parseResult(result: Awaited<ReturnType<typeof client.callTool>>) {
  expect(result.isError).toBeFalsy();
  return JSON.parse((result.content as TextContent[])[0].text);
}

describe.skipIf(SKIP)('MCP server e2e — fixture Playwright project', () => {
  beforeAll(async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.PW_DIR = PW_PROJECT;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX],
      env,
    });
    client = new Client({ name: 'e2e-client', version: '1.0.0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  // ── list_tests ────────────────────────────────────────────────────────────
  // Uses `npx playwright test --list` — no browser run needed, so runs first.

  describe('list_tests', () => {
    it('returns all tests from the fixture project', async () => {
      const data = parseResult(await client.callTool({ name: 'list_tests', arguments: {} }));
      // fixture has 3 specs: homepage, smoke, failing
      expect(data.count).toBeGreaterThanOrEqual(3);
      expect(data.tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: expect.any(String), file: expect.any(String) }),
        ])
      );
    });

    it('@smoke tag filter reduces the result count', async () => {
      const all = parseResult(await client.callTool({ name: 'list_tests', arguments: {} }));
      const smoke = parseResult(
        await client.callTool({ name: 'list_tests', arguments: { tag: '@smoke' } })
      );
      expect(smoke.count).toBeGreaterThan(0);
      expect(smoke.count).toBeLessThan(all.count);
      expect(smoke.tests.every((t: { tags: string[] }) => t.tags.includes('@smoke'))).toBe(true);
    });
  });

  // ── run_tests / get_failed_tests / get_test_attachment ───────────────────
  // One browser run populates results.json; the read-only tools then verify it.
  // The timeout test comes LAST so it does not overwrite results.json before
  // get_failed_tests and get_test_attachment have had a chance to read it.

  describe('after a full browser test run', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let runData: any;

    beforeAll(async () => {
      runData = parseResult(await client.callTool({ name: 'run_tests', arguments: {} }));
    }, 120_000);

    describe('run_tests', () => {
      it('returns structured stats', () => {
        expect(runData.stats).toMatchObject({
          expected: expect.any(Number),
          unexpected: expect.any(Number),
          skipped: expect.any(Number),
          duration: expect.any(Number),
        });
      });

      it('returns a test list that includes at least one failing spec', () => {
        const failing = (runData.tests as Array<{ ok: boolean }>).filter((t) => !t.ok);
        expect(failing.length).toBeGreaterThan(0);
      });
    });

    describe('get_failed_tests', () => {
      it('surfaces the deliberately failing spec', async () => {
        const data = parseResult(
          await client.callTool({ name: 'get_failed_tests', arguments: {} })
        );
        expect(data.failedCount).toBeGreaterThan(0);
        const failing = (data.tests as Array<{ title: string }>).find((t) =>
          t.title.includes('deliberately fails')
        );
        expect(failing).toBeDefined();
      });
    });

    describe('get_test_attachment', () => {
      it('reads the text file attached to the failing spec', async () => {
        const data = parseResult(
          await client.callTool({
            name: 'get_test_attachment',
            arguments: {
              testTitle: 'deliberately fails with attachment',
              attachmentName: 'error-details',
            },
          })
        );
        expect(data.content).toContain('deliberately fails');
      });
    });

    // Runs AFTER get_failed_tests and get_test_attachment to avoid overwriting
    // results.json while those tools still need to read it.
    describe('run_tests timeout parameter', () => {
      it('accepts the timeout parameter without error', async () => {
        const data = parseResult(
          await client.callTool({
            name: 'run_tests',
            arguments: { spec: 'tests/homepage.spec.ts', timeout: 120 },
          })
        );
        expect(typeof data.exitCode).toBe('number');
        expect(data.stats).toBeDefined();
      }, 60_000);
    });
  });
});
