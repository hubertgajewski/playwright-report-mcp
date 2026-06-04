import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { errorMessage } from './errors.js';

const PW_RESULT_STATUSES = ['passed', 'failed', 'skipped', 'timedOut', 'interrupted'] as const;
const PW_TEST_STATUSES = ['expected', 'unexpected', 'flaky', 'skipped'] as const;

const AttachmentSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  path: z.string().optional(),
});

const ResultStatusSchema = z.enum(PW_RESULT_STATUSES);
const TestStatusSchema = z.enum(PW_TEST_STATUSES);

const ResultSchema = z.object({
  status: ResultStatusSchema,
  duration: z.number(),
  error: z
    .object({
      message: z.string().optional(),
    })
    .optional(),
  attachments: z.array(AttachmentSchema).default([]),
});

const TestSchema = z.object({
  projectName: z.string(),
  status: TestStatusSchema,
  results: z.array(ResultSchema).default([]),
});

const SpecSchema = z.object({
  title: z.string(),
  file: z.string(),
  line: z.number(),
  ok: z.boolean(),
  tags: z.array(z.string()).optional(),
  tests: z.array(TestSchema).default([]),
});

type SuiteSchemaOutput<TSpec, THasTitle extends boolean> = {
  file?: string;
  specs: TSpec[];
  suites?: Array<SuiteSchemaOutput<TSpec, THasTitle>>;
} & (THasTitle extends true ? { title: string } : {});

function createSuiteSchema<TSpecSchema extends z.ZodType, THasTitle extends boolean>(
  specSchema: TSpecSchema,
  includeTitle: THasTitle
): z.ZodType<SuiteSchemaOutput<z.infer<TSpecSchema>, THasTitle>> {
  type SuiteOutput = SuiteSchemaOutput<z.infer<TSpecSchema>, THasTitle>;
  let suiteSchema: z.ZodType<SuiteOutput>;
  suiteSchema = z.lazy(() => {
    const titleShape = includeTitle ? { title: z.string() } : {};
    return z.object({
      ...titleShape,
      file: z.string().optional(),
      specs: z.array(specSchema).default([]),
      suites: z.array(suiteSchema).optional(),
    }) as z.ZodType<SuiteOutput>;
  });
  return suiteSchema;
}

const SuiteSchema = createSuiteSchema(SpecSchema, true);

const ReportSchema = z.object({
  suites: z.array(SuiteSchema),
  stats: z.object({
    expected: z.number(),
    unexpected: z.number(),
    flaky: z.number().optional(),
    skipped: z.number(),
    duration: z.number(),
  }),
});

const ListSpecSchema = z.object({
  title: z.string(),
  line: z.number(),
  tags: z.array(z.string()).optional(),
});

const ListSuiteSchema = createSuiteSchema(ListSpecSchema, false);

const ListReportSchema = z.object({
  suites: z.array(ListSuiteSchema).optional().default([]),
});

// ---------- types (subset of Playwright JSON reporter output) ----------

export type PwAttachment = z.infer<typeof AttachmentSchema>;
export type PwResultStatus = z.infer<typeof ResultStatusSchema>;
export type PwResult = z.infer<typeof ResultSchema>;
export type PwTestStatus = z.infer<typeof TestStatusSchema>;
export type PwTest = z.infer<typeof TestSchema>;
export type PwSpec = z.infer<typeof SpecSchema>;
export type PwSuite = z.infer<typeof SuiteSchema>;
export type PwReport = z.infer<typeof ReportSchema>;

export interface ResultsFileStatus {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
  updatedAfterStart: boolean | null;
}

export interface ResultsPathConfig {
  resultsFileOverride: string | null;
}

export type ReadLastReportResult =
  | { ok: true; report: PwReport }
  | { ok: false; reason: 'missing'; path: string }
  | { ok: false; reason: 'invalid'; path: string; error: string };

interface SuiteNode<TSpec> {
  file?: string;
  specs?: TSpec[];
  suites?: Array<SuiteNode<TSpec>>;
}

export function resultsFileFor(config: ResultsPathConfig, dir: string): string {
  return config.resultsFileOverride ?? join(dir, 'test-results', 'results.json');
}

function isMissingFileError(e: unknown): boolean {
  if (!(e instanceof Error) || !Object.prototype.hasOwnProperty.call(e, 'code')) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code === 'ENOENT';
}

