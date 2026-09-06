import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DraftList } from '../../src/client/drafts/DraftList';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord } from '../../src/server/repositories/contracts';

function archivedDraft(): DraftRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    siteId: 'pointsite',
    name: 'Archived homepage refresh',
    status: 'archived',
    latestRevisionId: '20000000-0000-4000-8000-000000000001',
    document: defaultSiteDocument,
    revision: {
      id: '20000000-0000-4000-8000-000000000001',
      draftId: '10000000-0000-4000-8000-000000000001',
      sequence: 3,
      parentRevisionId: null,
      checksum: 'a'.repeat(64),
      document: defaultSiteDocument,
      label: null,
      schemaVersion: defaultSiteDocument.schemaVersion,
      rendererVersion: defaultSiteDocument.rendererVersion,
      createdBy: 'editor@pointatx.org',
      createdAt: '2026-09-06T12:00:00Z',
    },
    createdBy: 'editor@pointatx.org',
    createdAt: '2026-09-06T12:00:00Z',
    updatedAt: '2026-09-06T12:00:00Z',
    deletedAt: null,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof DraftList>> = {}) {
  const draft = archivedDraft();
  const props: React.ComponentProps<typeof DraftList> = {
    drafts: [draft],
    role: 'editor',
    onOpen: vi.fn(),
    onCreate: vi.fn(() => Promise.resolve()),
    onDuplicate: vi.fn(() => Promise.resolve()),
    onArchive: vi.fn(() => Promise.resolve()),
    onUnarchive: vi.fn(() => Promise.resolve()),
    onDelete: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  render(<DraftList {...props} />);
  return { draft, props };
}

describe('archived draft lifecycle controls', () => {
  it('keeps open and duplicate while replacing Archive with Unarchive and adding Delete', () => {
    const { draft, props } = renderList();
    const card = screen.getByRole('listitem');

    expect(within(card).getByRole('button', { name: 'Open editor' })).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Duplicate' })).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Unarchive' })).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Delete' })).toBeVisible();
    expect(within(card).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Unarchive' }));
    expect(props.onUnarchive).toHaveBeenCalledWith(draft);
  });

  it('requires exact case-sensitive DELETE before confirming deletion', async () => {
    const { draft, props } = renderList();
    const trigger = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Delete Archived homepage refresh?' });
    const confirmation = within(dialog).getByLabelText('Type DELETE to confirm');
    const submit = within(dialog).getByRole('button', { name: 'Delete draft' });
    expect(confirmation).toHaveFocus();
    expect(submit).toBeDisabled();

    fireEvent.change(confirmation, { target: { value: 'delete' } });
    expect(submit).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: 'DELETE' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith(draft));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('cancels without deleting and returns focus to the Delete trigger', () => {
    const { props } = renderList();
    const trigger = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('keeps the dialog open with an actionable error when deletion fails', async () => {
    renderList({ onDelete: vi.fn(() => Promise.reject(new Error('temporary failure'))) });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Archived homepage refresh?' });
    const confirmation = within(dialog).getByLabelText('Type DELETE to confirm');
    fireEvent.change(confirmation, { target: { value: 'DELETE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete draft' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'The draft could not be deleted. Nothing was removed. Try again.',
    );
    expect(dialog).toBeInTheDocument();
    expect(confirmation).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete draft' })).toBeEnabled();
  });

  it('closes on Escape without deleting', () => {
    const { props } = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Archived homepage refresh?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('does not expose mutation controls to viewers', () => {
    renderList({ role: 'viewer' });
    expect(screen.getByRole('button', { name: 'Open preview' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unarchive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
