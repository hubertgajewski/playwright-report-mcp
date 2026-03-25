// Edit this file to change fixture data — Vitest watch mode will detect changes here.

export const attachmentContent = 'AI diagnosis: Button selector .submit-btn not found in DOM.\n';

export const suites = [
  {
    title: 'auth',
    file: 'tests/auth.spec.ts',
    specs: [
      {
        title: 'login succeeds',
        file: 'tests/auth.spec.ts',
        line: 5,
        ok: true,
        tests: [
          {
            projectName: 'Chromium',
            status: 'expected',
            results: [{ status: 'passed', duration: 800, attachments: [] }],
          },
        ],
      },
      {
        title: 'login fails with wrong password',
        file: 'tests/auth.spec.ts',
        line: 12,
        ok: false,
        tests: [
          {
            projectName: 'Chromium',
            status: 'unexpected',
            results: [
              {
                status: 'failed',
                duration: 3200,
                error: { message: "Expected: 'Welcome'\nReceived: 'Login failed'" },
                // attachment path is injected by setup.ts at runtime
                attachments: [] as { name: string; contentType: string; path: string }[],
              },
            ],
          },
        ],
      },
    ],
    suites: [],
  },
];

export const stats = { expected: 1, unexpected: 1, skipped: 0, duration: 4000 };
