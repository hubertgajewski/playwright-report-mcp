/**
 * End-to-end tests that boot the built dist/index.js as a real subprocess via
 * StdioClientTransport and drive all four MCP tools against a minimal fixture
 * Playwright project at test/fixtures/pw-project/.
 *
 * Skipped automatically (with a console.warn) when the Playwright Chromium
 * browser is not present in the local browser cache.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  ProtocolErrorCode,
  UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import pkg from '../package.json' with { type: 'json' };

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
if (!existsSync(DIST_INDEX)) skipReasons.push('server not built — run: npm run build');
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

const TOOL_NAMES = [
  'get_failed_tests',
  'get_run_status',
  'get_test_attachment',
  'list_tests',
  'run_tests',
];

function serverEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function serverTransport() {
  return new StdioClientTransport({
    command: 'node',
    args: [DIST_INDEX],
    cwd: PW_PROJECT,
    env: serverEnvironment(),
  });
}

describe.skipIf(!existsSync(DIST_INDEX))('MCP stdio protocol negotiation', () => {
  it('selects the modern era in auto mode and exposes working tools', async () => {
    const modernClient = new Client(
      { name: 'modern-e2e-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    );

    try {
      await modernClient.connect(serverTransport());
      expect(modernClient.getProtocolEra()).toBe('modern');

      const tools = await modernClient.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual(TOOL_NAMES);

      const status = await modernClient.callTool({
        name: 'get_run_status',
        arguments: {},
      });
      expect(status.isError).toBeFalsy();
      expect(JSON.parse((status.content as TextContent[])[0].text)).toMatchObject({
        state: 'idle',
        tracking: false,
      });
    } finally {
      await modernClient.close();
    }
  }, 30_000);

  it('keeps the default client on the legacy era with the same tool surface', async () => {
    const legacyClient = new Client({ name: 'legacy-e2e-client', version: '1.0.0' });

    try {
      await legacyClient.connect(serverTransport());
      expect(legacyClient.getProtocolEra()).toBe('legacy');
      const tools = await legacyClient.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual(TOOL_NAMES);
    } finally {
      await legacyClient.close();
    }
  }, 30_000);

  it('rejects a pinned unsupported revision without falling back', async () => {
    const pinnedClient = new Client(
      { name: 'pinned-e2e-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2099-01-01' } } }
    );

    try {
      let rejection: unknown;
      try {
        await pinnedClient.connect(serverTransport());
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(UnsupportedProtocolVersionError);
      expect(rejection).toMatchObject({
        code: ProtocolErrorCode.UnsupportedProtocolVersion,
        data: {
          requested: '2099-01-01',
          supported: expect.arrayContaining(['2026-07-28']),
        },
      });
      expect(pinnedClient.getProtocolEra()).toBeUndefined();
    } finally {
      await pinnedClient.close();
    }
  }, 30_000);
});

let client: Client;

function parseResult(result: Awaited<ReturnType<typeof client.callTool>>) {
  expect(result.isError).toBeFalsy();
  return JSON.parse((result.content as TextContent[])[0].text);
}

describe.skipIf(SKIP)('MCP server e2e — fixture Playwright project', () => {
  beforeAll(async () => {
    // Launch the server with cwd = fixture project so default workingDirectory="." resolves there.
    client = new Client({ name: 'e2e-client', version: '1.0.0' });
    await client.connect(serverTransport());
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  // ── server identity ───────────────────────────────────────────────────────
  // Covers the dist-layout branch of loadPackageMeta (dist/index.js with package.json one level up).
  // The source-layout branch is covered by test/server.test.ts.

  describe('server identity', () => {
    it('advertises name and version from package.json', () => {
      const info = client.getServerVersion();
      expect(info).toMatchObject({ name: pkg.name, version: pkg.version });
    });

    it('uses the legacy protocol era by default', () => {
      expect(client.getProtocolEra()).toBe('legacy');
    });
  });

  // ── list_tests ────────────────────────────────────────────────────────────
  // Uses `npx playwright test --list` — no browser run needed, so runs first.

  describe('list_tests', () => {
    it('returns all tests from the fixture project', async () => {
      const data = parseResult(await client.callTool({ name: 'list_tests', arguments: {} }));
      expect(data.count).toBeGreaterThanOrEqual(3);
      expect(data.tests.map((t: { title: string }) => t.title)).toContain(
        'deliberately fails with attachment'
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
    let runData: Record<string, unknown>;

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
            arguments: { spec: 'tests/homepage.spec.ts', timeout: 120_000 },
          })
        );
        expect(typeof data.exitCode).toBe('number');
        expect(data.stats).toBeDefined();
      }, 60_000);
    });
  });
});
