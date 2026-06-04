import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import tsconfig from '../tsconfig.json' with { type: 'json' };

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('package source and publish shape', () => {
  it('compiles the focused src tree into dist', () => {
    expect(tsconfig.compilerOptions.rootDir).toBe('src');
    expect(tsconfig.compilerOptions.outDir).toBe('dist');
    expect(tsconfig.include).toEqual(['src/**/*.ts']);
  });

  it('publishes every compiled runtime file required by internal imports', () => {
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.bin).toBe('./dist/index.js');
    expect(pkg.exports).toEqual({
      '.': './dist/index.js',
      './dist/index.js': './dist/index.js',
    });
    expect(pkg.files).toEqual(['dist/**']);
    expect(pkg.scripts).toMatchObject({ prepack: 'npm run build' });
  });

  it('cleans stale build output before compiling', () => {
    expect(pkg.scripts).toMatchObject({
      clean: expect.stringContaining("rmSync('dist'"),
      build: 'npm run clean && tsc && npm run chmod-bin',
      'chmod-bin': expect.stringContaining('chmodSync'),
    });
  });

  it('keeps the executable entrypoint small and under src', () => {
    const entrypoint = readRepoFile('src/index.ts');

    expect(entrypoint.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(entrypoint).toContain("from './server.js'");
    expect(entrypoint).toContain("from './config.js'");
  });

  it('keeps runtime responsibilities in focused source modules', () => {
    for (const modulePath of [
      'src/server.ts',
      'src/config.ts',
      'src/path-policy.ts',
      'src/results.ts',
      'src/run-tracker.ts',
      'src/package-meta.ts',
    ]) {
      expect(existsSync(join(repoRoot, modulePath))).toBe(true);
    }
  });
});
