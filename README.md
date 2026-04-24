# Playwright Report MCP

An MCP (Model Context Protocol) server for running Playwright tests and reading structured results, failed test details, and attachment content — designed for AI agents doing test failure analysis.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

---

## Table of contents

- [What it is](#what-it-is)
- [What it is NOT](#what-it-is-not)
- [Why](#why)
- [Quick start](#quick-start)
- [Tools](#tools)
- [Attachments](#attachments)
- [Installation](#installation)
- [Configuration](#configuration)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Cutting a release](#cutting-a-release)
- [Contributing](#contributing)
- [Release](#release)
- [License](#license)

---

## What it is

**Playwright Report MCP** gives an AI agent structured, token-efficient access to Playwright test outcomes. It runs your test suite, reads the JSON reporter output, and surfaces exactly what the agent needs: which tests failed, what the errors were, and the content of relevant attachments.

## What it is NOT

There are many Playwright MCP servers that control a browser — they navigate pages, click elements, fill forms, and take screenshots. Playwright Report MCP is not one of those.

|                          | Browser automation MCPs                                        | Playwright Report MCP             |
| ------------------------ | -------------------------------------------------------------- | --------------------------------- |
| Examples                 | `microsoft/playwright-mcp`, `executeautomation/mcp-playwright` | this project                      |
| Purpose                  | Let an AI agent drive a browser                                | Let an AI agent read test results |
| Runs tests               | No                                                             | Yes                               |
| Returns pass/fail        | No                                                             | Yes                               |
| Surfaces error messages  | No                                                             | Yes                               |
| Reads attachment content | No                                                             | Yes                               |

---

## Why

### The problem with existing approaches

**Default reporters (`list` / `dot`)** — Playwright's default reporters print human-readable output to stdout. Compact, but lossy: no attachment paths, no retry breakdown, no structured data.

**HTML reporter** (`report.html`) — A self-contained SPA bundle (typically 2–50 MB). Not machine-readable as text and exceeds any LLM context window.

**Reading `results.json` directly** — Works, but a full JSON report for even a small test suite is 10,000–20,000 tokens. For a failing test, most of that is passing test metadata you don't need.

### What Playwright Report MCP does instead

- Filters `results.json` to only failed tests
- Returns structured, typed JSON the agent can act on immediately
- Exposes individual attachments by name so the agent fetches only what it needs
- Works on results produced by anyone — CI pipeline, a human, or the agent itself

### Token cost comparison (one failed test in a 20-test suite)

> Approximate input token counts based on **Claude tokenization** (~3–4 characters per token for mixed JSON/text content).

| What you need                         | Without MCP — approach                            | Tokens (no MCP) | With MCP — tool calls                    | Tokens (MCP)   | Savings     |
| ------------------------------------- | ------------------------------------------------- | --------------- | ---------------------------------------- | -------------- | ----------- |
| Error message only — live run         | `npx playwright test`, read stdout (`list`/`dot`) | ~500–1,200      | `run_tests` + `get_failed_tests`         | ~300–500       | ~2×         |
| Error message only — existing results | Read full `results.json`                          | ~12,500–23,000  | `get_failed_tests`                       | ~300–500       | **~25–45×** |
| + page state at failure               | + read `error-context` file                       | ~15,000–26,000  | + `get_test_attachment('error-context')` | ~2,800–3,500   | **~4–7×**   |
| + custom text attachments¹            | + read attachment files                           | ~16,200–28,500  | + `get_test_attachment` ×2               | ~3,300–5,500   | **~4–5×**   |
| + full page HTML snapshot²            | + read snapshot file                              | ~41,000–103,000 | + `get_test_attachment`                  | ~33,300–85,500 | ~1.2×       |

> ¹ **Custom text attachments** — e.g. AI diagnosis (~500–2,000 tokens) and console logs (~200–500 tokens) added via `testInfo.attach()` in your own fixtures.
>
> ² **Full page HTML snapshot** — a custom fixture that attaches the full rendered page HTML on failure. Large pages alone can reach 30,000–80,000 tokens and dominate cost regardless of whether MCP is used.

**Key observations:**

- For a live run, stdout (`list`/`dot`) is compact but gives the agent no path to attachment content — dead end for deeper analysis
- Reading `results.json` directly costs ~12,500–23,000 tokens even when only one test failed — most of it is passing test metadata the agent doesn't need
- The biggest MCP gains are in the middle rows: getting error messages + page state from existing results at **~4–45× lower token cost**
- Full page HTML snapshot dominates cost either way; skipping it in favour of `error-context` is the single largest optimisation available

### CI failure analysis

The primary use case: your CI pipeline runs the tests, the agent picks up the results after the fact and diagnoses failures. `get_failed_tests` reads `results.json` regardless of who triggered the run. No re-run needed.

---

## Quick start

**1. Install via npx (recommended)**

No clone or build step needed — npx downloads and runs the server automatically:

```json
{
  "mcpServers": {
    "playwright-report-mcp": {
      "command": "npx",
      "args": ["-y", "playwright-report-mcp"],
      "type": "stdio"
    }
  }
}
```

Or build from source:

```bash
git clone https://github.com/hubertgajewski/playwright-report-mcp.git
cd playwright-report-mcp
npm install && npm run build
```

**2. Add the JSON reporter to your Playwright project**

```ts
// playwright.config.ts
reporter: [
  ['json', { outputFile: 'test-results/results.json' }],
  ['html'], // keep any existing reporters
],
```

**3. Register in `.mcp.json`**

```json
{
  "mcpServers": {
    "playwright-report-mcp": {
      "command": "npx",
      "args": ["-y", "playwright-report-mcp"],
      "type": "stdio"
    }
  }
}
```

**4. Ask your AI agent**

> Run the Playwright tests and tell me what failed.

---

## Compatibility

Tested with **Claude Code (CLI)**. Should work with any MCP-compatible client that supports stdio transport, including Claude Desktop, Cursor, Cline, Windsurf, and Continue.dev — but these have not been verified.

---

## Tools

All four tools accept an optional `workingDirectory` parameter — see [Multi-worktree support](#multi-worktree-support).

### `run_tests`

Runs the Playwright test suite and returns structured pass/fail results.

| Input              | Type               | Description                                                                                                                                                                                                                                                     |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workingDirectory` | string (optional)  | Playwright project directory. Absolute or relative to the MCP server launch directory. Defaults to `"."`. Must be under `PW_ALLOWED_DIRS` — see [Multi-worktree support](#multi-worktree-support).                                                              |
| `spec`             | string (optional)  | Spec file path relative to the project directory, e.g. `tests/login.spec.ts`. Must stay within the project directory.                                                                                                                                           |
| `browser`          | enum (optional)    | `Chromium`, `Firefox`, `Webkit`, `Mobile Chrome`, `Mobile Safari`                                                                                                                                                                                               |
| `tag`              | string (optional)  | Tag filter, e.g. `@smoke`                                                                                                                                                                                                                                       |
| `timeout`          | integer (optional) | Timeout in milliseconds for the whole test run. Defaults to `300000` (5 min). Use a larger value for long suites or a smaller one to fail fast. When the run is killed by this timeout, the tool returns an explicit error rather than a generic non-zero exit. |
| `updateSnapshots`  | enum (optional)    | Update snapshot baselines. One of `all`, `changed`, `missing`, `none`. Playwright's default is `missing`; `changed` updates differing + missing. Omit to leave existing baselines alone.                                                                        |
| `headed`           | boolean (optional) | Run with a visible browser window. Omitting or setting `false` leaves `playwright.config.ts` intact — Playwright has no `--no-headed` flag, so `false` does not force headless when the config sets headed.                                                     |
| `workers`          | integer (optional) | Number of parallel workers. Positive integer only; the `"50%"` string form is not yet supported.                                                                                                                                                                |
| `retries`          | integer (optional) | Maximum retry count for flaky tests. `0` explicitly disables retries; omit to use the project's config.                                                                                                                                                         |
| `maxFailures`      | integer (optional) | Stop the run after this many failures. Positive integer.                                                                                                                                                                                                        |
| `trace`            | enum (optional)    | Force Playwright tracing mode, overriding `playwright.config.ts`. One of `on`, `off`, `on-first-retry`, `on-all-retries`, `retain-on-failure`, `retain-on-first-failure`, `retain-on-failure-and-retries`.                                                      |

Returns: exit code, run stats, and a summary of all tests with status, duration, and error per project.

### `get_failed_tests`

Returns failed tests from the last run with error messages and attachment paths. Does not re-run tests — reads the existing `results.json`.

| Input              | Type              | Description                                                               |
| ------------------ | ----------------- | ------------------------------------------------------------------------- |
| `workingDirectory` | string (optional) | See [Multi-worktree support](#multi-worktree-support). Defaults to `"."`. |

Returns: failed test count, titles, file paths, per-project status, error messages, and attachment paths.

### `get_test_attachment`

Reads the content of a named text attachment for a specific test from the last run.

| Input              | Type              | Description                                                               |
| ------------------ | ----------------- | ------------------------------------------------------------------------- |
| `workingDirectory` | string (optional) | See [Multi-worktree support](#multi-worktree-support). Defaults to `"."`. |
| `testTitle`        | string            | Exact test title as shown in the report                                   |
| `attachmentName`   | string            | Attachment name, e.g. `error-context`, `ai-diagnosis`, `page-html`        |

Returns: the attachment content as text. Binary attachments and files over 1 MB are rejected with an error. Attachment paths recorded in `results.json` that escape `workingDirectory` (via `..` or absolute paths pointing elsewhere) are refused.

### `list_tests`

Lists all tests with their spec file and tags without running them.

| Input              | Type              | Description                                                               |
| ------------------ | ----------------- | ------------------------------------------------------------------------- |
| `workingDirectory` | string (optional) | See [Multi-worktree support](#multi-worktree-support). Defaults to `"."`. |
| `tag`              | string (optional) | Filter by tag, e.g. `@smoke`                                              |

---

## Attachments

Playwright attaches files to failed tests automatically. `get_test_attachment` can read any text attachment by name.

| Attachment name    | Source                                                                         | Present in every project |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------ |
| `error-context`    | Playwright built-in — YAML accessibility tree snapshot at the point of failure | Yes                      |
| `screenshot`       | Playwright built-in — PNG screenshot (binary, not readable)                    | Yes                      |
| `video`            | Playwright built-in — WebM video (binary, not readable)                        | Yes                      |
| Custom attachments | Added via `testInfo.attach()` in your fixtures                                 | Depends on project       |

The `error-context` attachment is the most useful for projects without custom fixtures — it gives a semantic, structured view of the page at the moment of failure with no setup required.

---

## Installation

**Via npx (recommended)** — use the npx config shown in [Quick start](#quick-start). No local installation needed.

**From source:**

```bash
git clone https://github.com/hubertgajewski/playwright-report-mcp.git
cd playwright-report-mcp
npm install
npm run build
```

---

## Configuration

Add to your `.mcp.json` at the root of your project:

```json
{
  "mcpServers": {
    "playwright-report-mcp": {
      "command": "npx",
      "args": ["-y", "playwright-report-mcp"],
      "type": "stdio"
    }
  }
}
```

### Environment variables

| Variable          | Default                                        | Description                                                                                                                                                                      |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PW_ALLOWED_DIRS` | `"."` (authorizes only the launch dir)         | `path.delimiter`-separated list of directories the `workingDirectory` parameter may point at. Entries may be absolute or relative (resolved once against launch cwd at startup). |
| `PW_RESULTS_FILE` | `<workingDirectory>/test-results/results.json` | Absolute path to the JSON reporter output file. If set, overrides the per-call default for every call.                                                                           |

Set `PW_RESULTS_FILE` if your `playwright.config.ts` writes the report to a non-default location. Leave it unset in multi-worktree setups so each `workingDirectory` gets its own `test-results/results.json`.

### Multi-worktree support

`run_tests`, `list_tests`, `get_failed_tests`, and `get_test_attachment` all accept an optional `workingDirectory` parameter — absolute, or relative to the MCP server's launch directory. This lets a single long-lived MCP session drive tests across multiple git worktrees without restarting.

Because a Playwright config is a Node module that executes on `playwright test` startup, the server guards the parameter with an allowlist. Callers that point `workingDirectory` at a directory outside `PW_ALLOWED_DIRS` get a structured error and no child process is spawned.

**Default (no worktrees).** Leave `PW_ALLOWED_DIRS` unset. The allowlist becomes `"."` — only the launch directory — and the default `workingDirectory` (also `"."`) resolves to the launch directory. Zero configuration.

**Sibling worktrees.** Set `PW_ALLOWED_DIRS=".."` in your `.mcp.json` to authorize every sibling of the launch directory. Relative entries resolve against the launch cwd at startup, so the same `.mcp.json` works for every contributor without baking in absolute paths:

```json
{
  "mcpServers": {
    "playwright-report-mcp": {
      "command": "npx",
      "args": ["-y", "playwright-report-mcp"],
      "env": { "PW_ALLOWED_DIRS": ".." },
      "type": "stdio"
    }
  }
}
```

Then point calls at any sibling worktree:

```jsonc
{
  "name": "run_tests",
  "arguments": { "workingDirectory": "../my-app-feat-auth" },
}
```

**Multiple projects.** Either launch the MCP client from each project and use the default allowlist, or set `PW_ALLOWED_DIRS` to the shared parent and pass `workingDirectory` per call. The allowlist check runs at a path-segment boundary, so an entry authorizing `/src/my-app` will not authorize `/src/my-app-evil`.

> **Breaking change (2.x → next):** the `PW_DIR` env var has been removed. Either launch the MCP client from inside the Playwright project directory (zero-config, default `workingDirectory: "."` works), or pass `workingDirectory` per call and set `PW_ALLOWED_DIRS` accordingly.

---

## Requirements

- Node.js 22+
- `@playwright/test` 1.40 or later
- JSON reporter configured in your Playwright project

Playwright's default reporters (`list` locally, `dot` on CI) write to stdout only — they produce no file that can be read after the run. Add the JSON reporter alongside whatever reporters you already use:

```ts
// playwright.config.ts
reporter: [
  ['json', { outputFile: 'test-results/results.json' }],
  ['html'],  // keep any existing reporters
  ['list'],
],
```

---

## Troubleshooting

**`No results.json found — run tests first`**

The JSON reporter is not configured or is writing to a different path. Verify your `playwright.config.ts` has `['json', { outputFile: 'test-results/results.json' }]`.

**`list_tests parsed 0 tests from non-empty output`**

The `--list` output format may have changed in your version of Playwright. Open an issue with your Playwright version and the raw stdout output.

**`Attachment "..." is binary and cannot be returned as text`**

`screenshot` and `video` attachments are binary files. Use `get_failed_tests` to get attachment paths and open them directly if needed.

**`Attachment "..." is too large to return inline`**

The attachment exceeds 1 MB. Read the file directly from the path returned by `get_failed_tests`.

---

## Development

```bash
npm test          # run tests once
npm run test:watch  # watch mode
```

Tests use [Vitest](https://vitest.dev/) and cover the `collectSpecs` helper (unit) and all four MCP tools via `InMemoryTransport` (integration). No build step or Playwright installation required to run the test suite.

---

## Cutting a release

Releases are produced by pushing a `v*` tag. [`.github/workflows/release.yml`](.github/workflows/release.yml) picks up the tag, verifies the tag matches all three version fields, runs `npm ci` + `npm run build` + `npm test`, creates a GitHub Release with auto-generated notes categorized per `.github/release.yml` (Features / Bug fixes / Documentation / Dependencies / Other changes), and publishes to npm. [`.github/workflows/publish-mcp.yml`](.github/workflows/publish-mcp.yml) then chains off `Release` via `workflow_run` and publishes `server.json` to the MCP registry. Merging to `main` does not trigger a publish.

**Version lives in three places and all three must match the tag before pushing it:**

- `package.json` → `version`
- `server.json` → top-level `version`
- `server.json` → `packages[0].version`

Bump all three in one PR and merge to `main` before cutting the release. `release.yml` fails the run if the tag disagrees with any of these values.

**Ritual:**

```bash
# After the version-bump PR has merged to main:
git checkout main && git pull
git tag v1.0.5
git push origin v1.0.5
# → release.yml fires: verifies tag, builds, tests, creates GitHub Release, publishes to npm
# → publish-mcp.yml chains off Release and publishes server.json to the MCP registry
```

**Flow:**

1. Open a bump PR that updates all three version fields. Merge it to `main`.
2. Tag the bump commit `v<version>` and push the tag.
3. `release.yml` verifies tag/version alignment, runs `npm ci`, confirms the version is not already published on npm, runs `npm run build` + `npm test`, creates the GitHub Release, then publishes to npm with `npm publish --access public --provenance`.
4. `publish-mcp.yml` (triggered by `workflow_run` on `Release`) re-verifies the version fields, confirms the version is not already on the MCP registry, and publishes `server.json` to [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io).

**No repository secrets required.** Both npm and the MCP registry authenticate via GitHub OIDC ([npm trusted publishers](https://docs.npmjs.com/trusted-publishers)). The trusted publisher for npm is configured on npmjs.com under the package's **Settings → Publishing access → Trusted Publisher** section — no `NPM_TOKEN` secret exists or is needed.

**Recovery from a failed publish:** npm refuses to republish an existing version and restricts unpublishing after 72 hours. If a publish fails for any reason, bump to the next patch version in a new PR and cut a new release — do not try to re-run the failed release.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for bug reports, pull requests, development setup, and commit conventions.

---

## License

[MIT](LICENSE) — Copyright (c) [Hubert Gajewski](https://hubertgajewski.com)
