#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const repository = resolve(process.argv[2] ?? '../pointsite-staging');

async function walk(directory) {
  const entries = await readdir(directory);
  const paths = [];
  for (const entry of entries) {
    const path = resolve(directory, entry);
    if ((await stat(path)).isDirectory()) paths.push(...(await walk(path)));
    else paths.push(path);
  }
  return paths;
}

const sourceFiles = (await walk(repository)).filter(
  (path) =>
    /\.(?:ts|tsx)$/.test(path) && !path.includes('/node_modules/') && !path.includes('/.next/'),
);
const source = (await Promise.all(sourceFiles.map((path) => readFile(path, 'utf8')))).join('\n');
const content = await readFile(resolve(repository, 'content/site.ts'), 'utf8');
const publishedPageSection = content.match(/export const pages:[\s\S]*?export const beliefs/)?.[0];
if (!publishedPageSection) throw new Error('Could not locate the published pages export');
const slugs = [...publishedPageSection.matchAll(/slug:\s*'([^']+)'/g)].map(
  (match) => `/${match[1]}`,
);
const assetReferences = [
  ...new Set([...source.matchAll(/['"](\/assets\/[^'"]+)['"]/g)].map((match) => match[1])),
].sort();
const assetFiles = (await walk(resolve(repository, 'public/assets')))
  .map((path) => path.slice(resolve(repository, 'public').length))
  .sort();

process.stdout.write(
  `${JSON.stringify(
    {
      repository,
      routes: ['/', ...slugs].sort(),
      assetReferences,
      assetFiles,
      unreferencedAssets: assetFiles.filter((path) => !assetReferences.includes(path)),
    },
    null,
    2,
  )}\n`,
);
