const POSIX_KEY = /^[A-Z_][A-Z0-9_]*$/;
const ENV_SAFE_VALUE = /^[A-Za-z0-9._-]+$/;
const SECRET_NAME =
  /PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|CREDENTIAL|PRIVATE_KEY|AUTH_SOCK|AUTH_CONFIG/i;

const MAX_ENV_ENTRIES = 16;
const MAX_ENV_VALUE_LENGTH = 256;

const DENY_EXACT = new Set([
  'PATH',
  'HOME',
  'DOTENV_CONFIG_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
]);

// npm reads npm_config_* case-insensitively, and the child is `npx`, so these keys can swap the
// registry or the script shell that launches Playwright.
const DENY_PREFIXES = ['NODE_', 'LD_', 'DYLD_', 'NPM_CONFIG_'] as const;

export function parseAllowedEnv(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

function denyReason(key: string): string | null {
  const upper = key.toUpperCase();
  if (SECRET_NAME.test(upper)) {
    return `env key "${key}" matches a secret-name pattern and cannot be set via tool arguments.`;
  }
  if (DENY_EXACT.has(upper) || DENY_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return `env key "${key}" is denied and cannot be set via tool arguments, even when listed in PW_ALLOWED_ENV.`;
  }
  return null;
}

export function validateEnvOverrides(
  allowedKeys: string[],
  input: Record<string, string> | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env
): { env: NodeJS.ProcessEnv; keys: string[] } | { error: string } {
  if (input === undefined) return { env: { ...parentEnv }, keys: [] };

  if (allowedKeys.length === 0) {
    return {
      error:
        'env overrides are disabled. Set PW_ALLOWED_ENV to a comma-separated list of allowed variable names.',
    };
  }

  const entries = Object.entries(input);
  if (entries.length > MAX_ENV_ENTRIES) {
    return {
      error: `env has ${entries.length} entries; the maximum is ${MAX_ENV_ENTRIES}.`,
    };
  }

  const allowed = new Set(allowedKeys);
  const overrides: Record<string, string> = {};

  for (const [key, value] of entries) {
    const denied = denyReason(key);
    if (denied) return { error: denied };

    if (!POSIX_KEY.test(key)) {
      return {
        error: `env key "${key}" is not a POSIX name (expected /^[A-Z_][A-Z0-9_]*$/).`,
      };
    }

    if (!allowed.has(key)) {
      return {
        error: `env key "${key}" is not listed in PW_ALLOWED_ENV (allowed: ${allowedKeys.join(', ')}).`,
      };
    }

    if (value.includes('\0')) {
      return { error: `env value for "${key}" contains a NUL byte.` };
    }

    if (value.length > MAX_ENV_VALUE_LENGTH) {
      return {
        error: `env value for "${key}" exceeds ${MAX_ENV_VALUE_LENGTH} characters.`,
      };
    }

    if (key === 'ENV' && !ENV_SAFE_VALUE.test(value)) {
      return {
        error:
          'env value for "ENV" must match /^[A-Za-z0-9._-]+$/ (POSIX ENV names a shell startup file).',
      };
    }

    overrides[key] = value;
  }

  return { env: { ...parentEnv, ...overrides }, keys: Object.keys(overrides) };
}
