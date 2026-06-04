import { formatStartupBanner, parseAllowedDirs } from '../src/config.js';
import { describe, expect, it } from 'vitest';

describe('parseAllowedDirs — startup resolution', () => {
  it('defaults to a single "." entry when env is unset', () => {
    expect(parseAllowedDirs(undefined, '/home/alice/proj')).toEqual(['/home/alice/proj']);
  });

  it('defaults to a single "." entry when env is the empty string', () => {
    expect(parseAllowedDirs('', '/home/alice/proj')).toEqual(['/home/alice/proj']);
  });

  // Acceptance criterion: relative entries resolve against launchCwd so a
  // committed .mcp.json works across contributors without baking absolute paths.
  it('resolves relative entries against launchCwd — contributor A', () => {
    expect(parseAllowedDirs('..', '/Users/alice/code/my-app')).toEqual(['/Users/alice/code']);
  });

  it('resolves relative entries against launchCwd — contributor B', () => {
    expect(parseAllowedDirs('..', '/home/bob/src/my-app')).toEqual(['/home/bob/src']);
  });

  it('preserves absolute entries verbatim', () => {
    expect(parseAllowedDirs('/etc', '/home/alice/proj')).toEqual(['/etc']);
  });

  it('splits multiple entries on path.delimiter', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(parseAllowedDirs(`.${sep}..`, '/home/alice/proj')).toEqual([
      '/home/alice/proj',
      '/home/alice',
    ]);
  });
});

describe('formatStartupBanner — AC7 startup log', () => {
  // Acceptance criterion: when PW_ALLOWED_DIRS is unset, the server surfaces
  // "default — authorizing only launchCwd" so operators know what is allowed.
  it('annotates the default case when PW_ALLOWED_DIRS is unset', () => {
    const banner = formatStartupBanner('/some/launch/dir', ['/some/launch/dir'], undefined);
    expect(banner).toContain('launchCwd=/some/launch/dir');
    expect(banner).toContain('PW_ALLOWED_DIRS=/some/launch/dir');
    expect(banner).toContain('default — authorizing only launchCwd');
  });

  it('annotates the default case when PW_ALLOWED_DIRS is the empty string', () => {
    const banner = formatStartupBanner('/x', ['/x'], '');
    expect(banner).toContain('default — authorizing only launchCwd');
  });

  it('omits the default annotation when the env var is set', () => {
    const banner = formatStartupBanner('/x', ['/x', '/y'], '..');
    expect(banner).toContain('PW_ALLOWED_DIRS=/x, /y');
    expect(banner).not.toContain('default — authorizing only launchCwd');
  });

  it('terminates with a newline so it does not run into subsequent log lines', () => {
    const banner = formatStartupBanner('/x', ['/x'], undefined);
    expect(banner.endsWith('\n')).toBe(true);
  });
});
