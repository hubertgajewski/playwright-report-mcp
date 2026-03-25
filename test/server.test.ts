import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server } from '../index.js';

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