export function readLastReportResult(config: ResultsPathConfig, dir: string): ReadLastReportResult {
  const path = resultsFileFor(config, dir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (isMissingFileError(e)) return { ok: false, reason: 'missing', path };
    return { ok: false, reason: 'invalid', path, error: errorMessage(e) };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, report: ReportSchema.parse(parsed) };
  } catch (e) {
    return { ok: false, reason: 'invalid', path, error: errorMessage(e) };
  }
}

export function readLastReport(config: ResultsPathConfig, dir: string): PwReport | null {
  const result = readLastReportResult(config, dir);
  return result.ok ? result.report : null;
}

function* walkSuiteSpecs<TSpec>(
  suites: Array<SuiteNode<TSpec>>,
  filePath = ''
): Generator<{ spec: TSpec; file: string }> {
  const stack = suites.map((suite) => ({ suite, filePath })).reverse();

  while (stack.length > 0) {
    const { suite, filePath: inheritedFile } = stack.pop()!;
    const file = suite.file ?? inheritedFile;
    const nestedSuites = suite.suites ?? [];

    for (const spec of suite.specs ?? []) {
      yield { spec, file };
    }

    for (let i = nestedSuites.length - 1; i >= 0; i--) {
      stack.push({ suite: nestedSuites[i], filePath: file });
    }
  }
}

/** Flatten nested suites into a list of specs with their file paths. */
export function collectSpecs(
  suites: PwSuite[],
  filePath = ''
): Array<{ spec: PwSpec; file: string }> {
  return Array.from(walkSuiteSpecs(suites, filePath));
}

export function findSpec(
  suites: PwSuite[],
  predicate: (spec: PwSpec, file: string) => boolean,
  filePath = ''
): { spec: PwSpec; file: string } | null {
  for (const item of walkSuiteSpecs(suites, filePath)) {
    if (predicate(item.spec, item.file)) return item;
  }
  return null;
}

export function summarizeReport(report: PwReport, exitCode: number) {
  const specs = collectSpecs(report.suites);
  const summary = specs.map(({ spec: s, file }) => ({
    title: s.title,
    file,
    ok: s.ok,
    // results.at(-1) = final retry attempt - authoritative outcome when Playwright retries are configured
    results: s.tests.map((t) => {
      const last = t.results.at(-1);
      return {
        project: t.projectName,
        status: last?.status ?? 'unknown',
        duration: last?.duration ?? 0,
        error: last?.error?.message ?? null,
      };
    }),
  }));

  return { exitCode, stats: report.stats, tests: summary };
}

export function resultsFileStatus(
  config: ResultsPathConfig,
  dir: string,
  startedAtMs?: number
): ResultsFileStatus {
  const resultsPath = resultsFileFor(config, dir);
  const st = statSync(resultsPath, { throwIfNoEntry: false });
  const updatedAfterStart =
    startedAtMs === undefined ? null : Boolean(st && st.mtimeMs >= startedAtMs);

  return {
    path: resultsPath,
    exists: Boolean(st),
    mtimeMs: st?.mtimeMs ?? null,
    size: st?.size ?? null,
    updatedAfterStart,
  };
}

export function buildListTestsCmd(tag?: string): string[] {
  const cmd = ['npx', 'playwright', 'test', '--list', '--reporter=json'];
  if (tag) cmd.push('--grep', tag);
  return cmd;
}

/**
 * Extract a balanced JSON object from stdout. The JSON reporter writes `{` at
 * column 0; we scan forward tracking string state and brace depth so that any
 * trailing warnings Playwright prints after the report don't poison the slice.
 */
function extractJsonObject(stdout: string): string {
  const start = stdout.search(/^\{/m);
  if (start < 0) throw new Error('Playwright --list output contained no JSON object.');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return stdout.slice(start, i + 1);
  }
  throw new Error('Playwright --list output had unbalanced JSON braces.');
}

/**
 * Parse `npx playwright test --list --reporter=json` stdout into a deduplicated
 * list of tests with @-prefixed tags. Dotenv/warning lines before or after the
 * JSON body are tolerated; malformed or missing JSON throws.
 */
export function parseListJson(
  stdout: string
): Array<{ title: string; file: string; tags: string[] }> {
  const parsed: unknown = JSON.parse(extractJsonObject(stdout));
  const report = ListReportSchema.parse(parsed);

  const seen = new Set<string>();
  const tests: Array<{ title: string; file: string; tags: string[] }> = [];
  for (const { spec, file } of walkSuiteSpecs(report.suites)) {
    const key = `${file}::${spec.line}::${spec.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = (spec.tags ?? []).map((t) => (t.startsWith('@') ? t : `@${t}`));
    tests.push({ title: spec.title, file, tags });
  }
  return tests;
}
