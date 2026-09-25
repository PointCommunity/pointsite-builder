import { expect, test } from '@playwright/test';

test('an independent grid image reserves text space on either side', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div class="point-site">
      <section class="point-layout-section point-layout-section--grid point-layout-section--site">
        <div class="point-layout-section__grid" style="width:min(852px,100%);--point-grid-cell:60px;--point-section-gap:12px;--point-section-total-gap:132px;">
          <div class="point-layout-item point-layout-item--grid point-layout-item--text-wrap" style="--point-grid-desktop-column:1;--point-grid-desktop-column-span:12;--point-grid-desktop-row:1;--point-grid-desktop-row-span:8;--point-grid-tablet-column:1;--point-grid-tablet-column-span:12;--point-grid-tablet-row:1;--point-grid-tablet-row-span:8;--point-wrap-desktop-side:left;--point-wrap-desktop-width:calc(33.333333% - 0.666667 * var(--point-section-gap));--point-wrap-desktop-rows:4;--point-wrap-tablet-side:right;--point-wrap-tablet-width:calc(33.333333% - 0.666667 * var(--point-section-gap));--point-wrap-tablet-rows:4;">
            <p class="point-text">${'Words wrap beside this photo. '.repeat(50)}</p>
          </div>
          <div class="point-layout-item point-layout-item--grid" style="--point-grid-desktop-column:1;--point-grid-desktop-column-span:4;--point-grid-desktop-row:1;--point-grid-desktop-row-span:4;--point-grid-tablet-column:9;--point-grid-tablet-column-span:4;--point-grid-tablet-row:1;--point-grid-tablet-row-span:4;"><div class="point-image"></div></div>
        </div>
      </section>
    </div>
  `);
  await page.addStyleTag({ path: 'src/site-kit/site.css' });

  const measure = () =>
    page.locator('.point-text').evaluate((text) => {
      const pseudo = getComputedStyle(text, '::before');
      const first = document.createRange();
      first.setStart(text.firstChild!, 0);
      first.setEnd(text.firstChild!, 1);
      return {
        float: pseudo.float,
        width: Number.parseFloat(pseudo.width),
        height: Number.parseFloat(pseudo.height),
        imageWidth: document.querySelector('.point-image')!.parentElement!.getBoundingClientRect()
          .width,
        firstX: first.getBoundingClientRect().x,
        textLeft: text.getBoundingClientRect().left,
      };
    });

  const desktop = await measure();
  expect(desktop.float).toBe('left');
  expect(Math.abs(desktop.width - desktop.imageWidth)).toBeLessThan(1);
  expect(desktop.height).toBe(276);
  expect(desktop.firstX).toBeGreaterThan(desktop.textLeft + desktop.imageWidth - 1);

  await page.setViewportSize({ width: 800, height: 900 });
  const tablet = await measure();
  expect(tablet.float).toBe('right');
  expect(Math.abs(tablet.width - tablet.imageWidth)).toBeLessThan(1);
  expect(tablet.firstX).toBeLessThan(tablet.textLeft + 10);

  await page.setViewportSize({ width: 600, height: 900 });
  const zoomEquivalent = await measure();
  expect(Math.abs(zoomEquivalent.width - zoomEquivalent.imageWidth)).toBeLessThan(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await measure();
  expect(mobile.float).toBe('none');
  expect(mobile.firstX).toBeLessThan(mobile.textLeft + 10);
});

test('mobile wrap matches compressed grid tracks rather than the minimum row size', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div class="point-site">
      <section class="point-layout-section point-layout-section--grid point-layout-section--site">
        <div class="point-layout-section__grid" style="--point-section-gap:12px;--point-section-total-gap:132px;">
          <div class="point-layout-item point-layout-item--grid point-layout-item--text-wrap" style="--point-grid-mobile-column:1;--point-grid-mobile-column-span:12;--point-grid-mobile-row:1;--point-grid-mobile-row-span:8;--point-wrap-mobile-side:left;--point-wrap-mobile-width:calc(33.333333% - 0.666667 * var(--point-section-gap));--point-wrap-mobile-rows:4;"><p class="point-text">${'Words beside a mobile photo. '.repeat(30)}</p></div>
          <div class="point-layout-item point-layout-item--grid" style="--point-grid-mobile-column:1;--point-grid-mobile-column-span:4;--point-grid-mobile-row:1;--point-grid-mobile-row-span:4;"><div class="point-image"></div></div>
        </div>
      </section>
    </div>
  `);
  await page.addStyleTag({ path: 'src/site-kit/site.css' });
  const dimensions = await page.locator('.point-text').evaluate((text) => ({
    float: getComputedStyle(text, '::before').float,
    reservedWidth: Number.parseFloat(getComputedStyle(text, '::before').width),
    imageWidth: document.querySelector('.point-image')!.parentElement!.getBoundingClientRect()
      .width,
  }));
  expect(dimensions.float).toBe('left');
  expect(Math.abs(dimensions.reservedWidth - dimensions.imageWidth)).toBeLessThan(1);
});
