import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Puck 0.24.0 records history after 250 ms but never flushes it before navigation.
// Remove this patch when an upstream release passes the Undo-before-timer browser test.
const files = {
  'index.js': '0b693404a949f7a7b053ab2bb96370e9bc3e85c9f587b010ab8a31266654acd5',
  'no-external.js': '3172ced8bef62ab5131a877692a0d7a286ca2da0686cd250a3980864a8754d2f',
  'chunk-FWBFOZBF.mjs': 'a4f96ba90eab54e8ca8a8ade4d8f8da54d6113ca9d240fd05cf709eec68717b8',
};
const root = new URL('../node_modules/@puckeditor/core/', import.meta.url);
if (JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version !== '0.24.0') {
  throw new Error('Review the Puck history patch before changing its version.');
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Puck history patch does not match.');
  return source.replace(before, after);
}

const updates = Object.entries(files).map(([file, expected]) => {
  const path = new URL(`dist/${file}`, root);
  const source = readFileSync(path, 'utf8');
  const esm = file.endsWith('.mjs');
  const timeout = esm ? 'timeout' : 'timeout3';
  const before = `function debounce(func, ${timeout} = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func(...args);
    }, ${timeout});
  };
}`;
  const after = `function debounce(func, ${timeout} = 300) {
  let timer;
  let pending;
  const flush = () => {
    clearTimeout(timer);
    const args = pending;
    pending = undefined;
    if (args) func(...args);
  };
  const record = (...args) => {
    clearTimeout(timer);
    pending = args;
    timer = setTimeout(flush, ${timeout});
  };
  record.flush = flush;
  record.cancel = () => { clearTimeout(timer); pending = undefined; };
  return record;
}`;
  const substitutions = [[before, after]];
  for (const [method, operation] of [
    ['back: ()', 'flush'],
    ['forward: ()', 'flush'],
    ['setHistoryIndex: (index)', 'flush'],
    ['setHistories: (histories)', 'cancel'],
  ]) {
    const original = `${method} => {\n${esm ? '      ' : '          '}var _a;`;
    substitutions.push([
      original,
      `${original}\n${esm ? '      ' : '          '}record.${operation}();`,
    ]);
  }
  // Reverse only the exact patch, then verify the entire upstream file. Idempotent;
  // unrelated edits, unexpected releases, and partial patches all fail closed.
  const original = source.includes(after)
    ? substitutions.reduce((text, [old, patched]) => replaceOnce(text, patched, old), source)
    : source;
  if (createHash('sha256').update(original).digest('hex') !== expected) {
    throw new Error(`Unreviewed Puck source: ${file}`);
  }
  return [
    path,
    substitutions.reduce((text, [old, patched]) => replaceOnce(text, old, patched), original),
  ];
});
// Validate every entry before writing; rerunning accepts already patched entries.
for (const [path, source] of updates) writeFileSync(path, source);
