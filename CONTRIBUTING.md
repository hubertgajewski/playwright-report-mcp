# Contributing

Bug reports and pull requests are welcome. For significant changes, please open an issue first to discuss the approach.

## Development setup

```bash
npm install
npm run build
npm test
```

Tests use [Vitest](https://vitest.dev/) and cover the `collectSpecs` helper (unit) and all four MCP tools via `InMemoryTransport` (integration). No build step or Playwright installation is required to run the test suite. See the [Development](README.md#development) section of the README for watch mode and more detail.

## Code style

[Prettier](https://prettier.io/) is the only formatter. Settings live in [`.prettierrc`](.prettierrc) (100-column width, single quotes, semicolons, 2-space indent, `trailingComma: es5`). Run `npm run format:check` locally before pushing — CI enforces it.

There is no linter configured.

## Commits and pull requests

- **Commit messages:** short, single-line, imperative mood. Prefix with the issue number when applicable: `#123 fix: short summary`.
- **PR titles** follow the same format as commit messages.
- **PR body** should include `Closes #N` so the issue is automatically linked and closed on merge.
- **Tests for new behavior are expected.** The harness is Vitest under [`test/`](test/); the test file for server tools is [`test/server.test.ts`](test/server.test.ts).
