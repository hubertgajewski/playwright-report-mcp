import { Client } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  cleanupSpawnState,
  client,
  connectMcpClient,
  createSpawnControl,
  mockNextSpawn,
  parseTrackedRunStatusResult,
  resetSpawnState,
  resultsFile,
  setupMcpClient,
  spawnMock,
  spawnSyncMock,
} from './helpers/mcp.js';
import type { TextContent } from './helpers/mcp.js';

setupMcpClient();

function spawnEnv(callIndex = 0): NodeJS.ProcessEnv | undefined {
  return (spawnSyncMock.mock.calls[callIndex]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
}

describe('run_tests / list_tests — env overrides disabled by default', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('rejects env on run_tests and does not spawn when PW_ALLOWED_ENV is unset', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { env: { ENV: 'staging' } },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_ENV');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects env on list_tests and does not spawn when PW_ALLOWED_ENV is unset', async () => {
    const result = await client.callTool({
      name: 'list_tests',
      arguments: { env: { ENV: 'staging' } },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_ENV');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('run_tests / list_tests — operator-allowlisted env', () => {
  let allowedClient: Client;

  beforeAll(async () => {
    allowedClient = await connectMcpClient(
      loadConfig({
        ...process.env,
        PW_RESULTS_FILE: resultsFile,
        PW_ALLOWED_ENV: 'ENV,TEST_ENV,BASE_URL',
      })
    );
  });

  afterAll(async () => {
    await allowedClient.close();
  });

  beforeEach(() => spawnSyncMock.mockClear());

  it('merges ENV=staging into the run_tests spawnSync environment', async () => {
    const result = await allowedClient.callTool({
      name: 'run_tests',
      arguments: { env: { ENV: 'staging' } },
    });
    expect(result.isError).toBeFalsy();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const env = spawnEnv();
    expect(env?.ENV).toBe('staging');
    expect(env?.PATH).toBe(process.env.PATH);
  });

  it('merges the same overrides into list_tests spawnSync', async () => {
    spawnSyncMock.mockReturnValueOnce({
      pid: 1234,
      output: [null, '{"suites":[]}', ''],
      stdout: '{"suites":[]}',
      stderr: '',
      status: 0,
      signal: null,
    });
    const result = await allowedClient.callTool({
      name: 'list_tests',
      arguments: { env: { ENV: 'staging' } },
    });
    expect(result.isError).toBeFalsy();
    expect(spawnEnv()?.ENV).toBe('staging');
  });

  it('accepts TEST_ENV and BASE_URL when those keys are allowlisted', async () => {
    const result = await allowedClient.callTool({
      name: 'run_tests',
      arguments: {
        env: { TEST_ENV: 'qa', BASE_URL: 'https://stage.example.com' },
      },
    });
    expect(result.isError).toBeFalsy();
    const env = spawnEnv();
    expect(env?.TEST_ENV).toBe('qa');
    expect(env?.BASE_URL).toBe('https://stage.example.com');
  });

  it('rejects a key that is not listed in PW_ALLOWED_ENV without spawning', async () => {
    const result = await allowedClient.callTool({
      name: 'run_tests',
      arguments: { env: { OTHER: 'x' } },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_ENV');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  for (const key of ['NODE_OPTIONS', 'node_options', 'PATH', 'BASIC_AUTH_PASSWORD'] as const) {
    it(`rejects ${key} without spawning even if the operator listed other keys`, async () => {
      const result = await allowedClient.callTool({
        name: 'run_tests',
        arguments: { env: { [key]: 'x' } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent[])[0].text).toContain(key);
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  }

  it('rejects ENV=/tmp/evil.sh without spawning', async () => {
    const result = await allowedClient.callTool({
      name: 'run_tests',
      arguments: { env: { ENV: '/tmp/evil.sh' } },
    });
    expect(result.isError).toBe(true);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('run_tests wait=false — env merge and status redaction', () => {
  let allowedClient: Client;

  beforeAll(async () => {
    allowedClient = await connectMcpClient(
      loadConfig({
        ...process.env,
        PW_RESULTS_FILE: resultsFile,
        PW_ALLOWED_ENV: 'ENV',
      })
    );
  });

  afterAll(async () => {
    await allowedClient.close();
  });

  beforeEach(() => {
    resetSpawnState();
  });

  afterEach(() => {
    cleanupSpawnState();
  });

  it('passes the merged env to tracked spawn and omits override values from get_run_status', async () => {
    mockNextSpawn(createSpawnControl());
    const started = parseTrackedRunStatusResult(
      await allowedClient.callTool({
        name: 'run_tests',
        arguments: { wait: false, env: { ENV: 'staging' } },
      })
    );

    const spawnOptions = spawnMock.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    expect(spawnOptions.env?.ENV).toBe('staging');

    expect(started.command).toEqual({
      executable: started.command.executable,
      args: started.command.args,
      cwd: started.command.cwd,
    });
    expect(started.command).not.toHaveProperty('env');
    expect(started.envKeys).toEqual(['ENV']);
    expect(JSON.stringify(started)).not.toContain('staging');

    const status = parseTrackedRunStatusResult(
      await allowedClient.callTool({
        name: 'get_run_status',
        arguments: { runId: started.runId },
      })
    );
    expect(status.command).toEqual(started.command);
    expect(status).not.toHaveProperty('env');
    expect(JSON.stringify(status)).not.toContain('staging');
  });
});
