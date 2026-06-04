import { mkdtempSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { isInside } from '../src/path-policy.js';
import {
  ALLOWED_DIRS,
  client,
  parseAttachmentResult,
  parseFailedTestsResult,
  parseListTestsResult,
  setupMcpClient,
  spawnSyncMock,
  spawnSyncResult,
  trySymlink,
} from './helpers/mcp.js';
import type { TextContent } from './helpers/mcp.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

setupMcpClient();

describe('isInside — segment-level containment', () => {
  it('treats parent equal to child as contained', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });

  it('treats a strict descendant as contained', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('rejects a path above the parent', () => {
    expect(isInside('/a/b', '/a')).toBe(false);
  });

  // Acceptance criterion: sibling-name bypass must be rejected. A raw
  // String.prototype.startsWith('/a/b') would accept '/a/b-extra'.
  it('rejects a sibling whose name shares a prefix with the parent', () => {
    expect(isInside('/a/b', '/a/b-extra')).toBe(false);
    expect(isInside('/Users/me/src/github/my-app', '/Users/me/src/github/my-app-evil')).toBe(false);
  });

  it('rejects a fully disjoint path', () => {
    expect(isInside('/a/b', '/c/d')).toBe(false);
  });
});

describe('workingDirectory — allowlist gate', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it('rejects workingDirectory outside the allowlist without spawning', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: '/etc' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // Acceptance criterion: sibling-name bypass at the tool boundary.
  // The allowlist is the repo root; '<repo-root>-evil' shares a prefix but is
  // a sibling, so it must be rejected exactly like a disjoint path.
  it('rejects sibling-name bypass at the tool boundary', async () => {
    const sibling = ALLOWED_DIRS[0] + '-evil';
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: sibling },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('passes a workingDirectory under the allowlist as the spawn cwd', async () => {
    await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures' },
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    expect(options.cwd.endsWith('test/fixtures')).toBe(true);
  });

  it('omitting workingDirectory defaults to launchCwd — spawn cwd matches ALLOWED_DIRS[0]', async () => {
    await client.callTool({ name: 'run_tests', arguments: {} });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    expect(options.cwd).toBe(ALLOWED_DIRS[0]);
  });

  it('gates list_tests on the allowlist', async () => {
    const result = await client.callTool({
      name: 'list_tests',
      arguments: { workingDirectory: '/etc' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('gates get_failed_tests on the allowlist', async () => {
    const result = await client.callTool({
      name: 'get_failed_tests',
      arguments: { workingDirectory: '/etc' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_DIRS');
  });

  it('gates get_test_attachment on the allowlist', async () => {
    const result = await client.callTool({
      name: 'get_test_attachment',
      arguments: {
        workingDirectory: '/etc',
        testTitle: 'login fails with wrong password',
        attachmentName: 'diagnosis',
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent[])[0].text).toContain('PW_ALLOWED_DIRS');
  });
});

describe('workingDirectory — existence check (AC9)', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  // Acceptance criterion: a nonexistent workingDirectory that would otherwise
  // pass the allowlist must be rejected with a specific error. Without the
  // existence check, Playwright spawns against a missing cwd and ENOENT
  // surfaces as a generic "Failed to spawn" — the silent fall-through the
  // issue explicitly forbids.
  it('rejects a nonexistent workingDirectory with a dedicated error and no spawn', async () => {
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures/does-not-exist-xyzzy' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('does not exist');
    expect(text).not.toContain('Failed to spawn');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a workingDirectory that exists but is a file, not a directory', async () => {
    // The fixture results.json file exists under the allowlist; pointing at it
    // as a "directory" must be rejected with a file-vs-dir specific error.
    const filePath = fileURLToPath(
      new URL('./fixtures/test-results/results.json', import.meta.url)
    );
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: filePath },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('not a directory');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('workingDirectory — positive acceptance on the other three tools (AC5)', () => {
  beforeEach(() => spawnSyncMock.mockClear());

  // AC5 says the parameter is accepted by list_tests, get_failed_tests, and
  // get_test_attachment with the same allowlist check. Negative paths are
  // covered above; these are the positive counterparts.

  it('list_tests accepts a workingDirectory under the allowlist and uses it as spawn cwd', async () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ stdout: '{"suites":[]}' }));
    const data = parseListTestsResult(
      await client.callTool({
        name: 'list_tests',
        arguments: { workingDirectory: 'test/fixtures' },
      })
    );
    expect(data).toEqual({ count: 0, tests: [] });
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    expect(options.cwd.endsWith('test/fixtures')).toBe(true);
  });

  it('get_failed_tests accepts a workingDirectory under the allowlist and returns the report', async () => {
    const data = parseFailedTestsResult(
      await client.callTool({
        name: 'get_failed_tests',
        arguments: { workingDirectory: 'test/fixtures' },
      })
    );
    expect(data.failedCount).toBe(1);
    expect(data.tests[0].title).toBe('login fails with wrong password');
  });

  it('get_test_attachment accepts a workingDirectory under the allowlist and returns content', async () => {
    const data = parseAttachmentResult(
      await client.callTool({
        name: 'get_test_attachment',
        arguments: {
          workingDirectory: 'test/fixtures',
          testTitle: 'login fails with wrong password',
          attachmentName: 'diagnosis',
        },
      })
    );
    expect(data.content).toContain('Button selector');
  });
});

describe('workingDirectory — symlink-based allowlist bypass (security)', () => {
  const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
  const symlinkPath = join(fixtures, 'symlink-escape');
  let escapeTarget: string;

  beforeAll(() => {
    escapeTarget = mkdtempSync(join(tmpdir(), 'pw-report-mcp-symlink-target-'));
  });

  afterAll(() => {
    rmSync(escapeTarget, { recursive: true, force: true });
    try {
      unlinkSync(symlinkPath);
    } catch {
      // absent or already cleaned
    }
  });

  beforeEach(() => spawnSyncMock.mockClear());
  afterEach(() => {
    try {
      unlinkSync(symlinkPath);
    } catch {
      // absent
    }
  });

  // Lexical isInside() passes because the symlink's path is literally under
  // the allowlist (repo root). Without realpathSync canonicalization, spawnSync
  // would chdir to the target and Playwright would load a malicious
  // playwright.config.ts from there. The fix is to reject such paths.
  it('rejects a workingDirectory that is a symlink escaping the allowlist', async () => {
    if (!trySymlink(escapeTarget, symlinkPath)) {
      console.warn('[test] symlinkSync unavailable — skipping');
      return;
    }
    const result = await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures/symlink-escape' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('resolves via symlink');
    expect(text).toContain('PW_ALLOWED_DIRS');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // A symlink whose target is still inside the allowlist (e.g. a convenience
  // link within the same project) must continue to work.
  it('accepts a symlink whose target is inside the allowlist', async () => {
    const innerTarget = join(fixtures);
    if (!trySymlink(innerTarget, symlinkPath)) {
      console.warn('[test] symlinkSync unavailable — skipping');
      return;
    }
    await client.callTool({
      name: 'run_tests',
      arguments: { workingDirectory: 'test/fixtures/symlink-escape' },
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2] as { cwd: string };
    // cwd is canonicalized — matches the target, not the symlink path.
    expect(options.cwd).toBe(innerTarget);
  });
});
