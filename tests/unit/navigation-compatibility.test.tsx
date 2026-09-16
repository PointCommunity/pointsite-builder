import { render, screen } from '@testing-library/react';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { canonicalize } from '../../src/site-kit/canonicalize';
import { migrateDocument, upgradeNavigation } from '../../src/site-kit/migrations';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { renderBlock } from '../../src/site-kit/registry';
import { legacyNavigationDocument } from '../fixtures/legacy-navigation';

describe('Navigation compatibility reader', () => {
  it('activates migration on read without mutating the legacy input', () => {
    const legacy = legacyNavigationDocument();
    const before = canonicalize(legacy);
    const migrated = migrateDocument(legacy);
    expect(migrated.applied).toEqual(['9-to-10']);
    expect(migrated.document).toEqual(defaultSiteDocument);
    expect(canonicalize(legacy)).toBe(before);
  });

  it('explicitly upgrades every reference deterministically without changing placement or links', () => {
    const before = legacyNavigationDocument();
    const next = upgradeNavigation(before);
    expect(next.schemaVersion).toBe(10);
    expect(next.navigation).toEqual([]);
    expect(next.navigationDesigns).toHaveLength(1);
    expect(next.navigationDesigns?.[0].items).toEqual(before.navigation);
    for (const [pageIndex, page] of next.pages.entries()) {
      for (const [sectionIndex, section] of page.blocks.entries()) {
        for (const [itemIndex, item] of section.items.entries()) {
          const old = before.pages[pageIndex].blocks[sectionIndex].items[itemIndex];
          expect(item).toEqual(
            item.element.type === 'navigation'
              ? {
                  ...old,
                  element: { ...old.element, navigationDesignId: next.navigationDesigns?.[0].id },
                }
              : old,
          );
        }
      }
    }
    expect(before).toEqual(legacyNavigationDocument());
    expect(upgradeNavigation(before)).toEqual(next);
    expect(upgradeNavigation(next)).toEqual(next);
    expect(migrateDocument(next)).toEqual({ document: next, applied: [] });
  });

  it('renders selected designs independently and never falls back for a broken reference', () => {
    const document = upgradeNavigation(defaultSiteDocument);
    const first = document.navigationDesigns![0];
    const second = { ...structuredClone(first), id: crypto.randomUUID(), name: 'Footer menu' };
    second.items = [
      { id: crypto.randomUUID(), label: 'Second design', href: '/give', children: [] },
    ];
    document.navigationDesigns!.push(second);
    const block = document.pages[0].blocks[0].items.find(
      (item) => item.element.type === 'navigation',
    )!.element;
    if (block.type !== 'navigation') throw new Error('Expected navigation');
    const { rerender, container } = render(
      <>{renderBlock({ ...block, navigationDesignId: second.id }, document)}</>,
    );
    expect(screen.getByRole('link', { name: 'Second design' })).toHaveAttribute('href', '/give');
    expect(container.textContent).not.toContain('About');
    second.name = 'Renamed';
    second.items[0].label = 'Shared change';
    rerender(<>{renderBlock({ ...block, navigationDesignId: second.id }, document)}</>);
    expect(screen.getByRole('link', { name: 'Shared change' })).toBeInTheDocument();
    rerender(<>{renderBlock({ ...block, navigationDesignId: crypto.randomUUID() }, document)}</>);
    expect(container.querySelector('a')).toBeNull();
  });

  it('repairs legacy duplicate item identities deterministically while preserving visible links', () => {
    const legacy = legacyNavigationDocument();
    legacy.navigation[1].id = legacy.navigation[0].children[0].id;
    expect(SiteDocumentSchema.safeParse(legacy).success).toBe(true);
    const next = upgradeNavigation(legacy);
    expect(next).toEqual(upgradeNavigation(legacy));
    const items = next.navigationDesigns![0].items;
    expect(items[1].id).not.toBe(items[0].children[0].id);
    expect({ ...items[1], id: legacy.navigation[1].id }).toEqual(legacy.navigation[1]);
  });

  it.each([
    'missing',
    'duplicate-design',
    'duplicate-item',
    'grandchild',
    'unsafe-link',
    'legacy-shadow',
    'legacy-reference',
    'missing-designs',
  ])('rejects %s instead of accepting ambiguous or lossy navigation', (fault) => {
    const document = upgradeNavigation(defaultSiteDocument);
    const design = document.navigationDesigns![0];
    const block = document.pages[0].blocks[0].items.find(
      (item) => item.element.type === 'navigation',
    )!.element;
    if (block.type !== 'navigation') throw new Error('Expected navigation');
    if (fault === 'missing') block.navigationDesignId = crypto.randomUUID();
    if (fault === 'duplicate-design') document.navigationDesigns!.push(structuredClone(design));
    if (fault === 'duplicate-item') design.items[1].id = design.items[0].children[0].id;
    if (fault === 'grandchild') Object.assign(design.items[0].children[0], { children: [] });
    if (fault === 'unsafe-link') design.items[0].href = 'javascript:alert(1)';
    if (fault === 'legacy-shadow') document.navigation = legacyNavigationDocument().navigation;
    if (fault === 'legacy-reference') document.schemaVersion = 9;
    if (fault === 'missing-designs') delete document.navigationDesigns;
    expect(SiteDocumentSchema.safeParse(document).success).toBe(false);
  });
});
