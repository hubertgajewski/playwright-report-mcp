import { describe, expect, it } from 'vitest';
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
    expect(entrypoint.ALLOWED_DIRS).toEqual([process.cwd()]);
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
});
