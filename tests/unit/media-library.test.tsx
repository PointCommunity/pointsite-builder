import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MediaLibrary, type MediaClient } from '../../src/client/media/MediaLibrary';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { SiteDocument } from '../../src/site-kit/types';

it('loads an accessible empty library and uploads with required alt text', async () => {
  const upload = vi.fn(() =>
    Promise.resolve({
      id: '1',
      filename: 'point.png',
      displayName: 'Point',
      tags: [],
      contentType: 'image/png',
      byteSize: 24,
      width: 100,
      height: 80,
      altText: 'Point gathering',
      status: 'ready',
      createdAt: '2026-09-05T00:00:00Z',
    }),
  );
  const client: MediaClient = {
    list: () => Promise.resolve([]),
    upload,
    update: vi.fn(),
  };
  render(<MediaLibrary client={client} />);
  expect(await screen.findByText('No private uploads yet')).toBeVisible();
  const file = new File([new Uint8Array([1])], 'point.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Image file'), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText('Alternative text'), {
    target: { value: 'Point gathering' },
  });
  const form = screen.getByRole('button', { name: 'Upload image' }).closest('form');
  if (!form) throw new Error('Upload form is missing');
  fireEvent.submit(form);
  await waitFor(() => expect(upload).toHaveBeenCalledWith(file, 'Point gathering'));
  expect(await screen.findByText(/point\.png/)).toBeVisible();
});

it('shows every managed site image and preserves its stable reference while editing metadata', async () => {
  const document = structuredClone(defaultSiteDocument);
  const onDocumentChange = vi.fn<(next: SiteDocument) => void>();
  const client: MediaClient = {
    list: () => Promise.resolve([]),
    upload: vi.fn(),
    update: vi.fn(),
  };

  render(<MediaLibrary client={client} document={document} onDocumentChange={onDocumentChange} />);

  expect(await screen.findByText('19 site images')).toBeVisible();
  expect(screen.getAllByRole('img')).toHaveLength(19);
  expect(screen.queryByText('No uploaded images yet')).not.toBeInTheDocument();

  const skyline = document.media.find((item) => item.sourcePath === '/assets/austin-skyline.jpeg');
  if (!skyline) throw new Error('Skyline fixture is missing');

  const displayName = screen.getByLabelText(
    'Display name for Austin skyline over the Colorado River',
  );
  fireEvent.change(displayName, { target: { value: 'Austin skyline hero' } });
  const editor = displayName.closest('form');
  if (!editor) throw new Error('Site image metadata editor is missing');
  fireEvent.submit(editor);

  expect(onDocumentChange).toHaveBeenCalledTimes(1);
  const updated = onDocumentChange.mock.calls[0]?.[0];
  const updatedSkyline = updated.media.find((item: { id: string }) => item.id === skyline.id);
  expect(updatedSkyline).toMatchObject({
    id: skyline.id,
    sourcePath: skyline.sourcePath,
    displayName: 'Austin skyline hero',
  });
});
