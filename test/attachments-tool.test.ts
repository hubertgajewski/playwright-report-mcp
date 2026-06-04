import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  client,
  deleteReport,
  parseAttachmentResult,
  resultsDir,
  setupMcpClient,
  trySymlink,
  writeCustomReport,
  writeDefaultReport,
} from './helpers/mcp.js';
import type { TextContent } from './helpers/mcp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

setupMcpClient();

describe('get_test_attachment', () => {
  it('returns attachment content', async () => {
    const data = parseAttachmentResult(
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
    try {
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
    } finally {
      rmSync(binaryPath, { force: true });
    }
  });

  it('rejects attachments larger than MAX_BYTES', async () => {
    const bigPath = join(resultsDir, 'big.txt');
    try {
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
    } finally {
      rmSync(bigPath, { force: true });
    }
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

describe('get_test_attachment — skips entries without result attempts', () => {
  afterEach(() => writeDefaultReport());

  it('falls through from a missing-on-disk attachment to a later test entry with a readable file', async () => {
    // The first project lists the attachment but its file is gone from disk; the loop must
    // continue past the swallowed statSync error and return content from the second project.
    const workingPath = join(resultsDir, 'works.txt');
    writeFileSync(workingPath, 'readable payload');
    try {
      writeCustomReport({
        suites: [
          {
            title: 'x.spec.ts',
            file: 'tests/x.spec.ts',
            specs: [
              {
                title: 'shared name',
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
                            path: join(resultsDir, 'missing.txt'),
                          },
                        ],
                      },
                    ],
                  },
                  {
                    projectName: 'Firefox',
                    status: 'unexpected',
                    results: [
                      {
                        status: 'failed',
                        duration: 10,
                        attachments: [
                          { name: 'diag', contentType: 'text/plain', path: workingPath },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        stats: { expected: 0, unexpected: 1, skipped: 0, duration: 20 },
      });

      const data = parseAttachmentResult(
        await client.callTool({
          name: 'get_test_attachment',
          arguments: { testTitle: 'shared name', attachmentName: 'diag' },
        })
      );
      expect(data.content).toBe('readable payload');
    } finally {
      try {
        unlinkSync(workingPath);
      } catch {
        // already gone
      }
    }
  });

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

describe('get_test_attachment — path-traversal defense', () => {
  afterEach(() => writeDefaultReport());

  // Acceptance criterion: attachment paths that escape workingDirectory must
  // be rejected even if results.json records them. Craft a results.json whose
  // attachment.path contains `..` components that escape the working dir.
  it('rejects an attachment whose recorded path escapes workingDirectory via ..', async () => {
    const escapingPath = join(resultsDir, '..', '..', '..', 'etc', 'passwd');
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'traversal test',
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
                        { name: 'diag', contentType: 'text/plain', path: escapingPath },
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
      arguments: {
        workingDirectory: 'test/fixtures',
        testTitle: 'traversal test',
        attachmentName: 'diag',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('escapes workingDirectory');
  });

  it('rejects an absolute attachment path outside workingDirectory', async () => {
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'absolute test',
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
                        { name: 'diag', contentType: 'text/plain', path: '/etc/passwd' },
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
      arguments: {
        workingDirectory: 'test/fixtures',
        testTitle: 'absolute test',
        attachmentName: 'diag',
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('escapes workingDirectory');
  });
});

describe('get_test_attachment — symlink-based exfiltration (security)', () => {
  const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
  const attachmentSymlinkPath = join(fixtures, 'test-results', 'sneaky.txt');
  let secretPath: string;

  beforeAll(() => {
    // A secret file OUTSIDE the working directory (test/fixtures). Represents
    // anything the MCP process could otherwise read — ~/.ssh/id_rsa, .env, etc.
    const secretDir = mkdtempSync(join(tmpdir(), 'pw-report-mcp-secret-'));
    secretPath = join(secretDir, 'id_rsa');
    writeFileSync(secretPath, '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n');
  });

  afterAll(() => {
    rmSync(secretPath, { force: true });
    rmSync(join(secretPath, '..'), { recursive: true, force: true });
  });

  afterEach(() => {
    writeDefaultReport();
    try {
      unlinkSync(attachmentSymlinkPath);
    } catch {
      // absent
    }
  });

  // The attacker-controlled results.json declares a text attachment whose
  // path is a symlink pointing at a secret file outside the working dir.
  // Without canonicalizing the attachment path before readFileSync, the
  // server would follow the symlink and return the secret contents.
  it('rejects an attachment whose path is a symlink escaping workingDirectory', async () => {
    if (!trySymlink(secretPath, attachmentSymlinkPath)) {
      console.warn('[test] symlinkSync unavailable — skipping');
      return;
    }
    writeCustomReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'tests/x.spec.ts',
          specs: [
            {
              title: 'symlink test',
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
                          path: attachmentSymlinkPath,
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
      arguments: {
        workingDirectory: 'test/fixtures',
        testTitle: 'symlink test',
        attachmentName: 'diag',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('resolves via symlink');
    expect(text).toContain('escapes workingDirectory');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
  });
});
