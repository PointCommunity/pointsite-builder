import { readFileSync } from 'node:fs';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

export const imageFixture = readFileSync(
  new URL('../../public/assets/point-logo.png', import.meta.url),
);
const templatePaths = new Set(defaultSiteDocument.media.map((item) => item.sourcePath));

/** Fulfill fixture assets directly so no API request survives browser teardown. */
export function draftAssetFixture(requestUrl: string) {
  const sourcePath = new URL(requestUrl).searchParams.get('path');
  if (sourcePath?.startsWith('/assets/builder/')) {
    return { status: 200, contentType: 'image/png', body: imageFixture };
  }
  if (!sourcePath || !templatePaths.has(sourcePath)) return { status: 404, body: '' };
  const extension = sourcePath.split('.').at(-1);
  return {
    status: 200,
    contentType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    body: readFileSync(new URL(`../../public${sourcePath}`, import.meta.url)),
  };
}
