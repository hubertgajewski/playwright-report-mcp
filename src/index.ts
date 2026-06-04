#!/usr/bin/env node
import { realpathSync } from 'fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'url';
import { formatStartupBanner, loadConfig, parseAllowedDirs } from './config.js';
import { loadPackageMeta } from './package-meta.js';
import { isInside } from './path-policy.js';
import { buildListTestsCmd, collectSpecs, parseListJson } from './results.js';
import { createServer } from './server.js';

const defaultConfig = loadConfig();
const server = createServer({ config: defaultConfig });
const ALLOWED_DIRS = defaultConfig.allowedDirs;

export {
  ALLOWED_DIRS,
  buildListTestsCmd,
  collectSpecs,
  createServer,
  formatStartupBanner,
  isInside,
  loadConfig,
  loadPackageMeta,
  parseAllowedDirs,
  parseListJson,
  server,
};

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write(
    formatStartupBanner(
      defaultConfig.launchCwd,
      defaultConfig.allowedDirs,
      process.env.PW_ALLOWED_DIRS
    )
  );
  await server.connect(new StdioServerTransport());
}
