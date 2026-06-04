import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPackageMeta } from '../src/package-meta.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('loadPackageMeta', () => {
  // Layout under test: tmpRoot/
  //                      ├── package.json      ← parent candidate
  //                      └── dist/
  //                          └── package.json  ← first candidate
  // Tests drive loadPackageMeta(join(tmpRoot, 'dist')) to exercise both candidates.
  let tmpRoot: string;
  let distDir: string;
  const firstPath = () => join(distDir, 'package.json');
  const parentPath = () => join(tmpRoot, 'package.json');

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'pw-report-mcp-pkgmeta-'));
    distDir = join(tmpRoot, 'dist');
    mkdirSync(distDir);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the first candidate when it has valid name/version', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first', version: '1.0.0' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '9.9.9' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'first', version: '1.0.0' });
  });

  it('falls through to the parent candidate when the first is missing', () => {
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '2.3.4' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '2.3.4' });
  });

  it('skips a candidate with malformed JSON and falls through', () => {
    writeFileSync(firstPath(), 'not valid json {{{');
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '3.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '3.0.0' });
  });

  it('skips a candidate missing version and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '4.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '4.0.0' });
  });

  it('skips a candidate missing name and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ version: '5.0.0' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '5.0.1' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '5.0.1' });
  });

  it('skips a candidate where name/version are not strings and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first', version: 1 }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '6.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '6.0.0' });
  });

  it('skips a candidate with an empty name and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '', version: '7.0.0' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '7.1.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '7.1.0' });
  });

  it('skips a candidate with an empty version and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: 'first', version: '' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '8.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '8.0.0' });
  });

  it('skips a candidate with whitespace-only name/version and falls through', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '   ', version: '\t\n' }));
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent', version: '9.0.0' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'parent', version: '9.0.0' });
  });

  it('trims leading/trailing whitespace from accepted name and version', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '  padded  ', version: '\t10.0.0\n' }));
    expect(loadPackageMeta(distDir)).toEqual({ name: 'padded', version: '10.0.0' });
  });

  it('throws when the only candidate has empty name/version', () => {
    writeFileSync(firstPath(), JSON.stringify({ name: '', version: '' }));
    expect(() => loadPackageMeta(distDir)).toThrow(/Could not locate package\.json/);
  });

  it('throws when no candidate has valid metadata', () => {
    writeFileSync(firstPath(), 'garbage');
    writeFileSync(parentPath(), JSON.stringify({ name: 'parent' })); // missing version
    expect(() => loadPackageMeta(distDir)).toThrow(/Could not locate package\.json/);
  });

  it('throws when neither candidate exists on disk', () => {
    expect(() => loadPackageMeta(distDir)).toThrow(/Could not locate package\.json/);
  });

  it('includes the baseDir in the thrown error message for diagnosability', () => {
    expect(() => loadPackageMeta(distDir)).toThrow(new RegExp(distDir.replace(/\./g, '\\.')));
  });
});
