import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

export interface PackageMeta {
  name: string;
  version: string;
}

const PackageMetaSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
});

// Load identity from package.json so clients see the real published name/version via MCP `initialize`.
// Two candidates because the module runs in two layouts: source (`<repo>/src/*.ts`) and published
// (`<repo>/dist/*.js`). A hardcoded relative path would silently break in one of them; `tsc` does not
// rewrite JSON specifiers. `baseDir` is injectable so unit tests can exercise failure/fallback paths.
export function loadPackageMeta(baseDir?: string): PackageMeta {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'package.json'), join(here, '..', 'package.json')]) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      // Reject empty/whitespace-only values - MCP clients would otherwise render a blank server
      // identity, which defeats the whole point of sourcing these from package.json.
      return PackageMetaSchema.parse(pkg);
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Could not locate package.json relative to ${here}`);
}
