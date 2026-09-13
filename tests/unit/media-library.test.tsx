import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MediaLibrary, type MediaClient } from '../../src/client/media/MediaLibrary';
import type {
  LibraryItem,
  LibraryMutationContext,
  LibraryMutationResult,
  LibrarySnapshot,
} from '../../src/shared/library';

const revokeObjectURL = vi.fn();
beforeEach(() => {
  revokeObjectURL.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:proposed-image');
  URL.revokeObjectURL = revokeObjectURL;
});

const image: LibraryItem = {
  id: 'image',
  mediaType: 'image',
  sourceType: 'managed',
  displayName: 'Skyline',
  filename: 'skyline.png',
  sourcePath: '/assets/skyline.png',
  url: '/assets/skyline.png',
  altText: 'Austin skyline',
  tags: ['City'],
  createdAt: '2026-09-01',
  updatedAt: '2026-09-02',
  archivedAt: null,
  usageCount: 1,
  deleteBlockers: [],
};
const video: LibraryItem = {
  ...image,
  id: 'video',
  mediaType: 'youtube',
  sourceType: 'linked',
  displayName: 'Sunday video',
  filename: '',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  usageCount: 0,
};
const archived: LibraryItem = {
  ...image,
  id: 'archived',
  displayName: 'Old image',
  archivedAt: '2026-09-03',
  deleteBlockers: ['A retained revision uses this image.'],
};
const snapshot = (items = [image, video, archived]): LibrarySnapshot => ({
  draftId: 'draft',
  revisionChecksum: 'checksum',
  revisionId: 'revision',
  items,
  activeCount: items.filter((item) => !item.archivedAt).length,
  archivedCount: items.filter((item) => item.archivedAt).length,
});

function setup(items?: LibraryItem[], editable = true) {
  const client: MediaClient = {
    list: vi.fn().mockResolvedValue(snapshot(items)),
    upload: vi.fn(),
    addLink: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    replace: vi.fn(),
  };
  const runMutation = vi.fn(
    async (operation: (context: LibraryMutationContext) => Promise<LibraryMutationResult>) =>
      (
        await operation({
          draftId: 'draft',
          expectedChecksum: 'checksum',
          expectedRevisionId: 'revision',
          checkoutToken: 'checkout',
          idempotencyKey: 'operation',
        })
      ).library,
  );
  render(
    <MediaLibrary
      draftId="draft"
      revisionChecksum="checksum"
      revisionId="revision"
      editable={editable}
      client={client}
      runMutation={runMutation}
    />,
  );
  return { client, runMutation };
}

