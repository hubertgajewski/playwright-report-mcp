# Contributing

Bug reports and pull requests are welcome. For significant changes, please open an issue first to discuss the approach.

## Development setup

```bash
npm install
npm run build
npm test
```

The test suite runs without a build step or a Playwright installation. Use `npm run test:watch` for watch mode.

## Code style

[Prettier](https://prettier.io/) is the only formatter. Settings live in [`.prettierrc`](.prettierrc) (100-column width, single quotes, semicolons, 2-space indent, `trailingComma: es5`). Run `npm run format:check` locally before pushing — CI enforces it.

There is no linter configured.

## Commits and pull requests

- **Commit messages:** short, single-line, imperative mood. Prefix with the issue number when applicable: `#123 fix: short summary`.
- **PR titles** follow the same format as commit messages.
- **PR body** should include `Closes #N` so the issue is automatically linked and closed on merge.
- **Tests for new behavior are expected.** The harness is [Vitest](https://vitest.dev/); existing suites live under [`test/`](test/).
