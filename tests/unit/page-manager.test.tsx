import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../src/client/api';
import { EditorProvider, useEditor } from '../../src/client/editor/EditorProvider';
import { availableRoute, PageManager } from '../../src/client/editor/PageManager';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import type { DraftRecord } from '../../src/server/repositories/contracts';
import type { SiteDocument } from '../../src/site-kit/types';

function draft(): DraftRecord {
  const document = structuredClone(defaultSiteDocument);
  return {
    id: '10000000-0000-4000-8000-000000000001',
    siteId: 'pointsite',
    name: 'Page manager test',
    status: 'active',
    latestRevisionId: '20000000-0000-4000-8000-000000000001',
    document,
    revision: {
      id: '20000000-0000-4000-8000-000000000001',
      draftId: '10000000-0000-4000-8000-000000000001',
      sequence: 1,
      parentRevisionId: null,
      checksum: 'initial-checksum',
      document,
      label: null,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: 'editor@pointatx.org',
      createdAt: '2026-09-05T00:00:00.000Z',
      actionCategory: null,
      actionContext: null,
    },
    createdBy: 'editor@pointatx.org',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    deletedAt: null,
  };
}

function Harness() {
  const { document } = useEditor();
  const [pageId, setPageId] = useState(document.pages[0]?.id ?? '');
  const page = document.pages.find((candidate) => candidate.id === pageId);
  return (
    <>
      <PageManager pageId={pageId} onPageIdChange={setPageId} />
      <output data-testid="selected-page">{JSON.stringify(page)}</output>
      <output data-testid="document-errors">
        {JSON.stringify(SiteDocumentSchema.safeParse(document).error?.issues ?? [])}
      </output>
    </>
  );
}

describe('page management', () => {
  it('creates canonical, unique routes without technical input', () => {
    expect(availableRoute('Plan Your Visit!', ['/plan-your-visit'])).toBe('/plan-your-visit-2');
    expect(availableRoute('Niños & Families', [])).toBe('/ninos-families');
    expect(availableRoute('', ['/page', '/page-2'])).toBe('/page-3');
  });

  it('creates a standard page with a neutral editable Hero and inherited header logo', async () => {
    const initialDraft = draft();
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue(initialDraft);
    render(
      <EditorProvider initialDraft={initialDraft}>
        <Harness />
      </EditorProvider>,
    );

    fireEvent.click(screen.getByText('Page details', { exact: true }));
    expect(screen.queryByLabelText('Page eyebrow')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Page introduction')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Page hero image')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const page = JSON.parse(
      screen.getByTestId('selected-page').textContent ?? '{}',
    ) as SiteDocument['pages'][number];

    expect(page.blocks[0]).toMatchObject({
      name: 'Page hero',
      layout: 'grid',
      items: [{ element: { type: 'composition', name: 'Page hero' } }],
    });
    expect(page.blocks[1]).toMatchObject({ name: 'Site header' });
    expect(screen.getByTestId('document-errors')).toHaveTextContent('[]');
    const existingHeader = initialDraft.document.pages
      .flatMap((item) => item.blocks)
      .find((section) => section.items.some(({ element }) => element.type === 'navigation'));
    const existingLogo = existingHeader?.items.find(({ element }) => element.type === 'image');
    expect(
      page.blocks[1].items.find(({ element }) => element.type === 'image')?.element,
    ).toMatchObject({
      mediaId: existingLogo?.element.type === 'image' ? existingLogo.element.mediaId : undefined,
      alt: initialDraft.document.site.name,
    });
    expect(
      page.blocks[1].items.find(({ element }) => element.type === 'navigation')?.element,
    ).toMatchObject({
      navigationDesignId: initialDraft.document.navigationDesigns?.[0]?.id,
    });
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    save.mockRestore();
  });

  it('gives duplicated composition children fresh editor IDs', () => {
    const initialDraft = draft();
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue(initialDraft);
    render(
      <EditorProvider initialDraft={initialDraft}>
        <Harness />
      </EditorProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const source = JSON.parse(
      screen.getByTestId('selected-page').textContent ?? '{}',
    ) as SiteDocument['pages'][number];
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    const copy = JSON.parse(
      screen.getByTestId('selected-page').textContent ?? '{}',
    ) as SiteDocument['pages'][number];
    const childIds = (page: SiteDocument['pages'][number]) =>
      page.blocks.flatMap((section) =>
        section.items.flatMap((placement) =>
          placement.element.type === 'composition'
            ? placement.element.items.flatMap((item) => [item.id, item.element.id])
            : [],
        ),
      );
    expect(childIds(source).length).toBeGreaterThan(0);
    expect(childIds(copy)).not.toEqual(childIds(source));
    expect(childIds(copy).some((id) => childIds(source).includes(id))).toBe(false);
    save.mockRestore();
  });
});
