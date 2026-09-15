import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../../src/client/api';
import { DraftList } from '../../src/client/drafts/DraftList';

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => vi.restoreAllMocks());

it('previews selected publication, cancels without a draft, and confirms the exact identity', async () => {
  const source = {
    sourceCommit: 'a'.repeat(40),
    deploymentId: '123',
    artifactDigest: 'b'.repeat(64),
    candidateChecksum: 'c'.repeat(64),
  };
  vi.spyOn(api, 'previewDraftSource').mockResolvedValue(source);
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <DraftList
      drafts={[]}
      role="editor"
      onOpen={vi.fn()}
      onCreate={onCreate}
      onDuplicate={vi.fn()}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('New draft name'), { target: { value: 'Spring' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
  expect(onCreate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Copy published site from'), {
    target: { value: 'staging' },
  });
  await waitFor(() => expect(api.previewDraftSource).toHaveBeenCalledWith('staging'));
  await screen.findByText(/Staging publication verified/);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCreate).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create draft' })).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
  fireEvent.change(screen.getByLabelText('Copy published site from'), {
    target: { value: 'production' },
  });
  await screen.findByText(/Production publication verified/);
  fireEvent.click(screen.getByRole('button', { name: 'Create independent draft' }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Spring', 'production', source));
});

it('allows refreshing a stale source identity before creating', async () => {
  const source = {
    sourceCommit: 'a'.repeat(40),
    deploymentId: '123',
    artifactDigest: 'b'.repeat(64),
  };
  const refreshed = { ...source, deploymentId: '124' };
  vi.spyOn(api, 'previewDraftSource')
    .mockResolvedValueOnce(source)
    .mockResolvedValueOnce(refreshed);
  const onCreate = vi
    .fn()
    .mockRejectedValueOnce(new Error('Selected publication changed'))
    .mockResolvedValueOnce(undefined);
  render(
    <DraftList
      drafts={[]}
      role="editor"
      onOpen={vi.fn()}
      onCreate={onCreate}
      onDuplicate={vi.fn()}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('New draft name'), { target: { value: 'Summer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
  fireEvent.change(screen.getByLabelText('Copy published site from'), {
    target: { value: 'staging' },
  });
  await screen.findByText(/Staging publication verified/);
  fireEvent.click(screen.getByRole('button', { name: 'Create independent draft' }));
  await screen.findByRole('button', { name: 'Refresh source' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }));
  await waitFor(() => expect(api.previewDraftSource).toHaveBeenCalledTimes(2));
  await screen.findByText(/Staging publication verified/);
  fireEvent.click(screen.getByRole('button', { name: 'Create independent draft' }));
  await waitFor(() => expect(onCreate).toHaveBeenLastCalledWith('Summer', 'staging', refreshed));
});
