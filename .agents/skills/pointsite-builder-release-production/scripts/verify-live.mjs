#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const PRODUCTION_URL = 'https://builder.pointatx.org';

export function validateHealthPayload(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Builder health returned a non-object payload.');
  }
  if (value.ok !== true || value.environment !== 'production') {
    throw new Error('Builder health must report ok=true in the production environment.');
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

export function extractAssetPaths(html) {
  const paths = [];
  const seen = new Set();
  const attributePattern = /(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    let url;
    try {
      url = new URL(match[1], PRODUCTION_URL);
    } catch {
      continue;
    }
    if (url.origin !== PRODUCTION_URL || !url.pathname.startsWith('/assets/')) continue;
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
  if (baseUrl !== PRODUCTION_URL) {
    throw new Error(`Live verification is restricted to ${PRODUCTION_URL}.`);
  }

  const cacheKey = Date.now().toString(36);
  const healthResponse = await fetchRequired(
    `${baseUrl}/api/health?pipeline-check=${cacheKey}`,
    'application/json',
  );
  const health = validateHealthPayload(await healthResponse.json());

  const htmlResponse = await fetchRequired(`${baseUrl}/?pipeline-check=${cacheKey}`, 'text/html');
  const html = await htmlResponse.text();
  validateHtml(html);
  const assets = extractAssetPaths(html);
  if (assets.length === 0)
    throw new Error('Builder HTML did not reference any local build assets.');

  for (const assetPath of assets) {
    const expectedType = assetPath.endsWith('.css') ? 'text/css' : 'javascript';
    await fetchRequired(`${baseUrl}${assetPath}?pipeline-check=${cacheKey}`, expectedType);
  }

  return { url: baseUrl, health, assets };
}

async function main() {
  const result = await verifyLive(process.argv[2] ?? PRODUCTION_URL);
  process.stdout.write(
    `PointSite Builder production is healthy: ${result.health.version}; ${result.assets.length} HTML-derived asset(s) verified.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
