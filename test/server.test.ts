import { describe, expect, it, vi } from 'vitest';
import * as entrypoint from '../src/index.js';
import { client, pkg, setupMcpClient } from './helpers/mcp.js';

setupMcpClient();

describe('server identity', () => {
  // Covers the source-layout branch of loadPackageMeta (src/package-meta.ts one level below package.json).
  // The dist-layout branch is covered by test/e2e.test.ts.
  it('advertises name and version from package.json', () => {
    const info = client.getServerVersion();
    expect(info).toMatchObject({ name: pkg.name, version: pkg.version });
  });

  it('preserves legacy named exports from the package entrypoint', () => {
    expect(entrypoint.ALLOWED_DIRS).toEqual(entrypoint.loadConfig().allowedDirs);
    expect(entrypoint.server).toEqual(expect.objectContaining({ connect: expect.any(Function) }));
    expect(entrypoint.buildListTestsCmd).toEqual(expect.any(Function));
    expect(entrypoint.collectSpecs).toEqual(expect.any(Function));
    expect(entrypoint.createServer).toEqual(expect.any(Function));
    expect(entrypoint.formatStartupBanner).toEqual(expect.any(Function));
    expect(entrypoint.isInside).toEqual(expect.any(Function));
    expect(entrypoint.loadConfig).toEqual(expect.any(Function));
    expect(entrypoint.loadPackageMeta).toEqual(expect.any(Function));
    expect(entrypoint.parseAllowedDirs).toEqual(expect.any(Function));
    expect(entrypoint.parseListJson).toEqual(expect.any(Function));
  });

  it('can be imported when the Node entrypoint argument is absent', async () => {
    const originalArgvEntry = process.argv[1];
    try {
      vi.resetModules();
      delete process.argv[1];
      const imported: typeof entrypoint = await import('../src/index.js');
      expect(imported.createServer).toEqual(expect.any(Function));
    } finally {
      if (originalArgvEntry === undefined) {
        delete process.argv[1];
      } else {
        process.argv[1] = originalArgvEntry;
      }
      vi.resetModules();
    }
  });
});
