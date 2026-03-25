import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { attachmentContent, stats, suites } from './fixtures/data.js';

const resultsDir = fileURLToPath(new URL('./fixtures/test-results', import.meta.url));

mkdirSync(resultsDir, { recursive: true });

const attachmentPath = join(resultsDir, 'diagnosis.txt');
writeFileSync(attachmentPath, attachmentContent);

// Inject the runtime-resolved attachment path into the fixture
const failedResult = suites[0].specs[1].tests[0].results[0];
failedResult.attachments = [{ name: 'diagnosis', contentType: 'text/plain', path: attachmentPath }];

writeFileSync(
  join(resultsDir, 'results.json'),
  JSON.stringify({ suites, stats }, null, 2)
);
