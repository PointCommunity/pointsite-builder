import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { EditorProvider, useEditor } from '../../src/client/editor/EditorProvider';
import { availableRoute, PageManager } from '../../src/client/editor/PageManager';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord } from '../../src/server/repositories/contracts';

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
    </>
  );
}

describe('page management', () => {
  it('creates canonical, unique routes without technical input', () => {
    expect(availableRoute('Plan Your Visit!', ['/plan-your-visit'])).toBe('/plan-your-visit-2');
    expect(availableRoute('Niños & Families', [])).toBe('/ninos-families');
    expect(availableRoute('', ['/page', '/page-2'])).toBe('/page-3');
  });

  it('creates a standard page with an editable Hero and no duplicate visual fields', () => {
    render(
      <EditorProvider initialDraft={draft()}>
        <Harness />
      </EditorProvider>,
    );

    fireEvent.click(screen.getByText('Page details', { exact: true }));
    expect(screen.queryByLabelText('Page eyebrow')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Page introduction')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Page hero image')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const page = JSON.parse(screen.getByTestId('selected-page').textContent ?? '{}') as {
      blocks: Array<{
        name: string;
        items: Array<{ element: { type: string; variant?: string } }>;
      }>;
    };

    expect(page.blocks[0]).toMatchObject({
      name: 'Page hero',
      items: [{ element: { type: 'hero', variant: 'pageHero' } }],
    });
    expect(page.blocks[1]).toMatchObject({ name: 'Site header' });
  });
});
