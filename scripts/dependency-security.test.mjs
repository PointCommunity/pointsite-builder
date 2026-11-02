import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const load = createRequire(import.meta.url);

test('all glob consumers use the patched nonrecursive matcher', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  const matchers = Object.entries(lock.packages).filter(([name]) => name.endsWith('/minimatch'));
  assert.ok(matchers.length > 0);
  for (const [name, entry] of matchers) {
    const [major, minor, patch] = entry.version.split('.').map(Number);
    assert.ok(
      major > 11 || (major === 11 && (minor > 0 || patch >= 1)),
      `${name}@${entry.version} predates the globparts amplification fix`,
    );
    const { Minimatch } = load(`../${name}`);
    for (const [pattern, value, expected] of [
      ['**/*.{ts,tsx}', 'src/client/editor.tsx', true],
      ['**/*.{ts,tsx}', 'src/client/editor.js', false],
      ['dist/**', 'dist/server/index.js', true],
      ['**/*.test.mjs', 'scripts/dependency-security.test.mjs', true],
    ]) {
      assert.equal(new Minimatch(pattern).match(value), expected);
    }
  }
});

test('ESLint still reports real rule violations after the matcher upgrade', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url)),
      '--stdin',
      '--stdin-filename',
      'scripts/dependency-fixture.mjs',
      '--format',
      'json',
    ],
    {
      input: 'console.log(process.version);\nmissingDependencySecurityFixture();\n',
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const [report] = JSON.parse(result.stdout);
  assert.equal(report.fatalErrorCount, 0);
  assert.deepEqual(
    report.messages.map(({ ruleId }) => ruleId),
    ['no-undef'],
  );
});
