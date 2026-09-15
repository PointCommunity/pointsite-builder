#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const ORIGINS = {
  canary: 'https://builder-canary.eaglepass.io',
  production: 'https://builder.eaglepass.io',
};
const PRODUCTION_URL = ORIGINS.production;

export function validateHealthPayload(value, environment = 'production') {
  if (!Object.hasOwn(ORIGINS, environment)) throw new Error('Unknown Builder environment.');
  if (!value || typeof value !== 'object') {
    throw new Error('Builder health returned a non-object payload.');
  }
  if (value.ok !== true || value.environment !== environment) {
    throw new Error(`Builder health must report ok=true in the ${environment} environment.`);
  }
  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error('Builder health did not report a version.');
  }
  return { environment: value.environment, version: value.version };
}

export function validateHtml(html) {
  if (!/^\s*<!doctype html>/i.test(html)) {
    throw new Error('Builder root did not return an HTML document.');
  }
  if (!/<title>PointSite Builder<\/title>/i.test(html)) {
    throw new Error('Builder HTML is missing the PointSite Builder title.');
  }
  if (!/<div\s+id=["']root["']/i.test(html)) {
    throw new Error('Builder HTML is missing the application root.');
  }
}

export function extractAssetPaths(html, baseUrl = PRODUCTION_URL) {
  const paths = [];
  const seen = new Set();
  const attributePattern = /(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    let url;
    try {
      url = new URL(match[1], baseUrl);
    } catch {
      continue;
    }
    if (url.origin !== baseUrl || !url.pathname.startsWith('/assets/')) continue;
    if (!/\.(?:js|css)$/i.test(url.pathname) || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    paths.push(url.pathname);
  }
  return paths;
}

async function fetchRequired(url, expectedType) {
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes(expectedType)) {
    throw new Error(`${url} returned unexpected content type ${contentType || '(missing)'}.`);
  }
  return response;
}

export async function verifyLive(baseUrl = PRODUCTION_URL) {
  const environment = Object.keys(ORIGINS).find((name) => ORIGINS[name] === baseUrl);
  if (!environment) throw new Error('Live verification is restricted to the two Builder origins.');

  const cacheKey = Date.now().toString(36);
  const healthResponse = await fetchRequired(
    `${baseUrl}/api/health?pipeline-check=${cacheKey}`,
    'application/json',
  );
  const health = validateHealthPayload(await healthResponse.json(), environment);

  const htmlResponse = await fetchRequired(`${baseUrl}/?pipeline-check=${cacheKey}`, 'text/html');
  const html = await htmlResponse.text();
  validateHtml(html);
  const assets = extractAssetPaths(html, baseUrl);
  if (assets.length === 0)
    throw new Error('Builder HTML did not reference any local build assets.');

  for (const assetPath of assets) {
    const expectedType = assetPath.endsWith('.css') ? 'text/css' : 'javascript';
    await fetchRequired(`${baseUrl}${assetPath}?pipeline-check=${cacheKey}`, expectedType);
  }

  return { url: baseUrl, health, assets };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length &&
    (args.length !== 2 || args[0] !== '--environment' || !Object.hasOwn(ORIGINS, args[1]))
  ) {
    throw new Error('Usage: verify-live.mjs [--environment canary|production]');
  }
  const result = await verifyLive(ORIGINS[args[1] ?? 'production']);
  process.stdout.write(
    `PointSite Builder ${result.health.environment} HTTP checks passed: ${result.health.version}; ${result.assets.length} HTML-derived asset(s) verified. GitOps, image identity, workspace readiness and authenticated behavior require separate evidence.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
