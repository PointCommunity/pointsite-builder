import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

const files = ['index.js', 'no-external.js', 'chunk-FWBFOZBF.mjs'];

test('patch is idempotent and rejects tampering without writing any bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'puck-history-test-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(
      new URL('./patch-puck-history.mjs', import.meta.url),
      join(root, 'scripts/patch-puck-history.mjs'),
    );
    const puck = join(root, 'node_modules/@puckeditor/core');
    cpSync(new URL('../node_modules/@puckeditor/core', import.meta.url), puck, { recursive: true });
    const run = () =>
      spawnSync(process.execPath, [join(root, 'scripts/patch-puck-history.mjs')], {
        encoding: 'utf8',
      });
    assert.equal(run().status, 0);
    const paths = files.map((file) => join(puck, 'dist', file));
    const patched = paths.map((path) => readFileSync(path, 'utf8'));
    assert.equal(run().status, 0);
    assert.deepEqual(
      paths.map((path) => readFileSync(path, 'utf8')),
      patched,
    );
    writeFileSync(paths[2], `${patched[2]}\n// unreviewed change`);
    const before = paths.map((path) => readFileSync(path, 'utf8'));
    assert.notEqual(run().status, 0);
    assert.deepEqual(
      paths.map((path) => readFileSync(path, 'utf8')),
      before,
    );
    const pkgPath = join(puck, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.version = '0.24.1';
    writeFileSync(pkgPath, JSON.stringify(pkg));
    assert.notEqual(run().status, 0);
    assert.deepEqual(
      paths.map((path) => readFileSync(path, 'utf8')),
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const file of files) {
  test(`${file}: undo before the timer preserves redo and leaves no stale record`, () => {
    const source = readFileSync(
      new URL(`../node_modules/@puckeditor/core/dist/${file}`, import.meta.url),
      'utf8',
    );
    const debounce = source.match(/function debounce\(func, [\s\S]*?\n}/)?.[0];
    const slice = source.match(
      /createHistorySlice = \(set, get\) => \{[\s\S]*?\n\s*record\n\s*};\n\s*};/,
    )?.[0];
    assert.ok(debounce && slice, 'Puck history code must be present');
    let timer;
    const context = {
      __spreadProps: Object.assign,
      __spreadValues: Object.assign,
      generateId: () => 'history',
      EMPTY_HISTORY_INDEX: 0,
      tidyState: (state) => state,
      setTimeout: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimeout: () => {
        timer = undefined;
      },
    };
    const create = vm.runInNewContext(`${debounce}\nlet ${slice}\ncreateHistorySlice`, context);
    const state = {
      dispatch: ({ state: next }) => {
        state.value = next;
      },
    };
    state.history = create(
      (next) => Object.assign(state, next),
      () => state,
    );
    const first = { name: 'first' };
    const edited = { name: 'edited' };
    state.history.record(first);
    timer();
    state.value = edited;
    state.history.record(edited);
    state.history.back();
    assert.equal(state.value.name, 'first');
    assert.equal(state.history.index, 0);
    assert.equal(state.history.histories.length, 2);
    if (timer) timer();
    assert.equal(state.history.histories.length, 2);
    state.history.forward();
    assert.equal(state.value.name, 'edited');
  });
}
