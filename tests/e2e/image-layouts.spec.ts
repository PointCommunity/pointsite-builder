import { expect, test } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type * as ImageLayoutRenderer from '../fixtures/image-layout-renderer';

const shapes = [
  [400, 500],
  [1600, 900],
  [600, 600],
  [2000, 100],
  [100, 2000],
];
const document = structuredClone(defaultSiteDocument);
document.media = shapes.map(([width, height], index) => ({
  ...document.media[0],
  id: `10000000-0000-4000-8000-00000000000${index}`,
  sourcePath: `/fixture-${index}.svg`,
  alt: `Shape ${index}`,
  width,
  height,
}));
document.collections.people = Array.from({ length: 6 }, (_, index) => ({
  ...document.collections.people[0],
  id: `20000000-0000-4000-8000-00000000000${index}`,
  name: index === 1 ? 'A very long person name that needs several lines' : `Person ${index}`,
  role: index === 2 ? 'A longer role with multiple responsibilities and readable wrapping' : 'Role',
  bio: index === 3 ? 'Long biography with readable text. '.repeat(12) : 'Short biography.',
  mediaId: document.media[index]?.id,
}));

const variants = [
  'standard',
  'splitEditorial',
  'splitEditorialTone',
  'identity',
  'beliefs',
  'groups',
  'giving',
] as const;

for (const width of [1280, 768, 360]) {
  test(`phone-sized authoring image frames and card geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let releaseImages!: () => void;
    const imagesReady = new Promise<void>((resolve) => {
      releaseImages = resolve;
    });
    await page.route('**/fixture-*.svg', async (route) => {
      await imagesReady;
      const index = Number(new URL(route.request().url()).pathname.match(/fixture-(\d+)/)?.[1]);
      const [w, h] = shapes[index];
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="teal"/></svg>`,
      });
    });
    await page.goto('/');
    const cases = [
      ...['standard', 'leadership', 'horizontal'].flatMap((variant) =>
        ['grid', 'featured'].map((layout) => ({
          block: {
            id: 'people',
            type: 'people',
            variant,
            layout,
            personIds: document.collections.people.map((person) => person.id),
          },
          ratio: variant === 'horizontal' ? 16 / 9 : 4 / 5,
          fit: variant === 'standard' ? 'contain' : 'cover',
        })),
      ),
      ...variants.flatMap((variant) =>
        [2, 3, 4].map((columns) => ({
          block: {
            id: 'cards',
            type: 'cards',
            variant,
            columns,
            items: document.collections.people.map((person, index) => ({
              title: person.name,
              body: index === 3 ? 'Long body. '.repeat(40) : 'Body text',
              mediaId: person.mediaId,
              mediaAlt: person.name,
              href: '/details',
            })),
          },
          ratio: 16 / 9,
          fit: 'contain',
        })),
      ),
    ];
    for (const { block, ratio, fit } of cases) {
      // The same renderer and stylesheet are used by canvas, preview and publication.
      await page.evaluate(
        async ({ block, document }) => {
          const modulePath = '/tests/fixtures/image-layout-renderer.tsx';
          const { show } = (await import(modulePath)) as typeof ImageLayoutRenderer;
          show({ ...block, id: '30000000-0000-4000-8000-000000000000' }, document);
        },
        { block, document },
      );
      const frames = page.locator(
        block.type === 'people' ? 'article > img, .person-placeholder' : '.point-card-media',
      );
      await expect(frames, JSON.stringify(block)).toHaveCount(6);
      await page.evaluate(() => window.document.fonts.ready);
      const bounds = await frames.evaluateAll((items) =>
        items.map((item) => {
          const rect = item.getBoundingClientRect();
          const parent = item.closest('article') ?? item.parentElement!;
          const card = parent.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            fit: getComputedStyle(item).objectFit,
            cardHeight: card.height,
            overflow: parent.scrollWidth - parent.clientWidth,
          };
        }),
      );
      releaseImages();
      await frames.evaluateAll(async (items) => {
        await Promise.all(
          items
            .filter((item): item is HTMLImageElement => item instanceof HTMLImageElement)
            .map(async (item) => {
              item.loading = 'eager';
              await item.decode();
            }),
        );
      });
      const loaded = await frames.evaluateAll((items) =>
        items.map((item) => {
          const rect = item.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      expect(loaded).toEqual(bounds.map(({ width, height }) => ({ width, height })));
      for (const [index, boundsItem] of bounds.entries()) {
        expect(
          boundsItem.width / boundsItem.height,
          `${block.type} ${block.variant} ${index}`,
        ).toBeCloseTo(ratio, 2);
        if (index < 5) expect(boundsItem.fit).toBe(fit);
        expect(boundsItem.overflow).toBeLessThanOrEqual(1);
      }
      const ordinary =
        block.type === 'people' && 'layout' in block && block.layout === 'featured'
          ? bounds.slice(1)
          : bounds;
      expect(
        Math.max(...ordinary.map((item) => item.width)) -
          Math.min(...ordinary.map((item) => item.width)),
      ).toBeLessThan(1);
      if (block.type === 'cards' && 'items' in block) {
        await expect(page.locator('.point-cards-with-media a')).toHaveCount(6);
        await page.locator('.point-cards-with-media a').first().focus();
        await expect(page.locator('.point-cards-with-media a').first()).toBeFocused();
        await page.evaluate(
          async ({ block, document }) => {
            const modulePath = '/tests/fixtures/image-layout-renderer.tsx';
            const { show } = (await import(modulePath)) as typeof ImageLayoutRenderer;
            show(
              {
                ...block,
                id: '30000000-0000-4000-8000-000000000000',
                items: block.items.map((item) => ({ ...item, mediaId: undefined })),
              },
              document,
            );
          },
          { block, document },
        );
        await expect(page.locator('.point-card-media')).toHaveCount(0);
        await expect(page.locator('.point-cards-with-media')).toHaveCount(0);
      }
      expect(
        Math.max(...bounds.map((item) => item.cardHeight)) -
          Math.min(...bounds.map((item) => item.cardHeight)),
      ).toBeLessThan(1);
    }
  });
}