it('shows one mixed inventory with image-only replacement and read-only Viewer access', async () => {
  setup(undefined, false);
  expect(await screen.findByRole('heading', { name: 'Skyline' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Sunday video' })).toBeVisible();
  expect(screen.getByText(/Viewer access is read only/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Replace image' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use in Layout' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete permanently' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Archived items (1)' }));
  expect(await screen.findByRole('heading', { name: 'Old image' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Unarchive' })).not.toBeInTheDocument();
});

it('preserves linked types and provides archived navigation and blockers', async () => {
  const { client } = setup();
  await screen.findByRole('heading', { name: 'Skyline' });
  expect(screen.getAllByRole('button', { name: 'Replace image' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Archived items (1)' }));
  expect(screen.getByText('A retained revision uses this image.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
  client.update = vi
    .fn()
    .mockResolvedValue({ library: snapshot([image, video, { ...archived, archivedAt: null }]) });
  fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
  await waitFor(() =>
    expect(client.update).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft' }),
      'archived',
      'unarchive',
    ),
  );
  expect(await screen.findByText('No archived items')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Library' }));
  expect(screen.getByRole('heading', { name: 'Old image' })).toBeVisible();
});

it('requires a final Yes for archived deletion and restores focus on cancel', async () => {
  const { client } = setup([{ ...archived, deleteBlockers: [] }]);
  await screen.findByRole('button', { name: 'Archived items (1)' });
  fireEvent.click(screen.getByRole('button', { name: 'Archived items (1)' }));
  const trigger = screen.getByRole('button', { name: 'Delete permanently' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Delete Old image?' });
  expect(within(dialog).getByText(/cannot be undone/)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(trigger).toHaveFocus();
  expect(client.delete).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  client.delete = vi.fn().mockResolvedValue({ library: snapshot([]) });
  fireEvent.click(screen.getByRole('button', { name: 'Yes, delete permanently' }));
  await waitFor(() => expect(client.delete).toHaveBeenCalledOnce());
  expect(await screen.findByText('No archived items')).toBeVisible();
});

it('composes keyword, sorting and reset with useful result counts', async () => {
  setup();
  await screen.findByRole('heading', { name: 'Skyline' });
  expect(
    screen.getByRole('combobox', { name: 'Sort Library' }).querySelectorAll('option'),
  ).toHaveLength(8);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Library' }), {
    target: { value: ' absent ' },
  });
  expect(screen.getByText('No matching items')).toBeVisible();
  expect(screen.getByText('0 of 2 items')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.getByRole('heading', { name: 'Skyline' })).toBeVisible();
});

it('keeps server rejection visible and does not remove the item', async () => {
  const { client } = setup();
  await screen.findByRole('heading', { name: 'Skyline' });
  client.update = vi.fn().mockRejectedValue(new Error('Checkout expired. Reopen this draft.'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0]);
  expect(await screen.findByRole('alert')).toHaveTextContent('Checkout expired');
  expect(screen.getByRole('heading', { name: 'Skyline' })).toBeVisible();
});

const imageFile = () =>
  new File(
    [
      Uint8Array.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
      ]),
    ],
    'new.png',
    { type: 'image/png' },
  );

it('preserves the validated filename when alternative text changes in the same render batch', async () => {
  setup([]);
  await screen.findByText('Your Library is empty');
  fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
  const dialog = screen.getByRole('dialog', { name: 'Upload image' });
  const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(() => {});
  try {
    fireEvent.change(within(dialog).getByLabelText('Image file'), {
      target: { files: [imageFile()] },
    });
    const reader = read.mock.contexts[0] as FileReader;
    await act(async () => {
      Object.defineProperty(reader, 'result', {
        value: Uint8Array.from([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
        ]).buffer,
      });
      reader.dispatchEvent(new Event('load'));
      await Promise.resolve();
      fireEvent.change(within(dialog).getByLabelText('Alternative text'), {
        target: { value: 'People gathering' },
      });
    });
    fireEvent.load(await within(dialog).findByRole('img'));
    expect(within(dialog).getByRole('button', { name: 'Upload image' })).toBeEnabled();
  } finally {
    read.mockRestore();
  }
});

it('adds a validated upload once immediately without placement controls', async () => {
  const { client } = setup([]);
  await screen.findByText('Your Library is empty');
  fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
  const dialog = screen.getByRole('dialog', { name: 'Upload image' });
  const file = imageFile();
  fireEvent.change(within(dialog).getByLabelText('Image file'), { target: { files: [file] } });
  const preview = await within(dialog).findByRole('img', { name: 'Proposed image preview' });
  fireEvent.load(preview);
  fireEvent.change(within(dialog).getByLabelText('Alternative text'), {
    target: { value: 'New image description' },
  });
  client.upload = vi.fn().mockResolvedValue({ library: snapshot([image]) });
  fireEvent.submit(within(dialog).getByRole('button', { name: 'Upload image' }).closest('form')!);
  await waitFor(() =>
    expect(client.upload).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft' }),
      file,
      'New image description',
    ),
  );
  expect(await screen.findAllByRole('heading', { name: 'Skyline' })).toHaveLength(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:proposed-image');
});

it('requires valid bytes, decoded preview, fresh alt text, and final confirmation for replacement', async () => {
  const { client } = setup([image]);
  await screen.findByRole('heading', { name: 'Skyline' });
  fireEvent.click(screen.getByRole('button', { name: 'Replace image' }));
  const dialog = screen.getByRole('dialog');
  const alternativeText = within(dialog).getByLabelText(
    'Alternative text or accessible description',
  );
  expect(alternativeText).toHaveValue('');
  fireEvent.change(within(dialog).getByLabelText('Image file'), {
    target: { files: [new File(['bad bytes'], 'wrong.png', { type: 'image/png' })] },
  });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('PNG signature is invalid');
  expect(within(dialog).getByRole('button', { name: 'Review replacement' })).toBeDisabled();
  const file = imageFile();
  fireEvent.change(within(dialog).getByLabelText('Image file'), { target: { files: [file] } });
  const preview = await within(dialog).findByRole('img');
  fireEvent.change(alternativeText, { target: { value: 'New skyline at sunset' } });
  expect(within(dialog).getByRole('button', { name: 'Review replacement' })).toBeDisabled();
  fireEvent.load(preview);
  fireEvent.submit(
    within(dialog).getByRole('button', { name: 'Review replacement' }).closest('form')!,
  );
  expect(screen.getByRole('dialog', { name: 'Replace Skyline?' })).toBeVisible();
  expect(client.replace).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Tab', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Yes, replace image' })).toHaveFocus();
  client.replace = vi
    .fn()
    .mockResolvedValue({ library: snapshot([{ ...image, altText: 'New skyline at sunset' }]) });
  fireEvent.click(screen.getByRole('button', { name: 'Yes, replace image' }));
  await waitFor(() =>
    expect(client.replace).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft' }),
      'image',
      file,
      { displayName: 'Skyline', altText: 'New skyline at sunset', tags: ['City'] },
    ),
  );
});

it('rejects a preview decoding error and allows replacement cancellation without storage changes', async () => {
  const { client } = setup([image]);
  await screen.findByRole('heading', { name: 'Skyline' });
  fireEvent.click(screen.getByRole('button', { name: 'Replace image' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Image file'), {
    target: { files: [imageFile()] },
  });
  fireEvent.error(await within(dialog).findByRole('img'));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('could not be decoded');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(client.replace).not.toHaveBeenCalled();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:proposed-image');
});

it('validates linked-media type and saves trimmed metadata in the unified inventory', async () => {
  const { client } = setup([]);
  await screen.findByText('Your Library is empty');
  fireEvent.click(screen.getByRole('button', { name: 'Add linked media' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Media type'), { target: { value: 'youtube' } });
  fireEvent.change(within(dialog).getByLabelText('HTTPS URL'), {
    target: { value: 'https://example.com/wrong' },
  });
  fireEvent.change(within(dialog).getByLabelText('Display name'), {
    target: { value: '  Sunday video  ' },
  });
  fireEvent.change(within(dialog).getByLabelText('Alternative text or accessible description'), {
    target: { value: '  Sunday message  ' },
  });
  fireEvent.change(within(dialog).getByLabelText('Tags (comma separated)'), {
    target: { value: ' Message , Sunday, Message ' },
  });
  const form = within(dialog).getByRole('button', { name: 'Add linked media' }).closest('form')!;
  fireEvent.submit(form);
  expect(within(dialog).getByRole('alert')).toHaveTextContent('matching the selected type');
  expect(client.addLink).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText('HTTPS URL'), { target: { value: video.url } });
  client.addLink = vi.fn().mockResolvedValue({ library: snapshot([video]) });
  fireEvent.submit(form);
  await waitFor(() =>
    expect(client.addLink).toHaveBeenCalledWith(expect.anything(), {
      displayName: 'Sunday video',
      altText: 'Sunday message',
      tags: ['Message', 'Sunday'],
      mediaType: 'youtube',
      url: video.url,
    }),
  );
  expect(await screen.findByRole('heading', { name: 'Sunday video' })).toBeVisible();
});

it('never displays another draft inventory during navigation or from a mismatched response', async () => {
  const client: MediaClient = {
    list: vi.fn().mockResolvedValue(snapshot()),
    upload: vi.fn(),
    addLink: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    replace: vi.fn(),
  };
  const { rerender } = render(
    <MediaLibrary
      draftId="draft"
      revisionChecksum="checksum"
      revisionId="revision"
      client={client}
      runMutation={vi.fn()}
    />,
  );
  await screen.findByRole('heading', { name: 'Skyline' });
  client.list = vi.fn().mockResolvedValue(snapshot());
  rerender(
    <MediaLibrary
      draftId="other-draft"
      revisionChecksum="checksum"
      revisionId="revision"
      client={client}
      runMutation={vi.fn()}
    />,
  );
  expect(screen.queryByRole('heading', { name: 'Skyline' })).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByRole('heading', { name: 'Skyline' })).not.toBeInTheDocument();
});
