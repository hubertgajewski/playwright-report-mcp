import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

function readWorkflow() {
  return readFileSync(workflowPath, 'utf8');
}

function normalizeYamlScalar(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function extractNodeMatrix(workflow: string) {
  const matrixMatch = workflow.match(/node-version:\s*(?:\[([^\]]+)\]|((?:\n\s*-\s*[^\n]+)+))/);

  if (!matrixMatch) {
    throw new Error('Could not find CI node-version matrix');
  }

  if (matrixMatch[1]) {
    return matrixMatch[1].split(',').map(normalizeYamlScalar);
  }

  return matrixMatch[2]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => normalizeYamlScalar(line.replace(/^-\s*/, '')));
}

function extractJobTimeouts(workflow: string) {
  const jobsSectionMatch = workflow.match(
    /^jobs:\n(?<jobs>(?:^ {2}[a-zA-Z0-9_-]+:\n|^ {4}.+\n|^\n)+)/m
  );

  if (!jobsSectionMatch?.groups?.jobs) {
    throw new Error('Could not find CI jobs section');
  }

  return Object.fromEntries(
    Array.from(
      jobsSectionMatch.groups.jobs.matchAll(
        /^ {2}(?<job>[a-zA-Z0-9_-]+):\n(?<body>(?:^ {4}.+\n|^\n)+)/gm
      )
    ).map((match) => {
      const timeoutMatch = match.groups?.body.match(/^ {4}timeout-minutes:\s*(\d+)/m);

      return [match.groups?.job, timeoutMatch ? Number(timeoutMatch[1]) : undefined];
    })
  );
}

describe('CI workflow', () => {
  it('runs the main test job on Node.js 22, 24, and 26', () => {
    expect(extractNodeMatrix(readWorkflow())).toEqual(['22', '24', '26']);
  });

  it('supports multiline node-version matrix syntax', () => {
    const workflow = readWorkflow().replace(
      "node-version: ['22', '24', '26']",
      "node-version:\n          - '22'\n          - '24'\n          - '26'"
    );

    expect(extractNodeMatrix(workflow)).toEqual(['22', '24', '26']);
  });

  it('sets calibrated timeouts on every job', () => {
    expect(extractJobTimeouts(readWorkflow())).toEqual({
      test: 5,
      e2e: 10,
    });
  });

  it('keeps coverage reporting scoped to the Node.js 22 baseline job', () => {
    const workflow = readWorkflow();

    expect(workflow).toContain(
      "if: matrix.node-version == '22' && github.event_name == 'pull_request'"
    );
    expect(workflow).toContain("if: matrix.node-version == '22'");
  });
});
