import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const handbook = await readFile(new URL('docs/operator-handbook.html', root), 'utf8');
const reports = [
  'tests/reports/web-design-audit.html',
  'tests/reports/accessibility.html',
  'tests/reports/ux.html',
  'tests/reports/performance.html',
  'tests/reports/security.html',
  'tests/reports/grid-workbench.html',
  'tests/reports/atomic-grid-composer.html',
  'tests/reports/friendly-workspaces.html',
];
const riskRegister = JSON.parse(
  await readFile(new URL('tests/reports/security-risk-register.json', root), 'utf8'),
);
const requiredRunbooks = [
  'cloudflare-account-isolation',
  'local-verification',
  'failed-publish',
  'backup-restore',
  'credential-rotation',
  'quota-response',
  'staging-rollback',
  'production-rollback',
];
const requiredLabels = [
  'Prerequisites',
  'Safe command',
  'Expected result',
  'Stop condition',
  'Recovery',
];

for (const id of requiredRunbooks) {
  const start = handbook.indexOf(`id="${id}"`);
  if (start < 0) throw new Error(`Missing runbook: ${id}`);
  const end = handbook.indexOf('</section>', start);
  const section = handbook.slice(start, end);
  for (const label of requiredLabels) {
    if (!section.includes(label)) throw new Error(`${id} is missing ${label}`);
  }
}

if (!/color-scheme\s*:\s*dark/.test(handbook) || !handbook.includes('name="theme-color"'))
  throw new Error('Operator handbook must declare dark color scheme and theme color');
if (/git push[^<\n]*\bmain\b/i.test(handbook))
  throw new Error('Runbooks must not instruct direct main-branch pushes');

for (const path of reports) {
  const html = await readFile(new URL(path, root), 'utf8');
  if (!html.includes('<!doctype html>') || !/color-scheme\s*:\s*dark/.test(html))
    throw new Error(`${path} is not a dark-mode HTML report`);
}

if (
  !Array.isArray(riskRegister) ||
  riskRegister.some(
    (risk) =>
      typeof risk.id !== 'string' ||
      risk.score !== risk.likelihood * risk.impact ||
      typeof risk.status !== 'string',
  )
)
  throw new Error('Security risk register is malformed or has an inconsistent score');

console.log(
  `Verified ${requiredRunbooks.length} runbooks, ${reports.length} dark-mode reports, and ${riskRegister.length} open risks.`,
);
