import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RevisionHistory } from '../../src/client/revisions/RevisionHistory';
import { api } from '../../src/client/api';
import type { RevisionSummary } from '../../src/server/repositories/contracts';

vi.mock('../../src/client/api', () => ({ api: { listRevisions: vi.fn() } }));
vi.mock('../../src/client/editor/EditorProvider', () => ({
  useEditor: () => ({ draft: { id: 'draft', revision: { id: 'current' } } }),
}));

function summary(sequence: number, label: string): RevisionSummary {
  return {
    id: String(sequence),
    draftId: 'draft',
    sequence,
    parentRevisionId: null,
    checksum: 'a'.repeat(64),
    label,
    schemaVersion: 9,
    rendererVersion: 'test',
    createdAt: '2026-09-12T12:00:00Z',
    createdBy: 'editor@pointatx.org',
    actionCategory: null,
    actionContext: null,
  };
}

beforeEach(() => vi.mocked(api.listRevisions).mockReset());

it('ignores a delayed older page after a new search and sends retained-history filters', async () => {
  let resolveOlder!: (value: Awaited<ReturnType<typeof api.listRevisions>>) => void;
  const older = new Promise<Awaited<ReturnType<typeof api.listRevisions>>>((resolve) => {
    resolveOlder = resolve;
  });
  const list = vi.mocked(api.listRevisions).mockImplementation((_id, options) => {
    if (options?.cursor) return older;
    if (options?.query)
      return Promise.resolve({ items: [summary(1, 'Oldest named match')], nextCursor: null });
    return Promise.resolve({ items: [summary(201, 'Newest page')], nextCursor: '102' });
  });
  render(<RevisionHistory editable={false} />);
  await screen.findByText('Newest page');
  fireEvent.click(screen.getByRole('button', { name: 'Load older revisions' }));
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith('draft', expect.objectContaining({ cursor: '102' })),
  );
  const oldSignal = list.mock.calls.at(-1)![1]!.signal!;
  fireEvent.change(screen.getByLabelText('Find a revision'), { target: { value: 'Oldest' } });
  fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'named' } });
  await screen.findByText('Oldest named match');
  expect(oldSignal.aborted).toBe(true);
  expect(list).toHaveBeenLastCalledWith(
    'draft',
    expect.objectContaining({ query: 'Oldest', filter: 'named' }),
  );
  await act(async () => {
    resolveOlder({ items: [summary(100, 'Oldest stale page')], nextCursor: '1' });
    await older;
  });
  expect(screen.queryByText('Oldest stale page')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load older revisions' })).not.toBeInTheDocument();
});

it('preserves loaded rows and allows retry when an older page fails', async () => {
  vi.mocked(api.listRevisions)
    .mockResolvedValueOnce({ items: [summary(101, 'First page')], nextCursor: '2' })
    .mockRejectedValueOnce(new Error('Network unavailable'))
    .mockResolvedValueOnce({ items: [summary(1, 'Oldest page')], nextCursor: null });
  render(<RevisionHistory editable={false} />);
  await screen.findByText('First page');
  fireEvent.click(screen.getByRole('button', { name: 'Load older revisions' }));
  await screen.findByRole('alert');
  expect(screen.getByText('First page')).toBeVisible();
  screen.getByRole('button', { name: 'Load older revisions' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Load older revisions' }));
  await screen.findByText('Oldest page');
  await waitFor(() => expect(screen.getByText('Oldest page').closest('li')).toHaveFocus());
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
