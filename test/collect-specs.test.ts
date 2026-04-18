import { describe, it, expect } from 'vitest';
import { collectSpecs } from '../index.js';

type SuiteArg = Parameters<typeof collectSpecs>[0][number];

describe('collectSpecs', () => {
  it('returns empty array for empty suites', () => {
    expect(collectSpecs([])).toEqual([]);
  });

  it('collects specs from a flat suite', () => {
    const result = collectSpecs([
      {
        title: 'auth',
        file: 'tests/auth.spec.ts',
        specs: [
          { title: 'login', file: 'tests/auth.spec.ts', line: 1, ok: true, tests: [] },
          { title: 'logout', file: 'tests/auth.spec.ts', line: 10, ok: true, tests: [] },
        ],
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].spec.title).toBe('login');
    expect(result[1].spec.title).toBe('logout');
    expect(result[0].file).toBe('tests/auth.spec.ts');
  });

  it('collects specs from nested suites', () => {
    const result = collectSpecs([
      {
        title: 'root',
        file: 'tests/root.spec.ts',
        specs: [{ title: 'top-level', file: 'tests/root.spec.ts', line: 1, ok: true, tests: [] }],
        suites: [
          {
            title: 'nested',
            specs: [{ title: 'nested test', file: '', line: 5, ok: false, tests: [] }],
          },
        ],
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].spec.title).toBe('top-level');
    expect(result[1].spec.title).toBe('nested test');
  });

  it('inherits file from parent suite when spec has no file', () => {
    const result = collectSpecs([
      {
        title: 'suite',
        file: 'tests/parent.spec.ts',
        specs: [],
        suites: [
          {
            title: 'child',
            specs: [{ title: 'test', file: '', line: 1, ok: true, tests: [] }],
          },
        ],
      },
    ]);

    expect(result[0].file).toBe('tests/parent.spec.ts');
  });

  it('handles suites with no specs', () => {
    const result = collectSpecs([{ title: 'empty', file: 'tests/empty.spec.ts', specs: [] }]);
    expect(result).toEqual([]);
  });

  it('treats a missing specs field as empty', () => {
    // `specs: []` exercises the defined branch of `suite.specs ?? []`; this case exercises the fallback.
    const result = collectSpecs([
      { title: 'no-specs-field', file: 'tests/x.spec.ts' } as unknown as SuiteArg,
    ]);
    expect(result).toEqual([]);
  });
});
