import { describe, expect, it } from 'vitest';
import { parseAllowedEnv, validateEnvOverrides } from '../src/env-policy.js';

const parentEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/alice',
  EXISTING: 'keep',
};

function expectError(
  allowed: string[],
  input: Record<string, string> | undefined,
  substring: string
) {
  const result = validateEnvOverrides(allowed, input, parentEnv);
  expect(result).toHaveProperty('error');
  if (!('error' in result)) throw new Error('expected error');
  expect(result.error).toContain(substring);
}

describe('parseAllowedEnv', () => {
  it('returns an empty list when unset', () => {
    expect(parseAllowedEnv(undefined)).toEqual([]);
  });

  it('returns an empty list when empty or whitespace', () => {
    expect(parseAllowedEnv('')).toEqual([]);
    expect(parseAllowedEnv('   ')).toEqual([]);
  });

  it('splits on commas and whitespace and drops duplicates', () => {
    expect(parseAllowedEnv('ENV,TEST_ENV, BASE_URL ENV')).toEqual(['ENV', 'TEST_ENV', 'BASE_URL']);
  });
});

describe('validateEnvOverrides — inherit when omitted', () => {
  it('returns a copy of the parent env when input is undefined', () => {
    const result = validateEnvOverrides(['ENV'], undefined, parentEnv);
    expect(result).toEqual({ env: parentEnv, keys: [] });
    if (!('env' in result)) throw new Error('expected env');
    expect(result.env).not.toBe(parentEnv);
  });
});

describe('validateEnvOverrides — allowlist', () => {
  it('merges an allowlisted ENV=staging over the parent env', () => {
    const result = validateEnvOverrides(['ENV'], { ENV: 'staging' }, parentEnv);
    expect(result).toEqual({
      env: { ...parentEnv, ENV: 'staging' },
      keys: ['ENV'],
    });
  });

  it('merges TEST_ENV and BASE_URL when those keys are allowlisted', () => {
    const result = validateEnvOverrides(
      ['TEST_ENV', 'BASE_URL'],
      { TEST_ENV: 'qa', BASE_URL: 'https://stage.example.com' },
      parentEnv
    );
    expect(result).toMatchObject({
      keys: ['TEST_ENV', 'BASE_URL'],
      env: {
        PATH: '/usr/bin',
        TEST_ENV: 'qa',
        BASE_URL: 'https://stage.example.com',
      },
    });
  });

  it('rejects a key that is not listed even when the allowlist is non-empty', () => {
    expectError(['ENV'], { TEST_ENV: 'qa' }, 'PW_ALLOWED_ENV');
  });
});

describe('validateEnvOverrides — disabled by default', () => {
  it('names PW_ALLOWED_ENV when env is passed and the allowlist is empty', () => {
    expectError([], { ENV: 'staging' }, 'PW_ALLOWED_ENV');
  });

  it('names PW_ALLOWED_ENV when env is an empty object and the allowlist is empty', () => {
    expectError([], {}, 'PW_ALLOWED_ENV');
  });
});

describe('validateEnvOverrides — denylist and secrets', () => {
  const dangerous = [
    'NODE_OPTIONS',
    'node_options',
    'PATH',
    'LD_PRELOAD',
    'HTTPS_PROXY',
    'HOME',
    'DOTENV_CONFIG_PATH',
    'BASIC_AUTH_PASSWORD',
  ];

  for (const key of dangerous) {
    it(`rejects ${key} even when listed in the allowlist`, () => {
      expectError([key, 'ENV'], { [key]: 'x' }, key);
    });
  }

  it('rejects NODE_DEBUG via the NODE_ prefix', () => {
    expectError(['NODE_DEBUG'], { NODE_DEBUG: '1' }, 'NODE_DEBUG');
  });

  it('rejects DYLD_INSERT_LIBRARIES via the DYLD_ prefix', () => {
    expectError(['DYLD_INSERT_LIBRARIES'], { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' }, 'DYLD_');
  });

  it('rejects names matching TOKEN even when allowlisted', () => {
    expectError(['GITHUB_TOKEN'], { GITHUB_TOKEN: 'ghs_x' }, 'GITHUB_TOKEN');
  });
});

describe('validateEnvOverrides — invalid shape', () => {
  it('rejects a non-POSIX key', () => {
    expectError(['not-posix'], { 'not-posix': 'x' }, 'POSIX');
  });

  it('rejects a NUL in a value', () => {
    expectError(['TEST_ENV'], { TEST_ENV: 'qa\0hidden' }, 'NUL');
  });

  it('rejects more than 16 entries', () => {
    const allowed = Array.from({ length: 17 }, (_, i) => `VAR_${i}`);
    const input = Object.fromEntries(allowed.map((k) => [k, 'x']));
    const result = validateEnvOverrides(allowed, input, parentEnv);
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected error');
    expect(result.error).toMatch(/16/);
  });

  it('rejects ENV=/tmp/evil.sh because POSIX ENV names a shell startup file', () => {
    expectError(['ENV'], { ENV: '/tmp/evil.sh' }, 'ENV');
  });

  it('does not echo rejected values in the error message', () => {
    const marker = 'super-secret-value-xyz';
    const result = validateEnvOverrides(['ENV'], { ENV: `/tmp/${marker}` }, parentEnv);
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected error');
    expect(result.error).not.toContain(marker);
  });

  it('rejects an ENV value longer than 256 characters', () => {
    expectError(['TEST_ENV'], { TEST_ENV: 'x'.repeat(257) }, '256');
  });
});
